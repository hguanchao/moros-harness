import { randomUUID } from "node:crypto";
import { basename, join } from "node:path";

import { Notification, dialog, shell, type BrowserWindow } from "electron";

import {
	Core,
	MAX_IMAGE_BYTES_PER_REQUEST,
	MAX_IMAGES_PER_REQUEST,
	SessionBusyError,
	approvalScope,
	assertWorkspaceRoot,
	createApprovalBroker,
	formatImageBytes,
	listDirectory,
	watchWorkspace,
	type ApprovalBroker,
	type ApprovalDecision,
	type ApprovalMode,
	type ApprovalRequest,
	type FileChangeDiff,
	type McpStatus,
	type ModelCatalog,
	type ProviderDraft,
	type ReasoningEffort,
	type Session,
	type SessionExportResult,
	type SessionImageInput,
	type SessionMeta,
	type SessionMetrics,
	type SettingsPatch,
	type SettingsSnapshot,
	type SkillSummary,
	type WorkspaceEntry,
	type WorkspaceWatch,
} from "#src/core/index.ts";
import type { EventRecord } from "#src/core/events/schema.ts";
import { normalizeProjectRoot } from "#src/core/session/project-dir.ts";
import { VERSION } from "#src/core/version.ts";
import {
	type AppSnapshot,
	type ApprovalCard,
	type ChatLiveResult,
	type ChatSendInput,
	type ChatSendResult,
	type CheckpointView,
	type ConfigSummary,
	type FileChangeSummary,
	type LiveState,
	type PreparedImage,
	type ProjectSnapshot,
	type PushMessage,
	type QueuedMessage,
	type ReviewResult,
	type SessionListQuery,
	type SessionPage,
	type SessionView,
	type TraceTurn,
	type WorkspaceTrustView,
} from "#src/desktop/shared/contract.ts";
import { DesktopStore } from "#src/desktop/main/store.ts";
import { buildTrace } from "#src/desktop/main/trace.ts";

interface ActiveRun {
	readonly runId: string;
	readonly sessionId: string;
	readonly controller: AbortController;
	readonly startedAt: number;
	paused: boolean;
}

interface QueuedEntry {
	readonly id: string;
	readonly sessionId: string;
	readonly text: string;
	readonly images: readonly SessionImageInput[];
}

interface MutableLive {
	running: boolean;
	paused: boolean;
	runId: string | undefined;
	text: string;
	reasoning: string;
	readonly toolOutputs: Map<string, string>;
	startedAt: number | undefined;
}

interface PendingStream {
	readonly sessionId: string;
	readonly runId: string;
	readonly kind: "text" | "reasoning" | "tool";
	readonly toolCallId?: string;
	text: string;
	timer?: NodeJS.Timeout;
}

const MAX_QUEUE = 20;
const STREAM_FLUSH_MS = 40;
const MAX_PREPARED_IMAGES = 32;
const PREPARED_IMAGE_TTL_MS = 30 * 60 * 1_000;
const MAX_WARNINGS = 50;
const MAX_PREVIEW_CHARS = 24_000;

export interface DesktopHostOptions {
	readonly userDataDir: string;
	readonly getWindow: () => BrowserWindow | undefined;
	readonly push: (message: PushMessage) => void;
	/** 测试注入；缺省使用真实 Core。 */
	readonly homeDir?: string;
}

/**
 * 桌面端的主进程宿主：持有 Core、当前项目/会话、运行队列与审批队列。
 *
 * 渲染进程只能经 IPC 触达这里的方法；所有权限、沙箱、路径校验仍在 Core。
 * 一个窗口同一时刻只跑一轮对话，切换会话不会中止后台轮次；发送行为按队列串行。
 */
export class DesktopHost {
	readonly #store: DesktopStore;
	readonly #getWindow: () => BrowserWindow | undefined;
	readonly #pushMessage: (message: PushMessage) => void;
	readonly #homeDir: string | undefined;
	readonly #broker: ApprovalBroker = createApprovalBroker({ timeoutMs: 120_000 });

	#core: Core | undefined;
	#projectRoot: string | undefined;
	#current: Session | undefined;
	#sessions = new Map<string, Session>();
	#subscriptions = new Map<string, () => void>();
	#createdSessionIds = new Set<string>();
	#readOnlyIds = new Set<string>();
	#metas: SessionMeta[] = [];
	#catalog: ModelCatalog = { providers: [] };
	#warnings: string[] = [];

	#watcher: WorkspaceWatch | undefined;
	#activeRun: ActiveRun | undefined;
	#activeRunPromise: Promise<void> | undefined;
	#queue: QueuedEntry[] = [];
	#live = new Map<string, MutableLive>();
	#streams = new Map<string, PendingStream>();
	#preparedImages = new Map<string, { image: SessionImageInput; preview: PreparedImage; createdAt: number }>();
	#viewVersion = 0;
	#reviewing = false;
	#startingRun = false;
	#disposed = false;

	private constructor(store: DesktopStore, options: DesktopHostOptions) {
		this.#store = store;
		this.#getWindow = options.getWindow;
		this.#pushMessage = options.push;
		this.#homeDir = options.homeDir;
	}

	static async create(options: DesktopHostOptions): Promise<DesktopHost> {
		const store = await DesktopStore.open(options.userDataDir);
		return new DesktopHost(store, options);
	}

	async rememberWindow(
		bounds: { x: number; y: number; width: number; height: number } | undefined,
		maximized: boolean,
	): Promise<void> {
		await this.#store.rememberWindow(bounds, maximized);
	}

	windowBounds(): { x: number; y: number; width: number; height: number } | undefined {
		return this.#store.windowBounds();
	}

	windowMaximized(): boolean {
		return this.#store.isMaximized();
	}

	async initialize(): Promise<AppSnapshot> {
		const recent = this.#store.recentProjects();
		const last = recent[0];
		let project: ProjectSnapshot | undefined;
		if (last !== undefined) {
			try {
				project = await this.openProject(last.root);
			} catch (error) {
				this.#notice("warn", `Could not reopen ${last.root}: ${messageOf(error)}`);
			}
		}
		return {
			version: VERSION,
			platform: process.platform,
			recentProjects: this.#store.recentProjects(),
			...(project === undefined ? {} : { project }),
		};
	}

	async openProjectDialog(): Promise<ProjectSnapshot | null> {
		const window = this.#getWindow();
		const result = await showOpenDialog(window, {
			title: "打开项目",
			properties: ["openDirectory"],
		});
		if (result.canceled || result.filePaths.length === 0) return null;
		const path = result.filePaths[0];
		if (path === undefined) return null;
		return this.openProject(path);
	}

	async openProject(input: string): Promise<ProjectSnapshot> {
		const root = await assertWorkspaceRoot(input);
		if (this.#core !== undefined && this.#projectRoot === root) return this.projectSnapshot();

		await this.#teardownProject();
		this.#warnings = [];
		const core = new Core({
			requestApproval: (request, signal) => this.#requestApproval(request, signal),
			onWarning: (message) => {
				this.#warnings = [...this.#warnings.slice(-(MAX_WARNINGS - 1)), message];
				this.#notice("warn", message);
			},
			hostKind: "desktop",
			...(this.#homeDir === undefined ? {} : { homeDir: this.#homeDir }),
		});
		this.#core = core;
		this.#projectRoot = root;
		this.#startWatcher(root);
		await this.#store.rememberProject(root).catch((error: unknown) => {
			this.#notice("warn", `Could not save the recent project list: ${messageOf(error)}`);
		});

		try {
			await core.prepareMcp(root);
		} catch (error) {
			this.#notice("warn", `Could not start MCP servers: ${messageOf(error)}`);
		}

		const page = await core.listSessionsPage(root, { limit: 1, includeArchived: false });
		const latest = page.items[0];
		let session: Session;
		if (latest !== undefined) {
			session = await core.openSession(latest.id);
		} else {
			session = await core.createSession(root);
			this.#createdSessionIds.add(session.meta.id);
		}
		this.#sessions.set(session.meta.id, session);
		this.#current = session;
		await this.#acquireLease(session);
		this.#ensureSubscribed(session);
		await this.#refreshMetas();
		await this.#refreshCatalog();
		return this.projectSnapshot();
	}

	async projectSnapshot(): Promise<ProjectSnapshot> {
		const core = this.#requiredCore();
		const root = this.#requiredProject();
		const trust = await this.#readTrust();
		const models = await core.listModels(root).catch(() => this.#catalog);
		this.#catalog = models;
		const skills = await core.listSkills(root).catch(() => []);
		const mcp = core.mcpStatus(root);
		const session = this.#current === undefined ? undefined : await this.#buildView(this.#current);
		return {
			root,
			name: basename(root),
			trust,
			models,
			skills,
			mcp,
			warnings: [...this.#warnings],
			...(session === undefined ? {} : { session }),
		};
	}

	async listSessions(query: SessionListQuery): Promise<SessionPage> {
		const core = this.#requiredCore();
		const root = this.#requiredProject();
		const page = await core.listSessionsPage(root, {
			...(query.query === undefined ? {} : { query: query.query }),
			...(query.includeArchived === undefined ? {} : { includeArchived: query.includeArchived }),
			...(query.cursor === undefined ? {} : { cursor: query.cursor }),
			...(query.limit === undefined ? {} : { limit: query.limit }),
		});
		return {
			items: page.items,
			...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
		};
	}

	async createSession(): Promise<SessionView> {
		const core = this.#requiredCore();
		const root = this.#requiredProject();
		if (this.#current !== undefined) {
			await this.#discardIfEmpty(this.#current.meta.id);
			await this.#releaseIfIdle(this.#current.meta.id);
			this.#dropSubscriptionIfIdle(this.#current.meta.id);
		}
		const session = await core.createSession(root);
		this.#sessions.set(session.meta.id, session);
		this.#createdSessionIds.add(session.meta.id);
		this.#current = session;
		this.#readOnlyIds.delete(session.meta.id);
		await this.#acquireLease(session);
		this.#ensureSubscribed(session);
		await this.#refreshMetas();
		this.#push({ type: "sessions-changed" });
		await this.#pushView(session);
		return this.#buildView(session);
	}

	async activateSession(id: string): Promise<SessionView> {
		if (this.#current?.meta.id === id) return this.#buildView(this.#current);

		const previous = this.#current;
		const session = await this.#sessionFor(id);
		this.#sessions.set(session.meta.id, session);
		if (previous !== undefined) {
			await this.#discardIfEmpty(previous.meta.id);
			await this.#releaseIfIdle(previous.meta.id);
			this.#dropSubscriptionIfIdle(previous.meta.id);
		}
		this.#current = session;
		await this.#acquireLease(session);
		this.#ensureSubscribed(session);
		await this.#pushView(session);
		return this.#buildView(session);
	}

	async renameSession(id: string, title: string): Promise<void> {
		const session = await this.#sessionFor(id);
		await this.#requiredCore().renameSession(session, title);
		await this.#refreshMetas();
		this.#pushMeta(id);
		this.#push({ type: "sessions-changed" });
		await this.#pushViewIfCurrent(id);
	}

	async archiveSession(id: string, archived: boolean): Promise<void> {
		const session = await this.#sessionFor(id);
		await this.#requiredCore().archiveSession(session, archived);
		await this.#refreshMetas();
		this.#pushMeta(id);
		this.#push({ type: "sessions-changed" });
		await this.#pushViewIfCurrent(id);
	}

	async deleteSessions(
		ids: readonly string[],
	): Promise<{ deleted: readonly string[]; failed: readonly { id: string; error: string }[] }> {
		const core = this.#requiredCore();
		const allowed: string[] = [];
		const rejected: { id: string; error: string }[] = [];
		for (const id of ids) {
			try {
				await this.#sessionFor(id);
				allowed.push(id);
			} catch (error) {
				rejected.push({ id, error: messageOf(error) });
			}
		}
		const result = await core.deleteSessions(allowed);
		if (result.deleted.length > 0) {
			const deleted = new Set(result.deleted);
			this.#queue = this.#queue.filter((entry) => !deleted.has(entry.sessionId));
		}
		for (const id of result.deleted) {
			this.#sessions.delete(id);
			this.#readOnlyIds.delete(id);
			this.#createdSessionIds.delete(id);
			this.#dropSubscription(id);
			if (this.#current?.meta.id === id) this.#current = undefined;
		}
		await this.#refreshMetas();
		this.#push({ type: "sessions-changed" });
		if (this.#current === undefined && this.#projectRoot !== undefined) {
			const latest = this.#metas.filter((meta) => !meta.archived).at(-1);
			if (latest !== undefined) {
				await this.activateSession(latest.id);
			} else {
				await this.createSession();
			}
		}
		return { deleted: result.deleted, failed: [...rejected, ...result.failed] };
	}

	async forkSession(id: string, uptoSeq?: number): Promise<SessionView> {
		const core = this.#requiredCore();
		if (this.#activeRun?.sessionId === id) throw new Error("A turn is running in this session");
		const source = await this.#sessionFor(id);
		const forked = await core.forkSession(source, uptoSeq);
		this.#sessions.set(forked.session.meta.id, forked.session);
		this.#createdSessionIds.add(forked.session.meta.id);
		await this.activateSession(forked.session.meta.id);
		await this.#refreshMetas();
		this.#push({ type: "sessions-changed" });
		return this.#buildView(forked.session);
	}

	async exportSession(id: string): Promise<SessionExportResult | null> {
		const core = this.#requiredCore();
		const session = await this.#sessionFor(id);
		const window = this.#getWindow();
		const result = await showSaveDialog(window, {
			title: "导出会话",
			defaultPath: join(session.meta.projectRoot, `moros-${session.meta.id}.md`),
			filters: [
				{ name: "Markdown", extensions: ["md"] },
				{ name: "JSON", extensions: ["json"] },
				{ name: "HTML", extensions: ["html"] },
			],
		});
		if (result.canceled || result.filePath === undefined) return null;
		return core.exportSession(session, result.filePath, { allowOutsideSandbox: true });
	}

	async replaySession(id: string): Promise<readonly EventRecord[]> {
		const session = await this.#sessionFor(id);
		return this.#requiredCore().readEvents(session);
	}

	async eventsPage(id: string, beforeSeq?: number, limit?: number): Promise<readonly EventRecord[]> {
		const core = this.#requiredCore();
		const session = await this.#sessionFor(id);
		return core.readEventsPage(session, {
			...(beforeSeq === undefined ? {} : { beforeSeq }),
			...(limit === undefined ? {} : { limit }),
		});
	}

	async sessionChanges(id?: string): Promise<readonly FileChangeSummary[]> {
		const core = this.#requiredCore();
		const session = id === undefined ? this.#requireCurrent() : await this.#sessionFor(id);
		const events = await core.readEvents(session);
		const changes: FileChangeSummary[] = [];
		for (const event of events) {
			if (event.type === "file.changed") {
				changes.push({ seq: event.seq, path: event.payload.path, op: event.payload.op, ts: event.ts });
			}
		}
		return changes.slice(-500);
	}

	async checkpoint(): Promise<CheckpointView | null> {
		const core = this.#requiredCore();
		const session = this.#requireCurrent();
		const latest = await core.latestCheckpoint(session);
		if (latest === undefined) return null;
		return {
			id: latest.id,
			seq: latest.seq,
			...(latest.ts === undefined ? {} : { ts: latest.ts }),
			files: latest.files.map((file) => ({ path: file.path, op: file.op })),
		};
	}

	async rollbackStep(): Promise<void> {
		const core = this.#requiredCore();
		if (this.#activeRun !== undefined) throw new Error("A turn is running; wait for it to finish");
		await core.rollbackStep(this.#requireCurrent());
		await this.#pushViewIfCurrent(this.#requireCurrent().meta.id);
	}

	async restoreCheckpoint(id: string): Promise<{ restored: number; removed: number }> {
		const core = this.#requiredCore();
		if (this.#activeRun !== undefined) throw new Error("A turn is running; wait for it to finish");
		const session = this.#requireCurrent();
		const result = await core.restoreCheckpoint(session, id);
		await this.#pushViewIfCurrent(session.meta.id);
		return result;
	}

	async compactSession(): Promise<{ compacted: boolean; covered: number; tokensBefore: number; tokensAfter: number }> {
		const core = this.#requiredCore();
		const session = this.#requireCurrent();
		if (this.#activeRun !== undefined) throw new Error("A turn is already running");
		const result = await core.compactSession(session);
		await this.#pushViewIfCurrent(session.meta.id);
		return {
			compacted: result.compacted,
			covered: result.covered,
			tokensBefore: result.tokensBefore,
			tokensAfter: result.tokensAfter,
		};
	}

	async reviewSession(prompt: string): Promise<ReviewResult> {
		const core = this.#requiredCore();
		const root = this.#requiredProject();
		if (this.#activeRun !== undefined) throw new Error("A turn is already running");
		if (this.#reviewing) throw new Error("A review is already running");
		this.#reviewing = true;
		const runId = randomUUID();
		const sessionId = this.#current?.meta.id ?? "";
		this.#push({ type: "review", sessionId, runId, state: "running" });
		try {
			const result = await core.reviewSession(root, prompt);
			this.#push({ type: "review", sessionId, runId, state: "done", report: result.report });
			return result;
		} catch (error) {
			this.#push({ type: "review", sessionId, runId, state: "error", error: messageOf(error) });
			throw error;
		} finally {
			this.#reviewing = false;
		}
	}

	async send(input: ChatSendInput): Promise<ChatSendResult> {
		const session = this.#requireCurrent();
		if (input.sessionId !== session.meta.id) throw new Error("The active session changed; send again");
		if (this.#reviewing) throw new Error("A review is running; wait for it to finish");
		if (this.#readOnlyIds.has(session.meta.id)) throw new Error("Session is read-only: it is open in another window");
		const trust = await this.#readTrust();
		if (trust.required && trust.decision === null) {
			throw new Error("Workspace trust is required before sending a message");
		}
		const text = input.text.trim();
		const imageIds = input.imageIds ?? [];
		if (text.length === 0 && imageIds.length === 0) throw new Error("Message is empty");
		const images = imageIds.map((id) => {
			const entry = this.#preparedImages.get(id);
			if (entry === undefined) throw new Error("An attached image has expired; attach it again");
			return entry.image;
		});
		const totalBytes = images.reduce((sum, image) => sum + Buffer.byteLength(image.data, "base64"), 0);
		if (images.length > MAX_IMAGES_PER_REQUEST) {
			throw new Error(`Too many images: ${images.length}; the maximum per message is ${MAX_IMAGES_PER_REQUEST}`);
		}
		if (totalBytes > MAX_IMAGE_BYTES_PER_REQUEST) {
			throw new Error(
				`Images total ${formatImageBytes(totalBytes)}; the maximum is ${formatImageBytes(MAX_IMAGE_BYTES_PER_REQUEST)}`,
			);
		}

		const entry: QueuedEntry = { id: randomUUID(), sessionId: session.meta.id, text, images };
		const queued = this.#activeRun !== undefined || this.#startingRun;
		if (queued) {
			if (this.#queue.length >= MAX_QUEUE) throw new Error(`Queue is full (${MAX_QUEUE})`);
			this.#queue.push(entry);
			this.#pushQueue(session.meta.id);
		} else {
			await this.#startRun(entry);
		}
		for (const id of imageIds) this.#preparedImages.delete(id);
		return { queued };
	}

	abort(): void {
		const run = this.#activeRun;
		if (run === undefined) return;
		run.controller.abort(new Error("Stopped by user"));
		try {
			this.#requiredCore().abortSession(run.sessionId, "user");
		} catch {
			// 外部 signal 已经能停掉这一轮；Loop 已收尾时没有可中止对象。
		}
	}

	pause(): void {
		const run = this.#activeRun;
		if (run === undefined) throw new Error("No turn is running");
		this.#requiredCore().pauseSession(run.sessionId);
		run.paused = true;
		this.#push({ type: "run", sessionId: run.sessionId, runId: run.runId, state: "paused" });
	}

	resume(): void {
		const run = this.#activeRun;
		if (run === undefined) throw new Error("No turn is running");
		this.#requiredCore().resumeSession(run.sessionId);
		run.paused = false;
		this.#push({ type: "run", sessionId: run.sessionId, runId: run.runId, state: "running" });
	}

	liveState(sessionId?: string): ChatLiveResult {
		const id = sessionId ?? this.#requireCurrent().meta.id;
		return {
			sessionId: id,
			live: this.#liveState(id),
			queued: this.#queue.filter((entry) => entry.sessionId === id).map(toQueuedMessage),
		};
	}

	clearQueue(): void {
		const affected = new Set(this.#queue.map((entry) => entry.sessionId));
		this.#queue = [];
		for (const id of affected) this.#pushQueue(id);
	}

	respondApproval(id: string, decision: ApprovalDecision): void {
		this.#broker.respond(id, decision);
	}

	workspaceRoot(): string {
		return this.#requiredProject();
	}

	async workspaceList(path: string, includeHidden?: boolean): Promise<readonly WorkspaceEntry[]> {
		const root = this.#requiredProject();
		return listDirectory(root, path, includeHidden === undefined ? {} : { includeHidden });
	}

	async diff(seq: number): Promise<FileChangeDiff> {
		return this.#requiredCore().diffChange(this.#requireCurrent().meta.id, seq);
	}

	async trace(sessionId?: string): Promise<readonly TraceTurn[]> {
		const core = this.#requiredCore();
		const session = sessionId === undefined ? this.#requireCurrent() : await this.#sessionFor(sessionId);
		return buildTrace(await core.readEvents(session));
	}

	async settings(): Promise<SettingsSnapshot> {
		return this.#requiredCore().getSettings();
	}

	async updateSettings(patch: SettingsPatch): Promise<SettingsSnapshot> {
		const snapshot = await this.#requiredCore().updateSettings(patch);
		await this.#refreshCatalog();
		await this.#pushViewIfCurrent(this.#current?.meta.id);
		return snapshot;
	}

	async upsertProvider(name: string, draft: ProviderDraft): Promise<SettingsSnapshot> {
		const snapshot = await this.#requiredCore().upsertProvider(name, draft);
		await this.#refreshCatalog();
		await this.#pushViewIfCurrent(this.#current?.meta.id);
		return snapshot;
	}

	async deleteProvider(name: string): Promise<SettingsSnapshot> {
		const snapshot = await this.#requiredCore().deleteProvider(name);
		await this.#refreshCatalog();
		await this.#pushViewIfCurrent(this.#current?.meta.id);
		return snapshot;
	}

	async revealSecret(name: string): Promise<string> {
		return this.#requiredCore().revealProviderSecret(name);
	}

	async models(): Promise<ModelCatalog> {
		await this.#refreshCatalog();
		return this.#catalog;
	}

	async configSummary(): Promise<ConfigSummary> {
		const summary = await this.#requiredCore().getConfigSummary(this.#requiredProject());
		return summary as unknown as ConfigSummary;
	}

	async selectModel(provider: string, model: string): Promise<void> {
		const core = this.#requiredCore();
		const session = this.#requireCurrent();
		const catalog = await core.listModels(this.#requiredProject());
		const providerEntry = catalog.providers.find((entry) => entry.name === provider);
		if (!providerEntry?.models.some((entry) => entry.id === model)) {
			throw new Error(`Unknown model: ${provider}/${model}`);
		}
		await core.selectModel(session, provider, model);
		await core.setDefaultModel(provider, model);
		await this.#refreshCatalog();
		await this.#pushViewIfCurrent(session.meta.id);
	}

	async selectEffort(effort: ReasoningEffort): Promise<void> {
		const core = this.#requiredCore();
		const session = this.#requireCurrent();
		core.selectEffort(session, effort);
		await core.setDefaultEffort(effort);
		await this.#pushViewIfCurrent(session.meta.id);
	}

	async selectApproval(mode: ApprovalMode): Promise<void> {
		const core = this.#requiredCore();
		const session = this.#requireCurrent();
		core.setSessionApproval(session, mode);
		await this.#pushViewIfCurrent(session.meta.id);
	}

	async setPlan(enabled: boolean): Promise<boolean> {
		const core = this.#requiredCore();
		const session = this.#requireCurrent();
		core.setSessionPlan(session, enabled);
		await this.#pushViewIfCurrent(session.meta.id);
		return core.isSessionPlan(session);
	}

	async skills(): Promise<readonly SkillSummary[]> {
		return this.#requiredCore().listSkills(this.#requiredProject());
	}

	async trustAccept(remember: boolean): Promise<WorkspaceTrustView> {
		const core = this.#requiredCore();
		const root = this.#requiredProject();
		await core.acceptWorkspaceTrust(root, remember);
		try {
			await core.prepareMcp(root);
		} catch (error) {
			this.#notice("warn", `Could not start MCP servers: ${messageOf(error)}`);
		}
		const trust = await this.#readTrust();
		this.#push({ type: "trust", trust });
		await this.#refreshCatalog();
		await this.#pushViewIfCurrent(this.#current?.meta.id);
		return trust;
	}

	async trustDeny(): Promise<WorkspaceTrustView> {
		const core = this.#requiredCore();
		const root = this.#requiredProject();
		await core.denyWorkspaceTrust(root);
		const trust = await this.#readTrust();
		this.#push({ type: "trust", trust });
		await this.#refreshCatalog();
		await this.#pushViewIfCurrent(this.#current?.meta.id);
		return trust;
	}

	mcpStatus(): readonly McpStatus[] {
		return this.#requiredCore().mcpStatus(this.#requiredProject());
	}

	async mcpReconnect(name: string): Promise<string> {
		return this.#requiredCore().reconnectMcp(this.#requiredProject(), name);
	}

	async mcpHealth(): Promise<readonly string[]> {
		return this.#requiredCore().healthCheckMcp(this.#requiredProject());
	}

	async prepareImageFromDialog(): Promise<PreparedImage | null> {
		const window = this.#getWindow();
		const result = await showOpenDialog(window, {
			title: "附加图片",
			properties: ["openFile", "multiSelections"],
			filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "gif"] }],
		});
		if (result.canceled || result.filePaths.length === 0) return null;
		const path = result.filePaths[0];
		if (path === undefined) return null;
		const image = await this.#requiredCore().prepareImage(this.#requiredProject(), path);
		return this.#rememberImage(image);
	}

	async prepareImageFromBytes(bytes: Uint8Array, mediaType?: string): Promise<PreparedImage> {
		if (bytes.byteLength === 0) throw new Error("Image is empty");
		if (bytes.byteLength > MAX_IMAGE_BYTES_PER_REQUEST) {
			throw new Error(`Image is too large; the maximum is ${formatImageBytes(MAX_IMAGE_BYTES_PER_REQUEST)}`);
		}
		const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		const image = this.#requiredCore().prepareImageBytes(buffer);
		if (mediaType !== undefined && image.mediaType !== mediaType) {
			throw new Error(`Unsupported image type: ${mediaType}`);
		}
		return this.#rememberImage(image);
	}

	async prepareImageFromUrl(url: string): Promise<PreparedImage> {
		const image = await this.#requiredCore().prepareImageUrl(url);
		return this.#rememberImage(image);
	}

	async openExternal(url: string): Promise<void> {
		const parsed = new URL(url);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
			throw new Error("Only HTTP(S) links can be opened");
		await shell.openExternal(parsed.href);
	}

	async dispose(): Promise<void> {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#broker.denyAll();
		this.#activeRun?.controller.abort(new Error("Application is shutting down"));
		if (this.#activeRunPromise !== undefined) {
			await Promise.race([this.#activeRunPromise.catch(() => undefined), delay(3_000)]);
		}
		await this.#teardownProject();
	}

	async #teardownProject(): Promise<void> {
		this.#broker.denyAll();
		this.#activeRun?.controller.abort(new Error("Project is closing"));
		if (this.#activeRunPromise !== undefined) {
			await Promise.race([this.#activeRunPromise.catch(() => undefined), delay(3_000)]);
		}
		this.#watcher?.close();
		this.#watcher = undefined;
		for (const unsubscribe of this.#subscriptions.values()) unsubscribe();
		this.#subscriptions.clear();
		for (const timer of this.#streams.values()) {
			if (timer.timer !== undefined) clearTimeout(timer.timer);
		}
		this.#streams.clear();
		this.#live.clear();
		this.#queue = [];
		this.#activeRun = undefined;
		this.#activeRunPromise = undefined;
		this.#reviewing = false;
		this.#preparedImages.clear();
		this.#readOnlyIds.clear();
		if (this.#core !== undefined) {
			const core = this.#core;
			for (const id of [...this.#createdSessionIds]) {
				await core.discardEmptySession(id).catch(() => false);
			}
			await core.dispose();
		}
		this.#core = undefined;
		this.#projectRoot = undefined;
		this.#current = undefined;
		this.#sessions.clear();
		this.#createdSessionIds.clear();
		this.#metas = [];
		this.#catalog = { providers: [] };
	}

	#startWatcher(root: string): void {
		this.#watcher?.close();
		this.#watcher = watchWorkspace(root, (paths) => this.#push({ type: "workspace", paths }), {
			onError: (error) => this.#notice("warn", `Workspace watcher failed: ${messageOf(error)}`),
		});
	}

	async #startRun(entry: QueuedEntry): Promise<void> {
		if (this.#disposed) return;
		this.#startingRun = true;
		try {
			const core = this.#requiredCore();
			const session = await this.#sessionFor(entry.sessionId);
			if (!core.hasSessionLease(session.meta.id)) {
				try {
					await core.acquireSessionLease(session);
					this.#readOnlyIds.delete(session.meta.id);
				} catch (error) {
					if (error instanceof SessionBusyError) {
						this.#readOnlyIds.add(session.meta.id);
						throw error;
					}
					throw error;
				}
			}
			if (this.#readOnlyIds.has(session.meta.id)) throw new Error("Session is read-only: it is open in another window");
			this.#ensureSubscribed(session);

			const runId = randomUUID();
			const controller = new AbortController();
			const live = this.#liveFor(session.meta.id);
			live.running = true;
			live.paused = false;
			live.runId = runId;
			live.text = "";
			live.reasoning = "";
			live.toolOutputs.clear();
			live.startedAt = Date.now();
			this.#activeRun = {
				runId,
				sessionId: session.meta.id,
				controller,
				startedAt: live.startedAt,
				paused: false,
			};
			this.#push({ type: "run", sessionId: session.meta.id, runId, state: "running" });
			this.#pushQueue(session.meta.id);
			this.#activeRunPromise = this.#run(entry, session, runId, controller);
		} finally {
			this.#startingRun = false;
		}
	}

	async #run(entry: QueuedEntry, session: Session, runId: string, controller: AbortController): Promise<void> {
		const core = this.#requiredCore();
		const sessionId = session.meta.id;
		const live = this.#liveFor(sessionId);
		let outcome: "ok" | "aborted" | "error" = "ok";
		try {
			await core.runSession(session, entry.text, {
				signal: controller.signal,
				...(entry.images.length > 0 ? { images: entry.images } : {}),
				onText: (delta) => {
					live.text += delta;
					this.#enqueueStream({
						sessionId,
						runId,
						kind: "text",
						text: delta,
					});
				},
				onReasoning: (delta) => {
					live.reasoning += delta;
					this.#enqueueStream({
						sessionId,
						runId,
						kind: "reasoning",
						text: delta,
					});
				},
				onRetry: () => {
					live.text = "";
					live.reasoning = "";
					this.#dropStreams(runId);
					this.#push({ type: "retry", sessionId, runId });
				},
				onWarning: (message) => this.#notice("warn", message),
				onToolOutput: (toolCallId, chunk) => {
					live.toolOutputs.set(toolCallId, (live.toolOutputs.get(toolCallId) ?? "") + chunk);
					this.#enqueueStream({
						sessionId,
						runId,
						kind: "tool",
						toolCallId,
						text: chunk,
					});
				},
				onSubagent: (progress) => {
					this.#push({
						type: "subagent",
						sessionId,
						runId,
						progress: {
							toolCallId: progress.toolCallId,
							steps: progress.steps,
							totalTokens: progress.totalTokens,
							elapsedMs: progress.elapsedMs,
						},
					});
				},
			});
		} catch (error) {
			const aborted = controller.signal.aborted || isAbortError(error);
			if (aborted) {
				outcome = "aborted";
				this.#notice("info", "Turn stopped.");
			} else {
				outcome = "error";
				this.#push({
					type: "run",
					sessionId,
					runId,
					state: "error",
					error: messageOf(error),
				});
				this.#notice("error", messageOf(error));
			}
		} finally {
			this.#flushSessionStreams(sessionId);
			if (this.#activeRun?.runId === runId) this.#activeRun = undefined;
			live.running = false;
			live.paused = false;
			live.text = "";
			live.reasoning = "";
			live.toolOutputs.clear();
			live.runId = undefined;
			live.startedAt = undefined;
			await this.#refreshMetas().catch((error: unknown) =>
				this.#notice("warn", `Could not refresh sessions: ${messageOf(error)}`),
			);
			this.#pushMeta(sessionId);
			await this.#pushViewIfCurrent(sessionId).catch(() => undefined);
			this.#pushQueue(sessionId);
			if (outcome !== "error") {
				this.#push({ type: "run", sessionId, runId, state: "idle" });
			}
			await this.#notifyRunFinished(sessionId, outcome === "error");
			this.#activeRunPromise = undefined;
			void this.#drainQueue();
		}
	}

	#drainQueue(): void {
		if (this.#disposed) return;
		const next = this.#queue.shift();
		if (next === undefined) return;
		this.#pushQueue(next.sessionId);
		void this.#startRun(next).catch((error: unknown) => {
			this.#notice("error", messageOf(error));
			this.#pushQueue(next.sessionId);
			void this.#drainQueue();
		});
	}

	async #sessionFor(id: string): Promise<Session> {
		const existing = this.#sessions.get(id);
		if (existing !== undefined) {
			this.#assertSessionInProject(existing);
			return existing;
		}
		const session = await this.#requiredCore().openSession(id);
		this.#assertSessionInProject(session);
		this.#sessions.set(id, session);
		return session;
	}

	/** 单窗口只服务当前项目；会话事件、导出与删除都不得跨出这个边界。 */
	#assertSessionInProject(session: Session): void {
		const project = this.#requiredProject();
		if (normalizeProjectRoot(session.meta.projectRoot) !== normalizeProjectRoot(project)) {
			throw new Error(`Session ${session.meta.id} belongs to another project`);
		}
	}

	async #acquireLease(session: Session): Promise<void> {
		const core = this.#requiredCore();
		try {
			await core.acquireSessionLease(session);
			this.#readOnlyIds.delete(session.meta.id);
		} catch (error) {
			if (error instanceof SessionBusyError) {
				this.#readOnlyIds.add(session.meta.id);
				this.#notice("warn", `Session ${session.meta.id} is open in another window; this window is read-only.`);
				return;
			}
			throw error;
		}
	}

	async #releaseIfIdle(id: string): Promise<void> {
		if (this.#activeRun?.sessionId === id) return;
		if (this.#queue.some((entry) => entry.sessionId === id)) return;
		const core = this.#core;
		if (core === undefined) return;
		if (core.hasSessionLease(id)) await core.releaseSessionLease(id);
	}

	async #discardIfEmpty(id: string): Promise<void> {
		if (!this.#createdSessionIds.has(id)) return;
		if (this.#activeRun?.sessionId === id) return;
		const core = this.#core;
		if (core === undefined) return;
		try {
			const removed = await core.discardEmptySession(id);
			if (!removed) return;
			this.#createdSessionIds.delete(id);
			this.#sessions.delete(id);
			this.#readOnlyIds.delete(id);
			this.#dropSubscription(id);
		} catch (error) {
			this.#notice("warn", `Could not clean up an empty session: ${messageOf(error)}`);
		}
	}

	#ensureSubscribed(session: Session): void {
		const id = session.meta.id;
		if (this.#subscriptions.has(id)) return;
		const unsubscribe = this.#requiredCore().subscribeEvents(session, (event) => {
			this.#flushSessionStreams(id);
			this.#push({ type: "event", sessionId: id, event });
			this.#observeEvent(id, event);
		});
		this.#subscriptions.set(id, unsubscribe);
	}

	#dropSubscriptionIfIdle(id: string): void {
		if (this.#activeRun?.sessionId === id) return;
		if (this.#queue.some((entry) => entry.sessionId === id)) return;
		this.#dropSubscription(id);
	}

	#dropSubscription(id: string): void {
		const unsubscribe = this.#subscriptions.get(id);
		if (unsubscribe === undefined) return;
		unsubscribe();
		this.#subscriptions.delete(id);
	}

	#observeEvent(sessionId: string, event: EventRecord): void {
		const live = this.#live.get(sessionId);
		if (live !== undefined) {
			if (event.type === "llm.request" || event.type === "llm.response") {
				live.text = "";
				live.reasoning = "";
			}
			if (event.type === "tool.result") {
				live.toolOutputs.delete(event.payload.toolCallId);
			}
		}
		if (event.type === "session.renamed" || event.type === "session.archived") {
			void this.#refreshMetas()
				.then(() => {
					this.#pushMeta(sessionId);
					this.#push({ type: "sessions-changed" });
				})
				.catch(() => undefined);
		}
	}

	#requestApproval(request: ApprovalRequest, signal?: AbortSignal): Promise<ApprovalDecision> {
		const sessionId = this.#activeRun?.sessionId ?? this.#current?.meta.id;
		if (sessionId === undefined) return Promise.resolve("deny");
		const card = toApprovalCard(request, sessionId);
		this.#push({ type: "approval", card });
		return this.#broker.request(request, signal).finally(() => {
			this.#push({ type: "approval-cleared", id: request.id });
		});
	}

	async #readTrust(): Promise<WorkspaceTrustView> {
		const core = this.#requiredCore();
		const root = this.#requiredProject();
		try {
			return await core.getWorkspaceTrust(root);
		} catch (error) {
			this.#notice("warn", `Could not read workspace trust: ${messageOf(error)}`);
			// 读不到结论时按「需要确认」处理，宁可挡住发送也不默认信任。
			return { required: true, decision: null, files: [], skillDirectories: [] };
		}
	}

	async #refreshMetas(): Promise<void> {
		const core = this.#core;
		if (core === undefined || this.#projectRoot === undefined) return;
		this.#metas = await core.listSessions(this.#projectRoot);
	}

	async #refreshCatalog(): Promise<void> {
		const core = this.#core;
		if (core === undefined || this.#projectRoot === undefined) return;
		this.#catalog = await core.listModels(this.#projectRoot);
	}

	#metaFor(session: Session): SessionMeta {
		return this.#metas.find((meta) => meta.id === session.meta.id) ?? session.meta;
	}

	#pushMeta(id: string): void {
		const meta = this.#metas.find((entry) => entry.id === id);
		if (meta !== undefined) this.#push({ type: "session-updated", meta });
	}

	async #buildView(session: Session): Promise<SessionView> {
		const core = this.#requiredCore();
		const loaded = await core.loadConfig(this.#requiredProject());
		const [selected, metrics] = await Promise.all([core.getSelectedModel(session), core.getSessionMetrics(session)]);
		const fallback = this.#catalog.selected;
		const configuredProvider = loaded.config.provider;
		const configuredModel = loaded.config.model;
		const model =
			selected ??
			fallback ??
			(configuredProvider !== undefined &&
			configuredModel !== undefined &&
			configuredProvider.length > 0 &&
			configuredModel.length > 0
				? { provider: configuredProvider, model: configuredModel }
				: undefined);
		return {
			meta: this.#metaFor(session),
			readOnly: this.#readOnlyIds.has(session.meta.id),
			running: this.#activeRun?.sessionId === session.meta.id,
			...(model === undefined ? {} : { model }),
			effort: core.getSelectedEffort(session) ?? loaded.config.reasoningEffort,
			approval: core.getSelectedApproval(session) ?? loaded.config.approval,
			plan: core.isSessionPlan(session),
			metrics,
			live: this.#liveState(session.meta.id),
			queued: this.#queue.filter((entry) => entry.sessionId === session.meta.id).length,
		};
	}

	async #pushView(session: Session): Promise<void> {
		const version = ++this.#viewVersion;
		try {
			const view = await this.#buildView(session);
			if (version !== this.#viewVersion) return;
			if (this.#current?.meta.id !== session.meta.id) return;
			this.#push({ type: "session-view", view });
		} catch (error) {
			this.#notice("warn", `Could not refresh session state: ${messageOf(error)}`);
		}
	}

	async #pushViewIfCurrent(id: string | undefined): Promise<void> {
		if (id === undefined) return;
		if (this.#current?.meta.id !== id) return;
		await this.#pushView(this.#requireCurrent());
	}

	#liveState(sessionId: string): LiveState {
		const live = this.#live.get(sessionId);
		if (live === undefined) {
			return { running: false, paused: false, text: "", reasoning: "", toolOutputs: {} };
		}
		return {
			running: live.running,
			paused: live.paused,
			...(live.runId === undefined ? {} : { runId: live.runId }),
			text: live.text,
			reasoning: live.reasoning,
			toolOutputs: Object.fromEntries(live.toolOutputs),
			...(live.startedAt === undefined ? {} : { startedAt: live.startedAt }),
		};
	}

	#liveFor(sessionId: string): MutableLive {
		const existing = this.#live.get(sessionId);
		if (existing !== undefined) return existing;
		const live: MutableLive = {
			running: false,
			paused: false,
			runId: undefined,
			text: "",
			reasoning: "",
			toolOutputs: new Map(),
			startedAt: undefined,
		};
		this.#live.set(sessionId, live);
		return live;
	}

	#enqueueStream(input: {
		sessionId: string;
		runId: string;
		kind: "text" | "reasoning" | "tool";
		toolCallId?: string;
		text: string;
	}): void {
		const key = `${input.sessionId}:${input.runId}:${input.kind}:${input.toolCallId ?? ""}`;
		const existing = this.#streams.get(key);
		if (existing !== undefined) {
			existing.text += input.text;
			return;
		}
		const pending: PendingStream = { ...input };
		pending.timer = setTimeout(() => this.#flushStream(key), STREAM_FLUSH_MS);
		this.#streams.set(key, pending);
	}

	#flushStream(key: string): void {
		const pending = this.#streams.get(key);
		if (pending === undefined) return;
		this.#streams.delete(key);
		if (pending.timer !== undefined) clearTimeout(pending.timer);
		if (pending.text.length === 0) return;
		if (pending.kind === "tool") {
			if (pending.toolCallId === undefined) return;
			this.#push({
				type: "tool-output",
				sessionId: pending.sessionId,
				runId: pending.runId,
				toolCallId: pending.toolCallId,
				delta: pending.text,
			});
			return;
		}
		this.#push({
			type: "stream",
			sessionId: pending.sessionId,
			runId: pending.runId,
			kind: pending.kind,
			delta: pending.text,
		});
	}

	#flushSessionStreams(sessionId: string): void {
		for (const [key, pending] of [...this.#streams]) {
			if (pending.sessionId === sessionId) this.#flushStream(key);
		}
	}

	#dropStreams(runId: string): void {
		for (const [key, pending] of [...this.#streams]) {
			if (pending.runId !== runId) continue;
			if (pending.timer !== undefined) clearTimeout(pending.timer);
			this.#streams.delete(key);
		}
	}

	#pushQueue(sessionId: string): void {
		this.#push({
			type: "queue",
			sessionId,
			items: this.#queue.filter((entry) => entry.sessionId === sessionId).map(toQueuedMessage),
		});
	}

	#rememberImage(image: SessionImageInput): PreparedImage {
		this.#prunePreparedImages();
		if (this.#preparedImages.size >= MAX_PREPARED_IMAGES) {
			const oldest = [...this.#preparedImages.entries()].sort(
				(left, right) => left[1].createdAt - right[1].createdAt,
			)[0];
			if (oldest !== undefined) this.#preparedImages.delete(oldest[0]);
		}
		const id = randomUUID();
		const preview: PreparedImage = {
			id,
			mediaType: image.mediaType,
			width: image.width,
			height: image.height,
			bytes: Buffer.byteLength(image.data, "base64"),
			dataUrl: `data:${image.mediaType};base64,${image.data}`,
		};
		this.#preparedImages.set(id, { image, preview, createdAt: Date.now() });
		return preview;
	}

	#prunePreparedImages(): void {
		const cutoff = Date.now() - PREPARED_IMAGE_TTL_MS;
		for (const [id, entry] of this.#preparedImages) {
			if (entry.createdAt < cutoff) this.#preparedImages.delete(id);
		}
	}

	async #notifyRunFinished(sessionId: string, failed: boolean): Promise<void> {
		const core = this.#core;
		if (core === undefined) return;
		let mode: "auto" | "bell" | "desktop" | "off" = "auto";
		try {
			mode = (await core.getSettings()).config.ui.notify;
		} catch {
			return;
		}
		if (mode === "off") return;
		const window = this.#getWindow();
		const focused = window?.isFocused() ?? false;
		if (mode === "auto" && focused) return;
		if (mode === "bell") {
			shell.beep();
			return;
		}
		if (!Notification.isSupported()) return;
		const meta = this.#metas.find((entry) => entry.id === sessionId);
		const notification = new Notification({
			title: "Moros Harness",
			body: failed ? `会话 ${meta?.title ?? sessionId} 执行失败` : `会话 ${meta?.title ?? sessionId} 已完成`,
		});
		notification.on("click", () => {
			const target = this.#getWindow();
			if (target !== undefined) {
				if (target.isMinimized()) target.restore();
				target.show();
				target.focus();
			}
		});
		notification.show();
	}

	#push(message: PushMessage): void {
		if (this.#disposed) return;
		try {
			this.#pushMessage(message);
		} catch {
			// 窗口已销毁时推送失败不影响主进程状态；下一次打开会重新拉取快照。
		}
	}

	#notice(level: "info" | "warn" | "error", message: string): void {
		this.#push({ type: "notice", level, message });
	}

	#requiredCore(): Core {
		if (this.#core === undefined) throw new Error("No project is open");
		return this.#core;
	}

	#requiredProject(): string {
		if (this.#projectRoot === undefined) throw new Error("No project is open");
		return this.#projectRoot;
	}

	#requireCurrent(): Session {
		if (this.#current === undefined) throw new Error("No session is active");
		return this.#current;
	}
}

function toQueuedMessage(entry: QueuedEntry): QueuedMessage {
	return { id: entry.id, text: entry.text, imageCount: entry.images.length };
}

function toApprovalCard(request: ApprovalRequest, sessionId: string): ApprovalCard {
	const raw = typeof request.args === "string" ? request.args : (JSON.stringify(request.args, null, 2) ?? "");
	const summary = `${request.tool} · ${oneLine(raw, 140)}`;
	const preview = raw.length > MAX_PREVIEW_CHARS ? `${raw.slice(0, MAX_PREVIEW_CHARS)}…` : raw;
	let saveShort: string | undefined;
	try {
		saveShort = approvalScope(request.tool, request.args).label;
	} catch {
		saveShort = undefined;
	}
	return {
		id: request.id,
		sessionId,
		tool: request.tool,
		risk: request.risk,
		reason: request.reason,
		summary,
		preview,
		...(saveShort === undefined ? {} : { saveShort }),
		requestedAt: new Date().toISOString(),
	};
}

function oneLine(text: string, limit: number): string {
	const clean = text.replaceAll(/\s+/g, " ").trim();
	return clean.length <= limit ? clean : `${clean.slice(0, limit - 1)}…`;
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isAbortError(error: unknown): boolean {
	return error instanceof Error && (error.name === "AbortError" || /aborted/i.test(error.message));
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, ms);
		timer.unref();
	});
}

function showOpenDialog(
	window: BrowserWindow | undefined,
	options: Electron.OpenDialogOptions,
): Promise<Electron.OpenDialogReturnValue> {
	return window === undefined ? dialog.showOpenDialog(options) : dialog.showOpenDialog(window, options);
}

function showSaveDialog(
	window: BrowserWindow | undefined,
	options: Electron.SaveDialogOptions,
): Promise<Electron.SaveDialogReturnValue> {
	return window === undefined ? dialog.showSaveDialog(options) : dialog.showSaveDialog(window, options);
}
