import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { basename, join } from "node:path";

import { clipboard, Notification, dialog, shell, type BrowserWindow } from "electron";

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
	type ChangeStats,
	type DiscoveredModel,
	type DiscoverModelsRequest,
	type FileChangeDiff,
	type McpStatus,
	type ModelCatalog,
	type ProviderDraft,
	type ReasoningEffort,
	type Session,
	type SessionExportResult,
	type TestModelRequest,
	type TestModelResult,
	type SessionImageInput,
	type SessionMeta,
	type SessionMetrics,
	type SettingsPatch,
	type SettingsSnapshot,
	type SkillSummary,
	type WorkspaceEntry,
	type WorkspaceWatch,
} from "@moros/core";
import type { ModelMetadata as CatalogModelMetadata } from "@moros/core/config/model-catalog/metadata.ts";
import type { EventRecord } from "@moros/core/events/schema.ts";
import { normalizeProjectRoot } from "@moros/core/session/project-dir.ts";
import { VERSION } from "@moros/core/version.ts";
import {
	type AppSnapshot,
	type ApprovalCard,
	type ChatLiveResult,
	type ChatSendInput,
	type ChatSendResult,
	type CheckpointView,
	type ConfigSummary,
	type FileChangeSummary,
	type GitBranches,
	type GitCheckoutResult,
	type LiveState,
	type McpServerDetail,
	type McpServerDraftInput,
	type PreparedImage,
	type ProjectSelection,
	type ProjectSnapshot,
	type PushMessage,
	type RecentProject,
	type QueuedMessage,
	type ReviewResult,
	type SessionContext,
	type SessionCreateInput,
	type SessionListQuery,
	type SessionPage,
	type SessionView,
	type SkillDocumentResult,
	type SkillDraftInput,
	type TraceTurn,
	type WorkspaceTarget,
	type WorkspaceTrustView,
} from "../shared/contract.ts";
import { checkoutGitBranch, listGitBranches } from "./_git.ts";
import {
	DesktopWorkspaceError,
	assertProjectDirectory,
	createProjectDirectory,
	createTaskWorkspace,
	validateProjectName,
} from "./_workspace.ts";
import { DesktopStore } from "./store.ts";
import { buildTrace } from "./trace.ts";

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
	readonly #taskRoot: string;
	// 桌面端是交互式界面：审批卡等待用户决定，不设自动拒绝超时（0 = 关闭）；
	// 放弃等待的出口是「停止回合」——中止信号会让挂起的审批按取消收尾。
	readonly #broker: ApprovalBroker = createApprovalBroker({ timeoutMs: 0 });
	#workspaceOperation: Promise<void> = Promise.resolve();

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
	/** 每会话一个运行槽位：会话是并发的最小单位（对齐 DSH/opencode 的 per-session 调度）。 */
	#runs = new Map<string, ActiveRun>();
	#runPromises = new Map<string, Promise<void>>();
	#starting = new Set<string>();
	#queues = new Map<string, QueuedEntry[]>();
	#live = new Map<string, MutableLive>();
	#streams = new Map<string, PendingStream>();
	#preparedImages = new Map<string, { image: SessionImageInput; preview: PreparedImage; createdAt: number }>();
	#viewVersion = 0;
	#reviewing = false;
	#disposed = false;

	private constructor(store: DesktopStore, taskRoot: string, options: DesktopHostOptions) {
		this.#store = store;
		this.#taskRoot = taskRoot;
		this.#getWindow = options.getWindow;
		this.#pushMessage = options.push;
		this.#homeDir = options.homeDir;
	}

	/**
	 * 打开桌面本地状态并建立稳定任务根，不创建或恢复会话。
	 * @param options userDataDir 必须是绝对路径；homeDir 仍只控制 Core 存储。
	 * @returns 尚未初始化工作区的宿主；退出时必须 await dispose()。
	 * @throws DesktopWorkspaceError 默认任务目录无法建立或校验时。
	 * @example const host = await DesktopHost.create({ userDataDir, getWindow, push });
	 */
	static async create(options: DesktopHostOptions): Promise<DesktopHost> {
		const taskRoot = await createTaskWorkspace(options.userDataDir);
		const store = await DesktopStore.open(options.userDataDir);
		return new DesktopHost(store, taskRoot, options);
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

	/** 持久化侧栏宽度；渲染层拖拽结束后调用，返回钳制后的实际值。 */
	async setSidebarWidth(width: number): Promise<number> {
		const clamped = await this.#store.setSidebarWidth(width);
		this.#push({ type: "sidebar-width", width: clamped });
		return clamped;
	}

	/**
	 * 建立初始工作区并返回应用快照。
	 * 首次启动始终落在内部任务根的新建任务页：最近项目只保留在侧栏列表，
	 * 不自动打开其工作区或恢复旧会话；已打开的工作区仅刷新快照，避免打断当前任务。
	 */
	async initialize(): Promise<AppSnapshot> {
		return this.#withWorkspace(async () => {
			let project: ProjectSnapshot | undefined;
			if (this.#core !== undefined) {
				// appState 也是刷新入口；picker-only 更新最近项目不能使它跳到另一个执行根。
				project = await this.projectSnapshot();
			} else {
				project = await this.#prepareWorkspace({ kind: "tasks" });
			}
			return {
				version: VERSION,
				platform: process.platform,
				taskRoot: this.#taskRoot,
				recentProjects: this.#recentProjects(),
				sidebarWidth: this.#store.sidebarWidth(),
				pinnedSessionIds: this.#store.pinnedSessionIds(),
				project,
			};
		});
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
		return this.#withWorkspace(() => this.#openProject(input));
	}

	/**
	 * 原生选择并登记项目，不打开 Core、不激活历史、不打断运行。
	 * @returns canonical 项目引用与最近项目；用户取消时返回 null，状态不变。
	 * @throws DesktopWorkspaceError 选择无效目录或内部任务根时。
	 * @example const selection = await host.selectProjectDialog();
	 */
	async selectProjectDialog(): Promise<ProjectSelection | null> {
		const result = await showOpenDialog(this.#getWindow(), {
			title: "选择项目",
			properties: ["openDirectory"],
		});
		const input = result.filePaths[0];
		if (result.canceled || input === undefined) return null;
		const root = await assertProjectDirectory(input, this.#taskRoot);
		await this.#rememberProject(root);
		return { project: { root, name: basename(root) }, recentProjects: this.#recentProjects() };
	}

	/**
	 * 在用户原生选择的父目录中新建文件夹并登记；不覆盖、不初始化 Git、不切 Core。
	 * @param name 单段项目名称，非法名称在弹出对话框前拒绝。
	 * @returns 新项目引用及最近项目；取消返回 null 且不创建目录。
	 * @throws DesktopWorkspaceError 名称非法、已有同名路径或目录无法访问时。
	 * @example const selection = await host.createProjectDialog("my-project");
	 */
	async createProjectDialog(name: string): Promise<ProjectSelection | null> {
		validateProjectName(name);
		const result = await showOpenDialog(this.#getWindow(), {
			title: "选择新项目的父目录",
			properties: ["openDirectory"],
		});
		const parent = result.filePaths[0];
		if (result.canceled || parent === undefined) return null;
		const root = await createProjectDirectory(parent, name, this.#taskRoot);
		await this.#rememberProject(root);
		return { project: { root, name: basename(root) }, recentProjects: this.#recentProjects() };
	}

	/**
	 * 准备草稿的明确执行根，不恢复或创建会话；同根保留现有运行/队列。
	 * @param target tasks 使用内部稳定目录，project 使用经校验的明确 root。
	 * @returns 目标工作区的信任、模型和完整快照，供首次发送检查。
	 * @throws DesktopWorkspaceError 跨根时有运行/队列（workspace-busy）或目录无效时。
	 * @example const project = await host.prepareWorkspace({ kind: "tasks" });
	 */
	async prepareWorkspace(target: WorkspaceTarget): Promise<ProjectSnapshot> {
		return this.#withWorkspace(() => this.#prepareWorkspace(target));
	}

	/**
	 * 查询已登记项目的本地分支；非 Git 仓库返回空列表。
	 * @param root 最近项目中的目录，不接受任意路径或任务根。
	 * @returns 分支名与当前分支；detached HEAD 时 current 缺省。
	 * @throws DesktopWorkspaceError 目录未登记或不可访问时。
	 * @example const { branches, current } = await host.gitBranches(project.root);
	 */
	async gitBranches(root: string): Promise<GitBranches> {
		const projectRoot = await this.#knownProjectRoot(root);
		return listGitBranches(projectRoot);
	}

	/**
	 * 首次发送前切换分支；同一工作区正在运行任务时拒绝，避免改动执行中的目录。
	 * @param root 最近项目中的目录。
	 * @param branch 分支选择器提供的本地分支名，必须仍存在于 refs/heads。
	 * @returns 切换到的分支。
	 * @throws DesktopWorkspaceError 目录未登记或工作区忙时；DesktopGitError 脏工作区或切换失败时。
	 * @example await host.checkoutBranch(project.root, "feature/login");
	 */
	async checkoutBranch(root: string, branch: string): Promise<GitCheckoutResult> {
		const projectRoot = await this.#knownProjectRoot(root);
		// 分支切换会改写该工作区的文件树：只要这个根里有任务在跑（无论是否正在查看它）就拒绝
		if (this.#hasWorkInRoot(projectRoot)) {
			throw new DesktopWorkspaceError("workspace-busy", "当前工作区正在执行任务，暂时无法切换分支");
		}
		return checkoutGitBranch(projectRoot, branch);
	}

	/** 分支接口只接受已登记为最近项目的目录，防止渲染层传入任意路径。 */
	async #knownProjectRoot(input: string): Promise<string> {
		let root: string;
		try {
			root = await assertWorkspaceRoot(input);
		} catch (error) {
			throw new DesktopWorkspaceError("invalid-project", "项目目录不可访问", { cause: error });
		}
		const known = this.#store
			.recentProjects()
			.some((project) => normalizeProjectRoot(project.root) === normalizeProjectRoot(root));
		if (!known) throw new DesktopWorkspaceError("invalid-project", "项目尚未登记，请重新选择");
		return root;
	}

	/**
	 * 在系统文件管理器中打开已登记项目目录；不切换执行工作区。
	 * @param root 最近项目中的目录，不接受任意路径或任务根。
	 * @throws DesktopWorkspaceError 目录未登记或打开失败时。
	 */
	async openProjectFolder(root: string): Promise<void> {
		const projectRoot = await this.#knownProjectRoot(root);
		const failure = await shell.openPath(projectRoot);
		if (failure.length > 0) throw new DesktopWorkspaceError("open-folder-failed", "无法打开项目文件夹");
	}

	/** 在已登记项目根目录打开系统终端；子进程独立运行，不阻塞主进程。 */
	async openTerminal(root: string): Promise<void> {
		const projectRoot = await this.#knownProjectRoot(root);
		const platform = process.platform;
		let command: string;
		let args: string[];
		if (platform === "win32") {
			command = "cmd.exe";
			args = ["/K", `cd /d "${projectRoot}"`];
		} else if (platform === "darwin") {
			command = "open";
			args = ["-a", "Terminal", projectRoot];
		} else {
			command = "xdg-open";
			args = [projectRoot];
		}
		const child = spawn(command, args, { cwd: projectRoot, detached: true, windowsHide: false, stdio: "ignore" });
		child.on("error", () => {
			// 终端启动失败只记录诊断，不阻断 UI（已通过 #knownProjectRoot 校验路径合法）。
			console.warn(`[moros] 无法打开终端: ${command}`);
		});
		child.unref();
	}

	/** 复制已登记项目的规范路径到剪贴板；不切换执行工作区。 */
	async copyProjectPath(root: string): Promise<void> {
		const projectRoot = await this.#knownProjectRoot(root);
		clipboard.writeText(projectRoot);
	}

	/**
	 * 从最近项目列表移除；不删除目录或会话，也不允许移除当前正在使用的项目。
	 * @param root 最近项目中的目录；允许目录已失效，以便清理陈旧记录。
	 * @returns 更新后的最近项目列表。
	 * @throws DesktopWorkspaceError 未登记或为当前工作区时。
	 */
	async forgetProject(root: string): Promise<readonly RecentProject[]> {
		const matching = this.#store
			.recentProjects()
			.find((project) => normalizeProjectRoot(project.root) === normalizeProjectRoot(root));
		if (matching === undefined) throw new DesktopWorkspaceError("invalid-project", "项目尚未登记");
		const active = this.#projectRoot;
		if (active !== undefined && normalizeProjectRoot(active) === normalizeProjectRoot(matching.root)) {
			throw new DesktopWorkspaceError("project-active", "当前项目无法从侧栏移除");
		}
		await this.#store.forgetProject(matching.root);
		return this.#recentProjects();
	}

	async projectSnapshot(): Promise<ProjectSnapshot> {
		return this.#projectSnapshot(this.#current);
	}

	async listSessions(query: SessionListQuery): Promise<SessionPage> {
		const core = this.#requiredCore();
		const root = query.target === undefined ? this.#requiredProject() : await this.#resolveTarget(query.target);
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

	/**
	 * 在 input.target 下创建会话并应用会话级草稿选项，不修改全局默认配置。
	 * @param input 必填 target；可覆盖模型、推理强度、审批和计划模式。
	 * @returns 同一执行根的 ProjectSnapshot 与 SessionView。
	 * @throws 目标无效、工作区忙或选项失败时；失败的新会话会删除并释放租约。
	 * @example const context = await host.createSession({ target: { kind: "tasks" }, plan: true });
	 */
	async createSession(input: SessionCreateInput): Promise<SessionContext> {
		return this.#withWorkspace(() => this.#createSession(input));
	}

	/**
	 * 按持久化会话归属跨根激活；只有此入口可改变归属，其他会话动作仍受当前根校验。
	 * @param id 已存在会话的 ID（或 Core 支持的唯一前缀）。
	 * @returns 正确工作区与会话；租约冲突沿用只读行为。
	 * @throws 会话/根无效，或跨根时另一任务仍在运行（workspace-busy）。
	 * @example const context = await host.activateSession(sessionId);
	 */
	async activateSession(id: string): Promise<SessionContext> {
		return this.#withWorkspace(() => this.#activateSession(id));
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
		return this.#withWorkspace(() => this.#deleteSessions(ids));
	}

	async #deleteSessions(
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
		const deletedSet = new Set(result.deleted);
		if (deletedSet.size > 0) await this.#store.unpinSessions(result.deleted);
		const currentId = this.#current?.meta.id;
		const clearedId = currentId !== undefined && deletedSet.has(currentId) ? currentId : undefined;
		for (const id of result.deleted) {
			this.#queues.delete(id);
			this.#sessions.delete(id);
			this.#readOnlyIds.delete(id);
			this.#createdSessionIds.delete(id);
			this.#live.delete(id);
			this.#dropSubscription(id);
			this.#pushQueue(id);
			if (this.#current?.meta.id === id) this.#current = undefined;
		}
		await this.#refreshMetas();
		this.#push({ type: "sessions-changed" });
		if (deletedSet.size > 0) this.#push({ type: "session-pins", ids: this.#store.pinnedSessionIds() });
		if (clearedId !== undefined) {
			const latest = this.#metas.filter((meta) => !meta.archived).at(-1);
			if (latest !== undefined) {
				await this.#activateSession(latest.id);
			} else {
				this.#push({ type: "session-cleared", sessionId: clearedId });
			}
		}
		return { deleted: result.deleted, failed: [...rejected, ...result.failed] };
	}

	/**
	 * 明确目标根内的重命名；不切换工作区，目标须与会话归属一致。
	 */
	async renameSessionInTarget(id: string, title: string, target: WorkspaceTarget): Promise<void> {
		const session = await this.#sessionForTarget(id, target);
		await this.#requiredCore().renameSession(session, title);
		await this.#refreshMetas();
		this.#pushMeta(id);
		this.#push({ type: "sessions-changed" });
		await this.#pushViewIfCurrent(id);
	}

	/** 明确目标根内的归档/取消归档；不切换工作区。 */
	async archiveSessionInTarget(id: string, archived: boolean, target: WorkspaceTarget): Promise<void> {
		const session = await this.#sessionForTarget(id, target);
		await this.#requiredCore().archiveSession(session, archived);
		await this.#refreshMetas();
		this.#pushMeta(id);
		this.#push({ type: "sessions-changed" });
		await this.#pushViewIfCurrent(id);
	}

	/**
	 * 明确目标根内的批量删除；当前根沿用现有会话回退，其它根只清理缓存。
	 */
	async deleteSessionsInTarget(
		ids: readonly string[],
		target: WorkspaceTarget,
	): Promise<{ deleted: readonly string[]; failed: readonly { id: string; error: string }[] }> {
		const targetRoot = await this.#resolveTarget(target);
		const isCurrent =
			this.#projectRoot !== undefined && normalizeProjectRoot(this.#projectRoot) === normalizeProjectRoot(targetRoot);
		if (isCurrent) return this.#withWorkspace(() => this.#deleteSessions(ids));

		const allowed: string[] = [];
		const rejected: { id: string; error: string }[] = [];
		for (const id of ids) {
			try {
				const session = await this.#sessionForTarget(id, target);
				if (this.#hasPendingWork(session.meta.id)) {
					throw new Error("Session is running or has queued messages");
				}
				allowed.push(id);
			} catch (error) {
				rejected.push({ id, error: messageOf(error) });
			}
		}
		const result = await this.#requiredCore().deleteSessions(allowed);
		const deleted = new Set(result.deleted);
		if (deleted.size > 0) await this.#store.unpinSessions(result.deleted);
		for (const id of result.deleted) {
			this.#sessions.delete(id);
			this.#readOnlyIds.delete(id);
			this.#createdSessionIds.delete(id);
			this.#live.delete(id);
			this.#dropSubscription(id);
		}
		await this.#refreshMetas();
		this.#push({ type: "sessions-changed" });
		if (deleted.size > 0) {
			const pins = this.#store.pinnedSessionIds();
			this.#push({ type: "session-pins", ids: pins });
		}
		return { deleted: result.deleted, failed: [...rejected, ...result.failed] };
	}

	/** 设置或取消侧栏置顶；只接受完整会话 ID，不切换工作区。 */
	async pinSession(id: string, pinned: boolean): Promise<readonly string[]> {
		const session = await this.#requiredCore().openSession(id);
		if (session.meta.id !== id) throw new Error("A full session ID is required");
		const ids = await this.#store.setPinned(id, pinned);
		this.#push({ type: "session-pins", ids });
		return ids;
	}

	/**
	 * 按明确目标根解析会话，并校验归属一致；不依赖当前工作区。
	 */
	async #sessionForTarget(id: string, target: WorkspaceTarget): Promise<Session> {
		const core = this.#requiredCore();
		const targetRoot = await this.#resolveTarget(target);
		const session = await core.openSession(id);
		if (normalizeProjectRoot(session.meta.projectRoot) !== normalizeProjectRoot(targetRoot)) {
			throw new Error("Session does not belong to the requested target");
		}
		this.#sessions.set(session.meta.id, session);
		return session;
	}

	async forkSession(id: string, uptoSeq?: number): Promise<SessionView> {
		const core = this.#requiredCore();
		if (this.#hasPendingWork(id)) throw new Error("A turn is running in this session");
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

	/**
	 * 对某条 llm.response 事件写入点赞/点踩反馈。
	 * 先校验 targetSeq 确实指向一条 llm.response，避免渲染层伪造反馈到任意事件。
	 */
	async messageFeedback(sessionId: string, targetSeq: number, rating: "up" | "down" | "none"): Promise<void> {
		const core = this.#requiredCore();
		const session = await this.#sessionFor(sessionId);
		const events = await core.readEvents(session);
		const target = events.find((event) => event.seq === targetSeq);
		if (target?.type !== "llm.response") throw new Error(`Feedback target is not a response: ${targetSeq}`);
		await session.append({ type: "message.feedback", payload: { targetSeq, rating } });
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

	/** 会话级净变更统计（按文件去重），供对话区摘要条展示。 */
	async changeStats(id: string): Promise<ChangeStats> {
		return this.#requiredCore().changeStats(id);
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
		const session = this.#requireCurrent();
		if (this.#hasPendingWork(session.meta.id)) throw new Error("A turn is running; wait for it to finish");
		await core.rollbackStep(session);
		await this.#pushViewIfCurrent(session.meta.id);
	}

	/** 撤销本次会话的全部文件改动（整任务回滚）。 */
	async rollbackTask(): Promise<void> {
		const core = this.#requiredCore();
		const session = this.#requireCurrent();
		if (this.#hasPendingWork(session.meta.id)) throw new Error("A turn is running; wait for it to finish");
		await core.rollbackTask(session);
		await this.#pushViewIfCurrent(session.meta.id);
	}

	async restoreCheckpoint(id: string): Promise<{ restored: number; removed: number }> {
		const core = this.#requiredCore();
		const session = this.#requireCurrent();
		if (this.#hasPendingWork(session.meta.id)) throw new Error("A turn is running; wait for it to finish");
		const result = await core.restoreCheckpoint(session, id);
		await this.#pushViewIfCurrent(session.meta.id);
		return result;
	}

	async compactSession(): Promise<{ compacted: boolean; covered: number; tokensBefore: number; tokensAfter: number }> {
		const core = this.#requiredCore();
		const session = this.#requireCurrent();
		if (this.#hasPendingWork(session.meta.id)) throw new Error("A turn is already running");
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
		if (this.#reviewing) throw new Error("A review is already running");
		if (this.#reviewing) throw new Error("A review is already running");
		this.#reviewing = true;
		const runId = randomUUID();
		const sessionId = this.#current?.meta.id ?? "";
		this.#push({ type: "review", sessionId, runId, state: "running" });
		try {
			const result = await core.reviewSession(root, prompt, {
				...(normalizeProjectRoot(root) === normalizeProjectRoot(this.#taskRoot) ? { internalWorkspace: true } : {}),
			});
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
		return this.#withWorkspace(() => this.#send(input));
	}

	async #send(input: ChatSendInput): Promise<ChatSendResult> {
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
		this.#prunePreparedImages();
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
		// 会话是并发的最小单位：同会话排队串行，不同会话立即并行启动
		const queued = this.#runs.has(session.meta.id) || this.#starting.has(session.meta.id);
		if (queued) {
			const entries = this.#queues.get(session.meta.id) ?? [];
			if (entries.length >= MAX_QUEUE) throw new Error(`Queue is full (${MAX_QUEUE})`);
			this.#enqueueQueue(entry);
			this.#pushQueue(session.meta.id);
		} else {
			await this.#startRun(entry);
		}
		for (const id of imageIds) this.#preparedImages.delete(id);
		return { queued };
	}

	abort(): void {
		// 停止按钮属于当前会话：并行多任务时只停当前会话的回合，不影响其他会话
		const sessionId = this.#current?.meta.id;
		if (sessionId === undefined) return;
		const run = this.#runs.get(sessionId);
		if (run === undefined) return;
		run.controller.abort(new Error("Stopped by user"));
		try {
			this.#requiredCore().abortSession(sessionId, "user");
		} catch {
			// 外部 signal 已经能停掉这一轮；Loop 已收尾时没有可中止对象。
		}
	}

	pause(): void {
		const sessionId = this.#current?.meta.id;
		const run = sessionId === undefined ? undefined : this.#runs.get(sessionId);
		if (sessionId === undefined || run === undefined) throw new Error("No turn is running");
		this.#requiredCore().pauseSession(sessionId);
		run.paused = true;
		this.#push({ type: "run", sessionId, runId: run.runId, state: "paused" });
	}

	resume(): void {
		const sessionId = this.#current?.meta.id;
		const run = sessionId === undefined ? undefined : this.#runs.get(sessionId);
		if (sessionId === undefined || run === undefined) throw new Error("No turn is running");
		this.#requiredCore().resumeSession(sessionId);
		run.paused = false;
		this.#push({ type: "run", sessionId, runId: run.runId, state: "running" });
	}

	liveState(sessionId?: string): ChatLiveResult {
		const id = sessionId ?? this.#requireCurrent().meta.id;
		return {
			sessionId: id,
			live: this.#liveState(id),
			queued: (this.#queues.get(id) ?? []).map(toQueuedMessage),
		};
	}

	clearQueue(): void {
		const affected = [...this.#queues.keys()];
		this.#queues.clear();
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

	async renameProvider(from: string, to: string): Promise<SettingsSnapshot> {
		const snapshot = await this.#requiredCore().renameProvider(from, to);
		await this.#refreshCatalog();
		await this.#pushViewIfCurrent(this.#current?.meta.id);
		return snapshot;
	}

	async revealSecret(name: string): Promise<string> {
		return this.#requiredCore().revealProviderSecret(name);
	}

	async discoverModels(input: DiscoverModelsRequest): Promise<readonly DiscoveredModel[]> {
		return this.#requiredCore().discoverModels(input);
	}

	async testModel(input: TestModelRequest): Promise<TestModelResult> {
		return this.#requiredCore().testModel(input);
	}

	async lookupModelMetadata(id: string): Promise<CatalogModelMetadata | null> {
		return this.#requiredCore().lookupModelMetadata(id);
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
		const previous = await core.getSelectedModel(session);
		// 只改当前会话的进程内选择；不动全局默认，避免一个会话的切换扩散到所有会话。
		await core.selectModel(session, provider, model);
		const next = { provider, model };
		const changed = previous === undefined || previous.provider !== provider || previous.model !== model;
		if (changed) {
			// 运行中切换的模型在下一轮才生效；标记该事件以便分隔线延后到下一轮显示。
			const appliesNextTurn = this.#hasPendingWork(session.meta.id);
			await session.append({
				type: "model.changed",
				payload: {
					from: previous === undefined ? "默认模型" : this.#modelLabel(catalog, previous),
					to: this.#modelLabel(catalog, next),
					fromModel: previous === undefined ? "" : `${previous.provider}/${previous.model}`,
					toModel: `${provider}/${model}`,
					appliesNextTurn,
				},
			});
		}
		await this.#refreshCatalog();
		await this.#pushViewIfCurrent(session.meta.id);
	}

	/** 在模型目录中解析模型显示名：优先 name，无则回退模型 ID。 */
	#modelLabel(catalog: ModelCatalog, ref: { provider: string; model: string }): string {
		return (
			catalog.providers.find((entry) => entry.name === ref.provider)?.models.find((entry) => entry.id === ref.model)
				?.name ?? ref.model
		);
	}

	async selectEffort(effort: ReasoningEffort): Promise<void> {
		const core = this.#requiredCore();
		const session = this.#requireCurrent();
		// 同 selectModel：推理强度仅覆盖当前会话，全局默认由配置文件/设置管理。
		core.selectEffort(session, effort);
		await this.#pushViewIfCurrent(session.meta.id);
	}

	async selectApproval(mode: ApprovalMode): Promise<void> {
		const core = this.#requiredCore();
		const session = this.#requireCurrent();
		const sessionId = session.meta.id;
		core.setSessionApproval(session, mode);
		// 切到完全访问：即时放行当前会话挂起的审批卡，避免它继续阻塞运行；
		// 后续工具调用已由 setPolicy 切到 yolo，不再弹卡。
		if (mode === "yolo") this.#broker.allowSession(sessionId);
		await this.#pushViewIfCurrent(sessionId);
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

	/**
	 * 新增或更新用户技能：path 省略时新建（draft.name 为目录名），传入时更新该路径的技能。
	 * 写操作前检查工作区是否有回合在飞，避免运行中技能清单变化。
	 */
	async upsertSkill(draft: SkillDraftInput, path?: string): Promise<SkillSummary> {
		this.#assertNoPendingWork();
		const core = this.#requiredCore();
		return path === undefined
			? core.createSkill(draft.name, { description: draft.description, body: draft.body })
			: core.updateSkill(path, { description: draft.description, body: draft.body });
	}

	async removeSkill(path: string): Promise<void> {
		this.#assertNoPendingWork();
		await this.#requiredCore().deleteSkill(path);
	}

	async skillDetail(path: string): Promise<SkillDocumentResult> {
		return this.#requiredCore().getSkillDocument(path);
	}

	/** 弹出原生目录选择器，把选中的技能目录导入 ~/.moros/skills；取消返回 null。 */
	async importSkill(): Promise<SkillSummary | null> {
		this.#assertNoPendingWork();
		const result = await showOpenDialog(this.#getWindow(), {
			title: "选择技能目录（需含 SKILL.md）",
			properties: ["openDirectory"],
		});
		if (result.canceled || result.filePaths[0] === undefined) return null;
		return this.#requiredCore().importSkill(result.filePaths[0]);
	}

	async trustAccept(remember: boolean): Promise<WorkspaceTrustView> {
		const core = this.#requiredCore();
		const root = this.#requiredProject();
		await core.acceptWorkspaceTrust(root, remember);
		try {
			await core.prepareMcp(root);
		} catch (error) {
			console.warn(`[moros] Could not start MCP servers: ${messageOf(error)}`);
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

	/** 当前工作区是否有回合在飞；有则拒绝改 MCP/Skills 配置，避免运行中能力面不一致。 */
	#assertNoPendingWork(): void {
		const root = this.#requiredProject();
		if (this.#hasWorkInRoot(root))
			throw new Error("A turn is running; wait for it to finish before changing MCP servers or skills");
	}

	async upsertMcpServer(name: string, draft: McpServerDraftInput): Promise<McpServerDetail> {
		this.#assertNoPendingWork();
		const core = this.#requiredCore();
		const config = await core.upsertMcpServer(this.#requiredProject(), name, draft);
		await this.#refreshCatalog();
		await this.#pushViewIfCurrent(this.#current?.meta.id);
		// 详情只回填表单暴露的字段；高级项由 writer 编辑时原位保留。
		return config.type === "stdio"
			? { name: config.name, type: "stdio", command: config.command ?? "", args: config.args, env: config.env }
			: { name: config.name, type: config.type, url: config.url ?? "", headers: config.headers };
	}

	async removeMcpServer(name: string): Promise<void> {
		this.#assertNoPendingWork();
		await this.#requiredCore().removeMcpServer(this.#requiredProject(), name);
		await this.#refreshCatalog();
		await this.#pushViewIfCurrent(this.#current?.meta.id);
	}

	async reloadMcp(): Promise<void> {
		this.#assertNoPendingWork();
		await this.#requiredCore().reloadMcp(this.#requiredProject());
		await this.#refreshCatalog();
		await this.#pushViewIfCurrent(this.#current?.meta.id);
	}

	async mcpServerDetail(name: string): Promise<McpServerDetail | null> {
		// 配置完整字段只在 core 内存里；通过 configSummary 只能拿到 name/type/enabled。
		// 为避免在 host 里重复解析 TOML，detail 只回填已知基础信息，表单未覆盖的高级项
		// 由 core writer 在 upsert 时原位保留（见 updateGlobalMcpServers）。
		const summary = await this.configSummary();
		const entry = summary.mcpServers.find((server) => server.name === name);
		if (entry === undefined) return null;
		return entry.type === "stdio"
			? { name, type: "stdio", command: "" }
			: { name, type: entry.type === "sse" ? "sse" : "http", url: "" };
	}

	async prepareImageFromDialog(): Promise<PreparedImage | null> {
		const window = this.#getWindow();
		const result = await showOpenDialog(window, {
			title: "附加图片",
			properties: ["openFile"],
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
		for (const run of this.#runs.values()) run.controller.abort(new Error("Application is shutting down"));
		try {
			await this.#workspaceOperation;
			await this.#teardownProject();
		} finally {
			// 草稿附件跨工作区保留，但最终退出不能继续占用主进程内存。
			this.#preparedImages.clear();
		}
	}

	// 工作区切换与发送准备按顺序执行；等待的是创建/租约/信任检查，不是后台整轮任务。
	/** 该会话是否有在飞、正在启动或排队的工作。 */
	#hasPendingWork(sessionId: string): boolean {
		return this.#runs.has(sessionId) || this.#starting.has(sessionId) || (this.#queues.get(sessionId)?.length ?? 0) > 0;
	}

	/** 某个工作区是否有在飞、正在启动或排队的任务（按会话归属的 projectRoot 判定）。 */
	#hasWorkInRoot(root: string): boolean {
		const normalized = normalizeProjectRoot(root);
		const inRoot = (sessionId: string): boolean => {
			const session = this.#sessions.get(sessionId);
			return session !== undefined && normalizeProjectRoot(session.meta.projectRoot) === normalized;
		};
		return (
			[...this.#runs.keys()].some(inRoot) ||
			[...this.#starting].some(inRoot) ||
			[...this.#queues.entries()].some(([sessionId, entries]) => inRoot(sessionId) && entries.length > 0)
		);
	}

	#enqueueQueue(entry: QueuedEntry): void {
		const entries = this.#queues.get(entry.sessionId) ?? [];
		entries.push(entry);
		this.#queues.set(entry.sessionId, entries);
	}

	#takeQueue(sessionId: string): QueuedEntry | undefined {
		const entries = this.#queues.get(sessionId);
		const next = entries?.shift();
		if (entries !== undefined && entries.length === 0) this.#queues.delete(sessionId);
		return next;
	}

	#withWorkspace<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.#workspaceOperation.then(() => {
			if (this.#disposed) throw new Error("Application is shutting down");
			return operation();
		});
		// 失败仍由 result 返回给调用方；队尾恢复可用，后续请求才能重试。
		this.#workspaceOperation = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	#recentProjects(): readonly RecentProject[] {
		return this.#store
			.recentProjects()
			.filter((project) => normalizeProjectRoot(project.root) !== normalizeProjectRoot(this.#taskRoot));
	}

	async #rememberProject(root: string): Promise<void> {
		if (normalizeProjectRoot(root) === normalizeProjectRoot(this.#taskRoot)) return;
		await this.#store.rememberProject(root).catch((error: unknown) => {
			console.warn(`[moros] Could not save the recent project list: ${messageOf(error)}`);
		});
	}

	async #resolveTarget(target: WorkspaceTarget): Promise<string> {
		if (target.kind === "project") return assertProjectDirectory(target.root, this.#taskRoot);
		try {
			const root = await assertWorkspaceRoot(this.#taskRoot);
			if (normalizeProjectRoot(root) !== normalizeProjectRoot(this.#taskRoot)) {
				throw new Error("The tasks workspace directory changed");
			}
			return root;
		} catch (error) {
			throw new DesktopWorkspaceError("task-workspace-error", "The default tasks workspace is not accessible", {
				cause: error,
			});
		}
	}

	async #openProject(input: string): Promise<ProjectSnapshot> {
		const root = await assertProjectDirectory(input, this.#taskRoot);
		const previousRoot = this.#projectRoot;
		if (!(await this.#switchWorkspace(root))) return this.projectSnapshot();
		try {
			await this.#rememberProject(root);
			const page = await this.#requiredCore().listSessionsPage(root, { limit: 1, includeArchived: false });
			const latest = page.items[0];
			if (latest !== undefined) return (await this.#activateSession(latest.id)).project;
			return await this.projectSnapshot();
		} catch (error) {
			// 打开失败把视图退回原工作区；Core 与后台任务不动（不回滚也不销毁）。
			if (previousRoot !== undefined && normalizeProjectRoot(previousRoot) !== normalizeProjectRoot(root)) {
				await this.#switchWorkspace(previousRoot).catch(() => undefined);
			}
			throw error;
		}
	}

	async #prepareWorkspace(target: WorkspaceTarget): Promise<ProjectSnapshot> {
		const root = await this.#resolveTarget(target);
		await this.#switchWorkspace(root);
		await this.#rememberProject(root);
		return this.projectSnapshot();
	}

	/**
	 * 切换「正在查看的工作区」。Core 全程复用：会话自带 projectRoot，租约、沙箱与 MCP
	 * 都按会话走，运行中的任务在后台继续并行——切换只影响视图、watcher 与列表过滤，
	 * 不再销毁运行时（对齐 DSH per-session cwd / ZCode 多 app-server 的隔离模型）。
	 * @returns 是否发生了切换（同根幂等返回 false）。
	 */
	async #switchWorkspace(root: string): Promise<boolean> {
		if (
			this.#core !== undefined &&
			this.#projectRoot !== undefined &&
			normalizeProjectRoot(this.#projectRoot) === normalizeProjectRoot(root)
		) {
			return false;
		}
		this.#watcher?.close();
		this.#watcher = undefined;
		const previousRoot = this.#projectRoot;
		this.#projectRoot = root;
		this.#warnings = [];
		// 跨根切换时清掉属于旧根的当前会话；后台运行不受影响
		if (
			this.#current !== undefined &&
			normalizeProjectRoot(this.#current.meta.projectRoot) !== normalizeProjectRoot(root)
		) {
			this.#current = undefined;
		}
		// 旧根里空闲会话的租约随视图切换释放；运行中/排队的保留（任务在后台继续）
		if (previousRoot !== undefined) {
			const normalizedPrevious = normalizeProjectRoot(previousRoot);
			for (const [id, session] of this.#sessions) {
				if (normalizeProjectRoot(session.meta.projectRoot) !== normalizedPrevious) continue;
				if (this.#hasPendingWork(id)) continue;
				if (this.#core?.hasSessionLease(id) === true) await this.#core.releaseSessionLease(id);
			}
		}
		if (this.#core === undefined) {
			this.#core = new Core({
				requestApproval: (request, sessionId, signal) => this.#requestApproval(request, sessionId, signal),
				onWarning: (message) => {
					this.#warnings = [...this.#warnings.slice(-(MAX_WARNINGS - 1)), message];
					const sessionId = this.#current?.meta.id;
					if (sessionId !== undefined) this.#inlineNotice(sessionId, "warn", message);
				},
				hostKind: "desktop",
				...(this.#homeDir === undefined ? {} : { homeDir: this.#homeDir }),
			});
		}
		this.#startWatcher(root);
		try {
			await this.#requiredCore().prepareMcp(root);
		} catch (error) {
			console.warn(`[moros] Could not start MCP servers: ${messageOf(error)}`);
		}
		await this.#refreshMetas();
		await this.#refreshCatalog();
		return true;
	}

	async #projectSnapshot(current: Session | undefined): Promise<ProjectSnapshot> {
		const core = this.#requiredCore();
		const root = this.#requiredProject();
		const trust = await this.#readTrust();
		const models = await core.listModels(root).catch(() => this.#catalog);
		this.#catalog = models;
		const skills = await core.listSkills(root).catch(() => []);
		const mcp = core.mcpStatus(root);
		const session = current === undefined ? undefined : await this.#buildView(current);
		const target: WorkspaceTarget =
			normalizeProjectRoot(root) === normalizeProjectRoot(this.#taskRoot)
				? { kind: "tasks" }
				: { kind: "project", root };
		return {
			root,
			name: basename(root),
			target,
			recentProjects: this.#recentProjects(),
			trust,
			models,
			skills,
			mcp,
			warnings: [...this.#warnings],
			...(session === undefined ? {} : { session }),
		};
	}

	async #sessionContext(session: Session): Promise<SessionContext> {
		const project = await this.#projectSnapshot(undefined);
		const view = await this.#buildView(session);
		return { project: { ...project, session: view }, session: view };
	}

	async #createSession(input: SessionCreateInput): Promise<SessionContext> {
		const root = await this.#resolveTarget(input.target);
		await this.#switchWorkspace(root);
		await this.#rememberProject(root);
		const core = this.#requiredCore();
		const previous = this.#current;
		const session = await core.createSession(root);
		const id = session.meta.id;
		this.#createdSessionIds.add(id);
		try {
			await core.acquireSessionLease(session);
			if (input.model !== undefined) await core.selectModel(session, input.model.provider, input.model.model);
			if (input.effort !== undefined) core.selectEffort(session, input.effort);
			if (input.approval !== undefined) core.setSessionApproval(session, input.approval);
			if (input.plan !== undefined) core.setSessionPlan(session, input.plan);
			await this.#refreshMetas();
			// 选项及快照均成功后才提交当前会话，避免失败草稿顶掉原来会话。
			const context = await this.#sessionContext(session);
			if (previous !== undefined) {
				await this.#discardIfEmpty(previous.meta.id);
				await this.#releaseIfIdle(previous.meta.id);
				this.#dropSubscriptionIfIdle(previous.meta.id);
			}
			await this.#refreshMetas();
			this.#sessions.set(id, session);
			this.#current = session;
			this.#readOnlyIds.delete(id);
			this.#ensureSubscribed(session);
			this.#push({ type: "sessions-changed" });
			this.#push({ type: "project", project: context.project });
			this.#push({ type: "session-view", view: context.session });
			return context;
		} catch (error) {
			if (this.#current?.meta.id === id) {
				this.#current = previous !== undefined && this.#sessions.has(previous.meta.id) ? previous : undefined;
			}
			this.#sessions.delete(id);
			this.#readOnlyIds.delete(id);
			this.#dropSubscription(id);
			try {
				await core.deleteSession(id);
				this.#createdSessionIds.delete(id);
			} catch (cleanupError) {
				throw new AggregateError([error, cleanupError], "Could not clean up the failed new session");
			} finally {
				await core.releaseSessionLease(id);
			}
			await this.#refreshMetas().catch((refreshError: unknown) =>
				console.warn(`[moros] Could not refresh sessions: ${messageOf(refreshError)}`),
			);
			throw error;
		}
	}

	async #activateSession(id: string): Promise<SessionContext> {
		if (this.#current?.meta.id === id) {
			this.#assertSessionInProject(this.#current);
			return this.#sessionContext(this.#current);
		}
		// 只有显式激活可先读取持久化归属；切根后仍经 #sessionFor 做边界验证。
		const candidate = await this.#requiredCore().openSession(id);
		const root = await assertWorkspaceRoot(candidate.meta.projectRoot);
		if (normalizeProjectRoot(candidate.meta.projectRoot) !== normalizeProjectRoot(root)) {
			throw new DesktopWorkspaceError("invalid-project", "The session workspace directory changed");
		}
		await this.#switchWorkspace(root);
		await this.#rememberProject(root);
		const previous = this.#current;
		const session = await this.#sessionFor(candidate.meta.id);
		let context: SessionContext;
		try {
			await this.#acquireLease(session);
			context = await this.#sessionContext(session);
		} catch (error) {
			await this.#releaseIfIdle(session.meta.id);
			throw error;
		}
		if (previous !== undefined) {
			await this.#discardIfEmpty(previous.meta.id);
			await this.#releaseIfIdle(previous.meta.id);
			this.#dropSubscriptionIfIdle(previous.meta.id);
		}
		this.#current = session;
		this.#ensureSubscribed(session);
		this.#push({ type: "project", project: context.project });
		this.#push({ type: "session-view", view: context.session });
		return context;
	}

	async #teardownProject(): Promise<void> {
		this.#broker.denyAll();
		for (const run of this.#runs.values()) run.controller.abort(new Error("Project is closing"));
		const pendingRuns = [...this.#runPromises.values()];
		if (pendingRuns.length > 0) {
			await Promise.race([Promise.allSettled(pendingRuns), delay(3_000)]);
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
		this.#queues.clear();
		this.#runs.clear();
		this.#runPromises.clear();
		this.#starting.clear();
		this.#reviewing = false;
		this.#prunePreparedImages();
		this.#readOnlyIds.clear();
		try {
			if (this.#core !== undefined) {
				const core = this.#core;
				for (const id of [...this.#createdSessionIds]) {
					await core.discardEmptySession(id).catch((error: unknown) => {
						console.warn(`[moros] Could not clean up an empty session: ${messageOf(error)}`);
					});
				}
				await core.dispose();
			}
		} finally {
			this.#core = undefined;
			this.#projectRoot = undefined;
			this.#current = undefined;
			this.#sessions.clear();
			this.#createdSessionIds.clear();
			this.#metas = [];
			this.#catalog = { providers: [] };
			this.#viewVersion++;
		}
	}

	#startWatcher(root: string): void {
		this.#watcher?.close();
		this.#watcher = watchWorkspace(root, (paths) => this.#push({ type: "workspace", paths }), {
			onError: (error) => console.warn(`[moros] Workspace watcher failed: ${messageOf(error)}`),
		});
	}

	async #startRun(entry: QueuedEntry): Promise<void> {
		if (this.#disposed) return;
		const sessionId = entry.sessionId;
		this.#starting.add(sessionId);
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
			this.#runs.set(session.meta.id, {
				runId,
				sessionId: session.meta.id,
				controller,
				startedAt: live.startedAt,
				paused: false,
			});
			this.#push({ type: "run", sessionId: session.meta.id, runId, state: "running" });
			this.#pushQueue(session.meta.id);
			this.#runPromises.set(session.meta.id, this.#run(entry, session, runId, controller));
		} finally {
			this.#starting.delete(sessionId);
		}
	}

	async #run(entry: QueuedEntry, session: Session, runId: string, controller: AbortController): Promise<void> {
		const core = this.#requiredCore();
		const sessionId = session.meta.id;
		const live = this.#liveFor(sessionId);
		// 内部任务工作区的会话不向模型披露路径；项目会话照常注入 ## Workspace
		const isTaskSession = normalizeProjectRoot(session.meta.projectRoot) === normalizeProjectRoot(this.#taskRoot);
		let outcome: "ok" | "aborted" | "error" = "ok";
		try {
			await core.runSession(session, entry.text, {
				signal: controller.signal,
				...(isTaskSession ? { internalWorkspace: true } : {}),
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
				onWarning: (message) => this.#inlineNotice(sessionId, "warn", message),
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
			} else {
				outcome = "error";
				// run 错误由 state 的 run 分支写入对话内联提示，不再弹浮动提示。
				this.#push({
					type: "run",
					sessionId,
					runId,
					state: "error",
					error: messageOf(error),
				});
			}
		} finally {
			this.#flushSessionStreams(sessionId);
			if (this.#runs.get(sessionId)?.runId === runId) this.#runs.delete(sessionId);
			this.#runPromises.delete(sessionId);
			live.running = false;
			live.paused = false;
			live.text = "";
			live.reasoning = "";
			live.toolOutputs.clear();
			live.runId = undefined;
			live.startedAt = undefined;
			await this.#refreshMetas().catch((error: unknown) =>
				console.warn(`[moros] Could not refresh sessions: ${messageOf(error)}`),
			);
			this.#pushMeta(sessionId);
			await this.#pushViewIfCurrent(sessionId).catch(() => undefined);
			this.#pushQueue(sessionId);
			if (outcome !== "error") {
				this.#push({ type: "run", sessionId, runId, state: "idle" });
			}
			await this.#notifyRunFinished(sessionId, outcome === "error");
			void this.#drainQueue(sessionId);
		}
	}

	/** 只排空指定会话的队列：并行模型下每个会话独立续跑自己的排队消息。 */
	#drainQueue(sessionId: string): void {
		if (this.#disposed) return;
		const next = this.#takeQueue(sessionId);
		if (next === undefined) return;
		this.#pushQueue(sessionId);
		void this.#startRun(next).catch((error: unknown) => {
			this.#inlineNotice(sessionId, "error", messageOf(error));
			this.#pushQueue(sessionId);
			void this.#drainQueue(sessionId);
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

	/** 除显式激活先切工作区外，事件、导出与删除都不得跨出当前根边界。 */
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
				console.warn(`[moros] Session ${session.meta.id} is open in another window; this window is read-only.`);
				return;
			}
			throw error;
		}
	}

	async #releaseIfIdle(id: string): Promise<void> {
		if (this.#hasPendingWork(id)) return;
		const core = this.#core;
		if (core === undefined) return;
		if (core.hasSessionLease(id)) await core.releaseSessionLease(id);
	}

	async #discardIfEmpty(id: string): Promise<void> {
		if (!this.#createdSessionIds.has(id)) return;
		if (this.#hasPendingWork(id)) return;
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
			console.warn(`[moros] Could not clean up an empty session: ${messageOf(error)}`);
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
		if (this.#hasPendingWork(id)) return;
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

	#requestApproval(request: ApprovalRequest, sessionId: string, signal?: AbortSignal): Promise<ApprovalDecision> {
		const card = toApprovalCard(request, sessionId);
		this.#push({ type: "approval", card });
		return this.#broker.request(request, signal, sessionId).finally(() => {
			this.#push({ type: "approval-cleared", id: request.id });
		});
	}

	async #readTrust(): Promise<WorkspaceTrustView> {
		const core = this.#requiredCore();
		const root = this.#requiredProject();
		try {
			return await core.getWorkspaceTrust(root);
		} catch (error) {
			console.warn(`[moros] Could not read workspace trust: ${messageOf(error)}`);
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
			running: this.#runs.has(session.meta.id),
			...(model === undefined ? {} : { model }),
			effort: core.getSelectedEffort(session) ?? loaded.config.reasoningEffort,
			approval: core.getSelectedApproval(session) ?? loaded.config.approval,
			plan: core.isSessionPlan(session),
			metrics,
			live: this.#liveState(session.meta.id),
			queued: (this.#queues.get(session.meta.id) ?? []).length,
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
			console.warn(`[moros] Could not refresh session state: ${messageOf(error)}`);
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
			items: (this.#queues.get(sessionId) ?? []).map(toQueuedMessage),
		});
	}

	#rememberImage(image: SessionImageInput): PreparedImage {
		// 异步 URL/文件选择可能在 dispose 后才完成，不能重新填充已释放的池。
		if (this.#disposed) throw new Error("Application is shutting down");
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

	/** 会话级警告/错误写入对话流内联提示，不再弹浮动消息。 */
	#inlineNotice(sessionId: string, tone: "warn" | "error", text: string): void {
		this.#push({ type: "inline-notice", sessionId, tone, text });
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
