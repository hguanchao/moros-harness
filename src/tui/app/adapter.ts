import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";

import {
	imageByteLength,
	type Core,
	type ModelCatalog,
	type Session,
	type SessionImageInput,
	type SessionMeta,
	type SessionMetrics,
	type SkillSummary,
} from "#src/core/index.ts";
import { PAGE, UNTITLED_SESSION } from "#src/tui/app/copy/index.ts";
import { describeError } from "#src/tui/app/contract/describe-error.ts";
import { createEventStreamState, mapCoreEvent, toLlmStopReason } from "#src/tui/app/event-translation.ts";
import { formatBytes } from "#src/tui/app/contract/format.ts";
import { THINKING_LEVELS, type ApprovalMode, type ThinkingLevel } from "#src/tui/app/contract/config.ts";
import type { TuiHost } from "#src/tui/app/runtime/types.ts";
import { PLUGIN_COMMANDS } from "#src/tui/app/plugin-command-list.ts";
import type { ApprovalBroker as CompatApprovalBroker } from "#src/tui/app/contract/approval.ts";
import { asRecord } from "#src/tui/app/event-translation.ts";
import type { AgentEventListener } from "#src/tui/app/contract/events.ts";
import type { LlmMessage } from "#src/tui/app/contract/messages.ts";
import type { CheckpointEntry } from "#src/tui/app/contract/checkpoint.ts";
import type { ApprovalBroker } from "#src/tui/app/approval-broker.ts";
import type { CommandMenuItem } from "#src/tui/app/panel/command-menu.ts";
import type { ModelMenuItem } from "#src/tui/app/panel/model-menu.ts";
import { selectedModelLabel } from "#src/tui/app/model-display.ts";
import type { SessionMenuItem } from "#src/tui/app/panel/session-menu.ts";
import type { FooterInfo } from "#src/tui/app/widget/footer.ts";
import type { ImageAttachment, ImageSource } from "#src/tui/app/image.ts";
import type { TuiInput, TuiOptions, TuiOutput } from "#src/tui/app/options.ts";
import type { TranscriptPlan, TranscriptTurn } from "#src/tui/app/transcript/index.ts";
import type { TranscriptTodo } from "#src/tui/app/widget/todo-card.ts";
import { buildTranscriptHistory } from "#src/tui/app/transcript/history.ts";
import { runTui as runTerminalUi } from "#src/tui/app/layout.ts";
import { createWarningSink, type WarningSink } from "#src/tui/app/warning-sink.ts";
import { windowsClipboardWrite } from "#src/tui/app/clipboard-command.ts";

/** CLI 传入的启动参数；项目根不在此指定，由 cwd 或会话元数据推导，业务全部由 Core 提供。 */
export interface RunTuiOptions {
	readonly core: Core;
	readonly sessionId?: string;
	readonly approvals: ApprovalBroker;
	/**
	 * 与 Core 的 `onWarning` 共用的诊断接收端。
	 *
	 * 由宿主在构造 Core 时注入并传进来，界面装配后再绑定显示端；省略时 TUI 自建一个，
	 * 此时构造期产生的告警只在退出后回落到 stderr。
	 */
	readonly warnings?: WarningSink;
}

/**
 * TUI 退出后交还给宿主的结果。
 *
 * 只带宿主无法自行推导的信息：退出时仍在用的会话。新建后没有任何活动的空会话会在
 * 退出清理中删除，此时不提供 sessionId，宿主不应提示恢复。
 */
export interface RunTuiResult {
	/** 退出时所在的会话 ID；会话已被清理或不复存在时省略。 */
	readonly sessionId?: string;
}

/** 单个会话的历史缓存：对话流与最后一份未收尾任务表、计划卡。 */
interface SessionHistory {
	readonly turns: readonly TranscriptTurn[];
	readonly todo?: TranscriptTodo;
	readonly plan?: TranscriptPlan;
}

interface AdapterState {
	readonly core: Core;
	readonly projectRoot: string;
	readonly approvals: ApprovalBroker;
	/** 所有非致命诊断的唯一出口；不得再直接写 stderr 破坏备用屏帧。 */
	readonly warnings: WarningSink;
	readonly sessions: Map<string, Session>;
	readonly histories: Map<string, SessionHistory>;
	readonly imageInputs: Map<string, SessionImageInput>;
	/** 本次进程内新建的会话；退出时逐一检查并丢弃空会话。 */
	readonly createdSessionIds: Set<string>;
	/** host 装配完成后回填，用于触发会话切换等 UI 能力。 */
	host?: TuiHost;
	/** 当前会话是否处于暂停态；只用于 Ctrl+P 的切换方向。 */
	paused: boolean;
	/** 每个会话各自的模型/推理档位选择，切换会话时同步恢复页脚。 */
	readonly sessionSelections: Map<string, SessionSelection>;
	metas: SessionMeta[];
	currentSessionId: string;
	catalog: ModelCatalog;
	selectedModel: { readonly provider: string; readonly model: string } | undefined;
	config: Record<string, unknown>;
	configLoaded: boolean;
	/** 启动期累积的警告（配置跳过条目、恢复降级等）；进对话流顶部的启动警告区（ADR-15）。 */
	launchWarnings: string[];
	selectedEffort: ThinkingLevel;
	metrics: SessionMetrics;
	/** 启动时解析的工作区信任快照；授予/拒绝后刷新。 */
	trust: WorkspaceTrustSnapshot;
	/** 技能清单缓存：TUI 契约是同步接口，装配层在启动、信任变更与每轮结束后刷新。 */
	skills: readonly SkillSummary[];
}

/** 工作区信任快照；直接复用 Core 的返回类型，避免两处字段各写一遍。 */
type WorkspaceTrustSnapshot = Awaited<ReturnType<Core["getWorkspaceTrust"]>>;

/** 页脚指标初值；首次刷新前不显示虚假的用量。 */
const EMPTY_METRICS: SessionMetrics = {
	contextUsed: 0,
	cacheHitRate: 0,
	inputTokens: 0,
	outputTokens: 0,
	cacheReadTokens: 0,
	cacheWriteTokens: 0,
};

/** 用量统计口径在 Core；这里只把结果写进页脚状态，失败时明确告警而不静默吞错。 */
function refreshMetrics(state: AdapterState): void {
	const session = state.sessions.get(state.currentSessionId);
	if (!session) return;
	void state.core
		.getSessionMetrics(session)
		.then((metrics) => {
			state.metrics = metrics;
			// 指标是异步聚合的，完成后主动重绘一帧，页脚才不会停在旧值。
			state.host?.render();
		})
		.catch((error: unknown) => {
			state.warnings.emit(`Could not refresh session metrics: ${describeError(error)}`);
		});
}

/** 启动 TUI：装配终端界面所需的数据源，不承载任何业务逻辑。 */
export async function runTui(options: RunTuiOptions): Promise<RunTuiResult> {
	const { core, sessionId, approvals } = options;
	const warnings = options.warnings ?? createWarningSink();
	if (!process.stdin.isTTY || !process.stdout.isTTY) {
		throw new Error("Moros Harness TUI requires an interactive terminal (TTY).");
	}
	if (process.env.TERM === "dumb") {
		throw new Error("Moros Harness TUI does not support TERM=dumb.");
	}

	// 恢复失败不砖化启动（ADR-15）：损坏会话降级为新会话，原因进启动警告区
	const launchWarnings: string[] = [];
	let session: Session;
	let recoveredFrom: string | undefined;
	if (sessionId) {
		try {
			session = await core.openSession(sessionId);
		} catch (error) {
			recoveredFrom = sessionId;
			launchWarnings.push(
				`Could not open session ${sessionId} (${describeError(error)}); started a new session instead.`,
			);
			session = await core.createSession(resolve(process.cwd()), { mode: "creator" });
		}
	} else {
		session = await core.createSession(resolve(process.cwd()), { mode: "creator" });
	}
	// 当前会话在整个界面期内独占写入；被另一个窗口占用时降级为新会话，原因进启动警告区。
	try {
		await core.acquireSessionLease(session);
	} catch (error) {
		launchWarnings.push(`Session ${session.meta.id} is busy (${describeError(error)}); started a new session instead.`);
		session = await core.createSession(resolve(process.cwd()), { mode: "creator" });
		await core.acquireSessionLease(session);
	}
	// 项目根以会话元数据为准：恢复会话时不再沿用启动目录，避免 UI 与 Core 使用不同的根。
	const projectRoot = session.meta.projectRoot;
	const state: AdapterState = {
		core,
		projectRoot,
		approvals,
		warnings,
		sessions: new Map([[session.meta.id, session]]),
		histories: new Map(),
		imageInputs: new Map(),
		createdSessionIds: new Set(sessionId && !recoveredFrom ? [] : [session.meta.id]),
		sessionSelections: new Map(),
		paused: false,
		metas: [],
		currentSessionId: session.meta.id,
		catalog: { providers: [] },
		selectedModel: undefined,
		config: {},
		configLoaded: false,
		launchWarnings,
		selectedEffort: "off",
		metrics: EMPTY_METRICS,
		trust: { required: false, decision: true, files: [], skillDirectories: [] },
		skills: [],
	};
	// 工作区信任判断会读全局配置；配置损坏时它是最先抛出来的一个点。不能让它一路冒泡到
	// CLI 入口（那会在终端打印 Error 并直接退出），把原因记下来交给下面的配置状态统一处理。
	let startupError: string | undefined;
	try {
		state.trust = await state.core.getWorkspaceTrust(projectRoot);
	} catch (error) {
		startupError = describeError(error);
	}
	await refreshCatalog(state);
	if (startupError !== undefined) recordConfigProblem(state, startupError);
	try {
		await refreshSessions(state);
	} catch (error) {
		launchWarnings.push(`Could not list sessions: ${describeError(error)}`);
	}
	await discardStaleEmptySessions(state);
	await refreshSkills(state);
	// MCP 只读配置并后台连接，不阻塞界面启动；失败进启动警告区，不影响其它能力
	try {
		await state.core.prepareMcp(projectRoot);
	} catch (error) {
		launchWarnings.push(`Could not start MCP servers: ${describeError(error)}`);
	}
	refreshMetrics(state);
	const tuiOptions = buildTuiOptions(state, warnings);
	let exitCode = 0;
	let discarded: ReadonlySet<string> = new Set();
	try {
		exitCode = await runTerminalUi(tuiOptions);
	} finally {
		// 界面已退出备用屏，解绑后剩下的诊断可以安全回落；没有 UI 消费过的一条也不能丢。
		warnings.unbind();
		// 退出清理失败只告警，不覆盖界面的退出码；错误不静默吞掉。
		discarded = await discardUnusedSessions(state);
		// 先删空会话再释放租约：删除路径本身复用当前持有者身份。
		await state.core.releaseSessionLease(state.currentSessionId).catch((error: unknown) => {
			warnings.emit(`Could not release session lease: ${describeError(error)}`);
		});
		warnings.flush();
	}
	if (exitCode !== 0) process.exitCode = exitCode;
	return discarded.has(state.currentSessionId) ? {} : { sessionId: state.currentSessionId };
}

/** 会话内选择的展示快照；切换会话时用于恢复页脚。 */
interface SessionSelection {
	readonly model?: { readonly provider: string; readonly model: string };
	readonly effort: ThinkingLevel;
}

function configuredEffort(state: AdapterState): ThinkingLevel {
	const configured = state.config.reasoningEffort;
	return typeof configured === "string" && (THINKING_LEVELS as readonly string[]).includes(configured)
		? (configured as ThinkingLevel)
		: "off";
}

function recordSelection(state: AdapterState): void {
	state.sessionSelections.set(state.currentSessionId, {
		...(state.selectedModel ? { model: state.selectedModel } : {}),
		effort: state.selectedEffort,
	});
}

function restoreSelection(state: AdapterState, id: string): void {
	const saved = state.sessionSelections.get(id);
	state.selectedModel = saved?.model ?? state.catalog.selected;
	state.selectedEffort = saved?.effort ?? configuredEffort(state);
}

/**
 * 快捷键动作的结果通过状态行反馈，避免写破全屏画面。
 *
 * 一次性提示必须安排自动清除（真实使用反馈：授权提示跑到下一轮还在）——只写状态不
 * 布清除，提示会一直占位到下次状态覆盖。
 */
function keyActionStatus(state: AdapterState, text: string, tone: "error" | "notice" = "error"): void {
	state.host?.resetStatusMeta();
	state.host?.setStatus(text, tone);
	state.host?.scheduleStatusClear();
	state.host?.render();
}

/** 新建会话并让 UI 切换到空对话流；Ctrl+N 与 /new 共用这一条路径。 */
async function createAndSwitchSession(state: AdapterState): Promise<void> {
	const previousId = state.currentSessionId;
	const created = await state.core.createSession(state.projectRoot, { mode: "creator" });
	await state.core.acquireSessionLease(created);
	await state.core.releaseSessionLease(previousId);
	// 当前会话若只是本次新建的空壳，切走前就地销毁
	await discardSessionIfEmpty(state, previousId);
	state.createdSessionIds.add(created.meta.id);
	state.sessions.set(created.meta.id, created);
	state.histories.set(created.meta.id, { turns: [] });
	state.currentSessionId = created.meta.id;
	restoreSelection(state, created.meta.id);
	await refreshSessions(state);
	state.host?.applySession({ changed: true, history: [], notes: [`New session ${created.meta.id}`] });
	state.host?.render();
}

/** 删除当前会话并切到最近的其它会话；没有其它会话时新建一个，避免停在空状态。 */
async function deleteAndSwitchSession(state: AdapterState): Promise<void> {
	const id = state.currentSessionId;
	await state.core.deleteSession(id);
	await state.core.releaseSessionLease(id);
	state.createdSessionIds.delete(id);
	state.sessions.delete(id);
	state.histories.delete(id);
	state.sessionSelections.delete(id);
	state.metas = await state.core.listSessions(state.projectRoot);
	const next = state.metas.at(-1);
	let target: Session;
	if (next) {
		try {
			target = state.sessions.get(next.id) ?? (await state.core.openSession(next.id));
			state.sessions.set(target.meta.id, target);
			if (!state.histories.has(target.meta.id)) {
				state.histories.set(target.meta.id, await buildHistory(state.core, target, state.projectRoot));
			}
		} catch {
			// 下一个会话恰好打不开（损坏）时降级新建：停在已删除会话上继续追加会产生僵尸流（ADR-15）
			target = await state.core.createSession(state.projectRoot, { mode: "creator" });
			state.createdSessionIds.add(target.meta.id);
			state.sessions.set(target.meta.id, target);
			state.histories.set(target.meta.id, { turns: [] });
		}
	} else {
		target = await state.core.createSession(state.projectRoot, { mode: "creator" });
		state.createdSessionIds.add(target.meta.id);
		state.sessions.set(target.meta.id, target);
		state.histories.set(target.meta.id, { turns: [] });
	}
	await state.core.acquireSessionLease(target);
	state.currentSessionId = target.meta.id;
	restoreSelection(state, target.meta.id);
	state.host?.applySession({ ...switchPayload(state.histories.get(target.meta.id)), notes: [`Deleted session ${id}`] });
	state.host?.render();
}

/** 每轮结束只更新当前会话的切换缓存，不再重新回放整份事件流。 */
function rememberCurrentHistory(state: AdapterState): void {
	const session = state.sessions.get(state.currentSessionId);
	const tui = state.host?.state;
	if (!session || !tui) return;
	state.histories.set(session.meta.id, {
		turns: [...tui.turns],
		...(tui.currentTodo === undefined ? {} : { todo: tui.currentTodo }),
		...(tui.latestPlan === undefined ? {} : { plan: tui.latestPlan }),
	});
}

/**
 * 退出时清理本次进程新建的空会话；错误以英文写入 stderr。
 * @returns 确实被删除的会话 ID，宿主据此判断退出会话是否还值得提示恢复。
 */
/**
 * 切换离开时立即销毁本次进程新建的空会话，避免它继续挂在磁盘和会话菜单里。
 * 只有清理规则判定的空会话会被删除；有活动或不是本进程新建的会话原样保留。
 */
async function discardSessionIfEmpty(state: AdapterState, id: string): Promise<void> {
	if (!state.createdSessionIds.has(id)) return;
	const removed = await state.core.discardEmptySession(id).catch(() => false);
	if (!removed) return;
	state.createdSessionIds.delete(id);
	state.sessions.delete(id);
	state.histories.delete(id);
	state.sessionSelections.delete(id);
	state.metas = state.metas.filter((meta) => meta.id !== id);
}

/**
 * 启动时清扫本项目遗留的陈旧空会话（崩溃或强杀导致退出清理没跑）。
 * 当前会话与 10 分钟内新建的会话不动，避免误删另一个仍在运行的实例的当前会话。
 */
async function discardStaleEmptySessions(state: AdapterState): Promise<void> {
	const cutoff = Date.now() - 10 * 60 * 1000;
	for (const meta of [...state.metas]) {
		if (meta.id === state.currentSessionId) continue;
		const createdAt = Date.parse(meta.createdAt);
		if (Number.isFinite(createdAt) && createdAt > cutoff) continue;
		const removed = await state.core.discardEmptySession(meta.id).catch(() => false);
		if (!removed) continue;
		state.sessions.delete(meta.id);
		state.histories.delete(meta.id);
		state.sessionSelections.delete(meta.id);
		state.metas = state.metas.filter((entry) => entry.id !== meta.id);
	}
}

async function discardUnusedSessions(state: AdapterState): Promise<ReadonlySet<string>> {
	const ids = [...state.createdSessionIds];
	const results = await Promise.allSettled(ids.map((id) => state.core.discardEmptySession(id)));
	const discarded = new Set<string>();
	for (const [index, result] of results.entries()) {
		const id = ids[index];
		if (id === undefined) continue;
		if (result.status === "rejected") {
			state.warnings.emit(`Could not discard empty session: ${describeError(result.reason)}`);
		} else if (result.value) {
			discarded.add(id);
		}
	}
	return discarded;
}

/** 配置不可用时给用户看的原因；启动时静默保存，操作失败时才用来写对话流。 */
function configurationReason(state: AdapterState): string {
	const recorded = state.config["error"];
	return typeof recorded === "string" && recorded.length > 0
		? recorded
		: "No provider configured · add one to ~/.moros/providers.json";
}

/** 标记「配置不可用」：界面照常起来，但提交与需要配置的命令会被拦下。 */
function recordConfigProblem(state: AdapterState, reason: string): void {
	state.configLoaded = false;
	state.config = { error: reason };
}

/** 读取脱敏模型目录、当前选择与配置摘要；失败时保留界面可启动但禁止提交的状态。 */
async function refreshCatalog(state: AdapterState): Promise<void> {
	try {
		const [catalog, selected, config] = await Promise.all([
			state.core.listModels(state.projectRoot),
			state.core.getSelectedModel(state.sessions.get(state.currentSessionId)!),
			state.core.getConfigSummary(state.projectRoot),
		]);
		state.catalog = catalog;
		state.selectedModel = selected ?? catalog.selected;
		state.config = config;
		state.launchWarnings.push(
			...(Array.isArray(config.skipped) ? config.skipped : []).map((skip) => {
				const entry = skip as { path?: unknown; reason?: unknown };
				return `Skipped invalid config entry at ${String(entry.path ?? "?")}: ${String(entry.reason ?? "invalid")}`;
			}),
		);
		state.selectedEffort = configuredEffort(state);
		// 空注册表不是「配置已就绪」：providers.json 刚初始化时就是空的，放行提交只会让
		// Core 在请求阶段抛底层错误，不如在这里就标定为不可用，等用户操作时说清原因。
		if (catalog.providers.length === 0) {
			recordConfigProblem(state, "No provider configured · add one to ~/.moros/providers.json");
			return;
		}
		state.configLoaded = true;
	} catch (error) {
		recordConfigProblem(state, describeError(error));
	}
}

/** 把 core 的检查点记录映射成 TUI 契约条目。 */
function checkpointEntry(id: string, seq: number, ts: string | undefined): CheckpointEntry {
	return {
		id,
		turn: seq,
		createdAt: ts === undefined ? Date.now() : Date.parse(ts) || Date.now(),
		kind: "turn",
		label: ts === undefined ? id.slice(0, 8) : new Date(ts).toLocaleString(),
	};
}

/** 会话历史缓存 → 界面启动时的初始历史字段。 */
function historyFields(state: AdapterState) {
	const history = state.histories.get(state.currentSessionId);
	return {
		history: history?.turns ?? [],
		...(history?.todo ? { historyTodo: history.todo } : {}),
		...(history?.plan ? { historyPlan: history.plan } : {}),
	};
}

/** 切换到某个会话时的对话流快照；任务表与计划为空时对应面板收起。 */
function switchPayload(history: SessionHistory | undefined) {
	return {
		changed: true,
		history: history?.turns ?? [],
		...(history?.todo ? { todo: history.todo } : {}),
		...(history?.plan ? { plan: history.plan } : {}),
	};
}

/** 刷新技能清单缓存；扫描失败时保留空表，不影响界面启动。 */
async function refreshSkills(state: AdapterState): Promise<void> {
	try {
		state.skills = await state.core.listSkills(state.projectRoot);
	} catch (error) {
		// 读取失败保留上次缓存：清空会让使用者误以为技能全部消失（ADR-15）
		state.warnings.emit(`Could not refresh skills: ${describeError(error)}`);
	}
}

/** 会话列表与当前会话历史缓存；其它会话在真正切换时再回放，避免启动时排完整份历史。 */
async function refreshSessions(state: AdapterState): Promise<void> {
	const metas = await state.core.listSessions(state.projectRoot);
	state.metas = metas;
	const currentMeta = metas.find((meta) => meta.id === state.currentSessionId);
	if (currentMeta === undefined) return;
	const session = state.sessions.get(currentMeta.id) ?? (await state.core.openSession(currentMeta.id));
	state.sessions.set(currentMeta.id, session);
	if (!state.histories.has(currentMeta.id)) {
		state.histories.set(currentMeta.id, await buildHistory(state.core, session, state.projectRoot));
	}
}

/** 把 append-only 事件流翻译成会话消息，再交给历史回放器构建对话流。 */
async function buildHistory(core: Core, session: Session, projectRoot: string): Promise<SessionHistory> {
	const events = await core.readEvents(session);
	const messages: LlmMessage[] = [];
	for (const event of events) {
		if (event.type === "user.input") {
			const images = (event.payload.images ?? []).map((image) => ({
				type: "image" as const,
				name: `image-${image.attachmentId.slice(0, 8)}.${mediaExtension(image.mediaType)}`,
				mimeType: image.mediaType,
				data: "",
			}));
			messages.push({
				role: "user",
				content:
					images.length > 0 ? [{ type: "text" as const, text: event.payload.text }, ...images] : event.payload.text,
			});
		} else if (event.type === "llm.response") {
			const blocks: Array<
				| { type: "text"; text: string }
				| { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> }
			> = [];
			if (event.payload.text.trim().length > 0) blocks.push({ type: "text", text: event.payload.text });
			for (const call of parseToolCalls(event.payload.toolCalls)) {
				blocks.push({ type: "toolCall", id: call.id, name: call.name, arguments: call.arguments });
			}
			messages.push({ role: "assistant", content: blocks });
		} else if (event.type === "tool.result") {
			messages.push({
				role: "toolResult",
				toolCallId: event.payload.toolCallId,
				toolName: event.payload.tool,
				content: event.payload.result,
				isError: event.payload.isError,
			});
		}
	}
	return buildTranscriptHistory(messages, projectRoot);
}

/** 当前选中的模型条目；目录里没有对应项时返回 undefined。 */
function selectedModelEntry(state: AdapterState) {
	const selected = state.selectedModel;
	if (!selected) return undefined;
	return state.catalog.providers
		.find((entry) => entry.name === selected.provider)
		?.models.find((model) => model.id === selected.model);
}

/** 当前模型是否声明支持图片输入。 */
function modelAcceptsImages(state: AdapterState): boolean {
	return selectedModelEntry(state)?.input.includes("image") ?? false;
}

/** 会话内已切换的审批档位；未切换时返回 undefined。 */
function sessionApproval(state: AdapterState): ApprovalMode | undefined {
	const session = state.sessions.get(state.currentSessionId);
	return session ? state.core.getSelectedApproval(session) : undefined;
}

/** 配置里的审批档位，归一为三档；页脚与徽标共用。 */
function configuredApproval(state: AdapterState): ApprovalMode {
	return state.config.approval === "auto" || state.config.approval === "yolo" ? state.config.approval : "ask";
}

/** 页脚信息按帧读取；统计数据来自本进程内累计的用量事件。 */
function footerInfo(state: AdapterState): FooterInfo {
	const model = selectedModelLabel(state.catalog, state.selectedModel);
	const window = modelContextWindow(state);
	return {
		project: basename(state.projectRoot),
		branch: undefined,
		model,
		effort: state.selectedEffort,
		contextUsed: state.metrics.contextUsed,
		contextWindow: window,
		cacheHitRate: state.metrics.cacheHitRate,
		approval: sessionApproval(state) ?? configuredApproval(state),
	};
}

function modelContextWindow(state: AdapterState): number | undefined {
	return selectedModelEntry(state)?.contextWindow;
}

/**
 * 把 Core 的非致命诊断放进界面。
 *
 * 状态行只有一行且会自动消失，完整文本同时写入对话流顶部的持久警告区，避免长文案被
 * 截断后信息全丢。两个出口共用同一条消息，不额外生成第二份诊断。
 */
function showWarning(host: TuiHost, message: string): void {
	host.state.runtimeWarnings.push(`Warning: ${message}`);
	host.markTranscriptDirty();
	host.setStatus(message, "warning");
	host.scheduleStatusClear();
	host.render();
}

/**
 * 装配 TuiOptions：所有数据源都只调用 Core 的稳定公共接口。
 * 模块级导出仅供装配层契约测试直接驱动，不进包公开 API。
 */
export function buildTuiOptions(state: AdapterState, warnings: WarningSink): TuiOptions {
	const { core, projectRoot, approvals } = state;
	const imageSource = createImageSource(state);
	const commands = createPluginCommands(state);

	const runTurn = async (
		prompt: string,
		images: readonly ImageAttachment[],
		onEvent: AgentEventListener,
		signal: AbortSignal,
	): Promise<void> => {
		const session = state.sessions.get(state.currentSessionId);
		if (!session) throw new Error("The selected session is unavailable");
		// 以图片数据为键：界面会为同名图片改名，用 name 反查会丢图或张冠李戴。
		const prepared = images
			.map((image) => state.imageInputs.get(image.data))
			.filter((image): image is SessionImageInput => image !== undefined);
		for (const image of images) state.imageInputs.delete(image.data);
		onEvent({ type: "turn_start" });
		state.paused = false;
		const stream = createEventStreamState();
		const unsubscribe = core.subscribeEvents(session, (event) => {
			for (const mapped of mapCoreEvent(event, stream)) onEvent(mapped);
		});
		try {
			await core.runSession(session, prompt, {
				...(prepared.length > 0 ? { images: prepared } : {}),
				signal,
				onWarning: (message: string) => onEvent({ type: "warning", message }),
				onText: (text: string) => {
					stream.streamedText = true;
					onEvent({ type: "text_delta", text });
				},
				onReasoning: (text: string) => {
					onEvent({ type: "reasoning_delta", text });
				},
				onRetry: () => {
					stream.streamedText = false;
					// 渲染成「Retrying 1/3 · …」，原因里不再重复 retrying
					onEvent({ type: "retrying", attempt: 1, maxAttempts: 3, reason: "Stream interrupted" });
				},
			});
			if (signal.aborted) onEvent({ type: "aborted", cause: "user" });
			// 用本轮最后一次 llm.response 的真实结束原因，不再一律说成 "stop"
			else onEvent({ type: "turn_end", stopReason: toLlmStopReason(stream.stopReason) });
		} catch (error) {
			if (signal.aborted) {
				onEvent({ type: "aborted", cause: "user" });
			} else {
				onEvent({ type: "error", message: describeError(error) });
				onEvent({ type: "turn_end", stopReason: "error" });
			}
		} finally {
			unsubscribe();
			onEvent({ type: "run_end" });
			state.paused = false;
			void refreshSkills(state).catch(() => undefined);
			// 首条用户消息落盘后标题才派生出来：刷新会话元数据并重绘，让 tab 标题从
			// Untitled session 变成第一句话；同时会话菜单的标题也一起更新。
			void refreshSessions(state)
				.then(() => state.host?.render())
				.catch((error) => state.warnings.emit(`Could not refresh session list: ${describeError(error)}`));
			rememberCurrentHistory(state);
		}
	};

	const compact = async (onEvent: AgentEventListener, signal: AbortSignal): Promise<void> => {
		const session = state.sessions.get(state.currentSessionId);
		if (!session) throw new Error("The selected session is unavailable");
		const events = await core.readEvents(session);
		const messages = events.filter(
			(event) => event.type === "user.input" || event.type === "llm.response" || event.type === "tool.result",
		).length;
		onEvent({ type: "compaction_start", messages, tokensBefore: 0 });
		try {
			const result = await core.compactSession(session, { signal });
			if (!result.compacted) {
				onEvent({ type: "compaction_skipped", message: "Nothing to compact yet." });
				return;
			}
			onEvent({
				type: "compaction_end",
				covered: result.covered,
				tokensBefore: result.tokensBefore,
				tokensAfter: result.tokensAfter,
			});
			rememberCurrentHistory(state);
		} catch (error) {
			onEvent({ type: "compaction_failed", message: describeError(error) });
		}
	};

	return {
		version: "0.1.0",
		info: () => footerInfo(state),
		// OSC 0 标签标题：只显示会话标题（产品名与项目名不进 tab，避免与其它终端标签挤在一起），
		// 会话标题由首条用户消息派生，一轮结束刷新 metas 后这里会自动跟上。
		terminalTitle: () => {
			const current = state.metas.find((meta) => meta.id === state.currentSessionId);
			return current?.title ?? UNTITLED_SESSION;
		},
		// 静默启动：配置缺失不在对话流顶部预先铺警告，也不在终端打印错误。原因只存进
		// configurationError，等提交消息或执行需要配置的命令时再作为错误行写进对话流。
		// 配置正常时两处都不传（exactOptionalPropertyTypes 下「不传递」比「传 undefined」更准确）。
		...(state.configLoaded ? {} : { configurationError: configurationReason(state) }),
		images: imageSource,
		clipboard: { copy: (text) => copyToClipboard(text) },
		imagesSupported: () => modelAcceptsImages(state),
		files: { list: () => listProjectFiles(projectRoot) },
		ready: state.configLoaded,
		agent: { runTurn, compact, refreshInfo: () => refreshMetrics(state) },
		// 同一 broker 同时实现 Core 侧与 TUI 侧契约；request 的入参形状不同，这里只暴露 TUI 消费面。
		approval: approvals as unknown as CompatApprovalBroker,
		// 审批档位：会话内覆盖优先，否则回退配置；切换不回写配置（与 Shift+Tab 同一数据源）。
		approvalMode: {
			current: () => sessionApproval(state) ?? configuredApproval(state),
			select: (mode) => {
				const session = state.sessions.get(state.currentSessionId);
				if (!session) throw new Error("The selected session is unavailable");
				core.setSessionApproval(session, mode);
				state.config = { ...state.config, approval: mode };
			},
		},
		effortMenu: {
			current: () => state.selectedEffort,
			select: (level) => {
				state.selectedEffort = level;
				recordSelection(state);
				const session = state.sessions.get(state.currentSessionId);
				if (session) core.selectEffort(session, level);
				// 同时写回全局默认：重启与新会话都从它开始；失败只在状态行提示，不打断界面。
				void core
					.setDefaultEffort(level)
					.then(() => {
						state.config = { ...state.config, reasoningEffort: level };
					})
					.catch((error: unknown) => {
						keyActionStatus(state, `Could not save the reasoning effort default: ${describeError(error)}`);
					});
			},
		},
		modelMenu: {
			list: () => modelChoices(state),
			select: (item) => {
				// 同步校验注册表，避免异步 fire-and-forget 把失败吞掉还显示成功。
				const provider = state.catalog.providers.find((entry) => entry.name === item.provider);
				const known = provider?.models.some((model) => model.id === item.model) ?? false;
				if (!known) {
					const warning = `Unknown model: ${item.provider}/${item.model}`;
					return { warnings: [warning], ready: false, warning };
				}
				state.selectedModel = { provider: item.provider, model: item.model };
				recordSelection(state);
				const session = state.sessions.get(state.currentSessionId);
				if (session) {
					void core.selectModel(session, item.provider, item.model).catch((error: unknown) => {
						keyActionStatus(state, `Model selection was not applied: ${describeError(error)}`);
					});
				}
				// 同时写回全局默认 config.toml：重启与新会话都从它开始。
				void core
					.setDefaultModel(item.provider, item.model)
					.then(() => {
						state.config = { ...state.config, provider: item.provider, model: item.model };
						// 写回后重跑目录刷新：缓存已失效，UI 状态（configLoaded/警告区）随之同步（ADR-15）
						void refreshCatalog(state);
					})
					.catch((error: unknown) => {
						keyActionStatus(state, `Could not save the model default: ${describeError(error)}`);
					});
				// 成功确认只有一行：目标模型与「下一轮生效」由 modelSwitched 一次说完。
				// 不要把成功消息放进 warnings，那会把它渲染成 `! Warning: ...`。
				return { warnings: [], ready: true, warning: undefined };
			},
		},
		sessionMenu: {
			list: () => sessionChoices(state),
			fork: async (id) => {
				const source = state.sessions.get(id);
				if (!source) throw new Error(`Session ${id} is not available in this project`);
				const { session, copied } = await core.forkSession(source);
				await core.acquireSessionLease(session);
				await core.releaseSessionLease(state.currentSessionId);
				state.createdSessionIds.add(session.meta.id);
				state.sessions.set(session.meta.id, session);
				const history = await buildHistory(core, session, state.projectRoot);
				state.histories.set(session.meta.id, history);
				await refreshSessions(state);
				state.currentSessionId = session.meta.id;
				restoreSelection(state, session.meta.id);
				return { ...switchPayload(history), fork: { sourceId: id, copied }, notes: [] };
			},
			select: async (id) => {
				if (id === state.currentSessionId) {
					return { changed: false, history: state.histories.get(id)?.turns ?? [], notes: [] };
				}
				let target = state.sessions.get(id);
				// 非当前会话不在启动时缓存：真正切换时才打开并回放；
				// 打不开说明 ID 不属于本项目，明确拒绝而不是清空对话流。
				if (target === undefined) {
					try {
						target = await state.core.openSession(id);
					} catch (error) {
						// changed:false 会被命令层直接丢弃，返回 warnings 等于静默失败；
						// 抛错才会走 catch，把原因写成对话流里的 error 行。带上真实原因，
						// 使用者才能判断该删还是该修（ADR-15）。
						throw new Error(`Session ${id} is not available in this project (${describeError(error)})`);
					}
					state.sessions.set(id, target);
				}
				// 目标会话先加锁；被另一个窗口占用时不切走，当前会话保持原样。
				await state.core.acquireSessionLease(target);
				await state.core.releaseSessionLease(state.currentSessionId);
				await discardSessionIfEmpty(state, state.currentSessionId);
				state.currentSessionId = id;
				restoreSelection(state, id);
				let history = state.histories.get(id);
				if (history === undefined) {
					history = await buildHistory(state.core, target, state.projectRoot);
					state.histories.set(id, history);
				}
				return { ...switchPayload(history), notes: [] };
			},
		},
		// 只读审查：一次性标准模式会话，进度走状态行，结果作为命令回合展示。
		review: {
			run: async (args, signal, onProgress) => {
				const startedAt = Date.now();
				const result = await core.reviewSession(projectRoot, args, {
					signal,
					onText: (text) => {
						const line = text.trim().split("\n").filter(Boolean).at(-1);
						if (line !== undefined) onProgress(line);
					},
				});
				return {
					label: "Working tree",
					report: result.report,
					steps: result.turns,
					durationMs: Date.now() - startedAt,
					stopReason: result.stopReason,
				};
			},
		},
		// MCP 连接是后台的：mcpStatus 每次调用都取实时快照，启动握手与 /mcps 刷新共用。
		mcpServers: () =>
			core.mcpStatus(projectRoot).map((server) => {
				// 失败详情可能带 stderr 多行；页面条目只放一行，换行留给审批/错误记录
				const detail = server.detail.replace(/\s+/g, " ").trim();
				return {
					name: server.name,
					description: server.status === "connected" ? server.detail : server.status,
					...(server.status === "connected" || detail.length === 0 ? {} : { note: detail }),
				};
			}),
		mcpStatus: () => core.mcpStatus(projectRoot),
		startupProblems: [...state.launchWarnings],
		mcpControl: {
			reconnect: (name) => core.reconnectMcp(projectRoot, name),
			healthCheck: () => core.healthCheckMcp(projectRoot),
			awaitStartup: () => core.awaitMcpStartup(projectRoot),
		},
		// 工作区信任：存在需要信任的项目资源且尚无结论时提供信任页；授予后刷新配置与技能。
		...(state.trust.required && state.trust.decision === null
			? {
					trustPrompt: {
						root: projectRoot,
						files: state.trust.files,
						skillDirectories: state.trust.skillDirectories,
						accept: async (remember: boolean) => {
							await core.acceptWorkspaceTrust(projectRoot, remember);
							state.trust = await core.getWorkspaceTrust(projectRoot);
							await refreshCatalog(state);
							await refreshSkills(state);
							return [`Workspace trusted${remember ? "" : " for this session"}.`];
						},
						decline: () => {
							void core.denyWorkspaceTrust(projectRoot);
							process.exitCode = 1;
						},
					},
				}
			: {}),
		// 计划模式：会话内的只读叠加层；/plan 命令与计划审批页据此工作。
		planMode: {
			current: () => {
				const session = state.sessions.get(state.currentSessionId);
				return session ? core.isSessionPlan(session) : false;
			},
			select: (enabled) => {
				const session = state.sessions.get(state.currentSessionId);
				if (!session) throw new Error("The selected session is unavailable");
				core.setSessionPlan(session, enabled);
			},
		},
		// 技能页与 $ 补全：清单来自缓存（启动、信任变更、每轮结束刷新）。
		skills: {
			list: () =>
				state.skills.map((skill) => ({
					name: skill.name,
					description: skill.description,
					scope: skill.scope,
				})),
			directories: () => {
				const directories = core.skillsDirectories(projectRoot);
				return directories.project === undefined ? [directories.user] : [directories.user, directories.project];
			},
		},
		checkpoints: {
			available: () => true,
			error: () => undefined,
			latestUndoable: async () => {
				const session = state.sessions.get(state.currentSessionId);
				if (!session) return undefined;
				const checkpoint = await core.latestCheckpoint(session);
				if (checkpoint === undefined || checkpoint.files.length === 0) return undefined;
				return {
					entry: checkpointEntry(checkpoint.id, checkpoint.seq, checkpoint.ts),
					changes: checkpoint.files.map((file) => ({ path: file.path, status: file.op })),
				};
			},
			restore: async (id) => {
				const session = state.sessions.get(state.currentSessionId);
				if (!session) throw new Error("No active session");
				const checkpoint = await core.latestCheckpoint(session);
				const { restored, removed } = await core.restoreCheckpoint(session, id);
				const entry =
					checkpoint?.id === id
						? checkpointEntry(id, checkpoint.seq, checkpoint.ts)
						: checkpointEntry(id, 0, undefined);
				return { entry, restored, removed, safety: entry };
			},
		},
		exportSession: {
			export: async (target) => {
				const session = state.sessions.get(state.currentSessionId);
				if (!session) throw new Error("No active session");
				const result = await core.exportSession(session, target);
				return `Exported ${result.format} to ${result.path} (${formatBytes(result.bytes)}, ${result.created ? "created" : "overwrote"})`;
			},
		},
		onHostReady: (host) => {
			state.host = host;
			// host 就绪才绑定：绑定时回放构造期缓冲的告警，此时才有可写的界面
			warnings.bind((message) => showWarning(host, message));
		},
		keyActions: {
			togglePause: () => {
				try {
					if (state.paused) {
						state.core.resumeSession(state.currentSessionId);
						state.paused = false;
						keyActionStatus(state, "Resumed", "notice");
					} else {
						state.core.pauseSession(state.currentSessionId);
						state.paused = true;
						keyActionStatus(state, "Pause requested", "notice");
					}
				} catch (error) {
					keyActionStatus(state, `Could not change pause state: ${describeError(error)}`);
				}
			},
			rollback: () => {
				const session = state.sessions.get(state.currentSessionId);
				if (!session) return;
				void state.core.rollbackStep(session).then(
					() => keyActionStatus(state, "Rolled back the previous step", "notice"),
					(error: unknown) => keyActionStatus(state, `Rollback failed: ${describeError(error)}`),
				);
			},
			newSession: () => {
				void createAndSwitchSession(state).catch((error: unknown) =>
					keyActionStatus(state, `Could not create a session: ${describeError(error)}`),
				);
			},
			deleteSession: () => {
				void deleteAndSwitchSession(state).catch((error: unknown) =>
					keyActionStatus(state, `Could not delete the session: ${describeError(error)}`),
				);
			},
		},
		pluginCommands: commands,
		notify: "auto",
		...historyFields(state),
		workspaceRoot: projectRoot,
		stdin: process.stdin as unknown as TuiInput,
		stdout: process.stdout as unknown as TuiOutput,
	};
}

/** Moros Harness 专有斜杠命令以插件命令注入；输出行直接进对话流。 */
function createPluginCommands(state: AdapterState): {
	list: () => readonly CommandMenuItem[];
	run: (name: string, args: string) => Promise<readonly string[]>;
} {
	const { core } = state;
	return {
		list: () => PLUGIN_COMMANDS.map(([name, description]) => ({ name, description, enabled: true })),
		run: async (name, args) => {
			const session = state.sessions.get(state.currentSessionId);
			switch (name) {
				case "new":
					await createAndSwitchSession(state);
					return ["Created and switched to a new session."];
				case "diff": {
					if (!session) throw new Error("No active session");
					const seq = Number.parseInt(args.trim(), 10);
					if (!Number.isInteger(seq)) return ["Usage: /diff <seq> (see file.changed event seq)"];
					const change = await core.readFileChange(session.meta.id, seq);
					return unifiedPreview(change.path, change.before, change.after);
				}
				default:
					return [`Unknown command: /${name}`];
			}
		},
	};
}

/** 简易 unified 预览：按行前缀标记增删，无 LCS，适合终端快速查看。 */
function unifiedPreview(path: string, before: Buffer | null, after: Buffer | null): string[] {
	const beforeLines = before?.toString("utf8").split(/\r?\n/) ?? [];
	const afterLines = after?.toString("utf8").split(/\r?\n/) ?? [];
	const lines = [`--- a/${path}`, `+++ b/${path}`];
	for (const line of beforeLines) lines.push(`-${line}`);
	for (const line of afterLines) lines.push(`+${line}`);
	return lines.slice(0, 120);
}

/** @ 文件补全的数据源：浅层遍历，跳过构建产物与保护目录。 */
function listProjectFiles(projectRoot: string): readonly string[] {
	const found: string[] = [];
	const ignored = new Set(["node_modules", ".git", ".moros", "dist", "build", "coverage"]);
	const walk = (directory: string, depth: number): void => {
		if (depth > 3 || found.length >= 2000) return;
		let entries: string[];
		try {
			entries = readdirSync(directory);
		} catch {
			return;
		}
		for (const entry of entries) {
			if (ignored.has(entry)) continue;
			const absolute = join(directory, entry);
			// 断链或遍历中被删除的条目按文件记录，不因一次 stat 失败丢掉整份列表
			if (statSync(absolute, { throwIfNoEntry: false })?.isDirectory()) walk(absolute, depth + 1);
			else found.push(relative(projectRoot, absolute).replaceAll("\\", "/"));
		}
	};
	walk(projectRoot, 0);
	return found;
}

/** 图片来源：所有附件都经 Core.prepareImage 校验格式与尺寸，再缓存给发送时使用。 */
function createImageSource(state: AdapterState): ImageSource {
	const remember = (prepared: SessionImageInput, name: string): ImageAttachment => {
		state.imageInputs.set(prepared.data, prepared);
		return {
			name,
			mimeType: prepared.mediaType,
			data: prepared.data,
			bytes: imageByteLength(prepared.data),
		};
	};
	const prepare = async (path: string, name: string): Promise<ImageAttachment> =>
		remember(await state.core.prepareImage(state.projectRoot, path), name);
	return {
		read: (path) => prepare(path, basename(path)),
		readUrl: async (url) => remember(await state.core.prepareImageUrl(url), imageNameFromUrl(url)),
		detect: (text) => {
			const candidate = text.trim().replace(/^["']|["']$/g, "");
			if (!candidate || !/\.(png|jpe?g|webp|gif)$/i.test(candidate)) return undefined;
			const absolute = isAbsolute(candidate) ? candidate : resolve(state.projectRoot, candidate);
			return existsSync(absolute) ? absolute : undefined;
		},
		clipboard: async () => {
			const temporary = join(tmpdir(), `clipboard-${randomBytes(6).toString("hex")}.png`);
			try {
				await captureClipboardImage(temporary);
				return await prepare(temporary, "clipboard.png");
			} finally {
				await rm(temporary, { force: true }).catch(() => undefined);
			}
		},
		clipboardText: () => captureClipboardText(),
	};
}

/**
 * 从 URL 取一个用于标记的文件名。
 *
 * 只取路径最后一段并去掉百分号编码；取不到就退回 "image"，标记本身由 uniqueImageName
 * 再做去重与净化。
 */
function imageNameFromUrl(value: string): string {
	try {
		const segment = new URL(value).pathname
			.split("/")
			.filter((part) => part.length > 0)
			.at(-1);
		if (segment === undefined) return "image";
		const decoded = decodeURIComponent(segment);
		return decoded.length > 0 ? decoded : "image";
	} catch {
		return "image";
	}
}

/** 剪贴板图片：Windows 用 PowerShell 保存为 PNG，其他平台沿用系统命令。 */
async function captureClipboardImage(target: string): Promise<void> {
	if (process.platform === "win32") {
		const script = [
			"Add-Type -AssemblyName System.Windows.Forms",
			"Add-Type -AssemblyName System.Drawing",
			"$image = [System.Windows.Forms.Clipboard]::GetImage()",
			"if ($null -eq $image) { exit 2 }",
			`$image.Save('${target.replaceAll("'", "''")}', [System.Drawing.Imaging.ImageFormat]::Png)`,
		].join("; ");
		await runCommand("powershell.exe", ["-NoProfile", "-NonInteractive", "-STA", "-Command", script]);
		if (!existsSync(target)) throw new Error("Clipboard does not contain an image");
		return;
	}
	const command = process.platform === "darwin" ? "pngpaste" : "xclip";
	const args = process.platform === "darwin" ? ["-"] : ["-selection", "clipboard", "-t", "image/png", "-o"];
	const bytes = await runCommand(command, args);
	if (bytes.length === 0) throw new Error("Clipboard does not contain an image");
	await writeFile(target, bytes);
}

/** 剪贴板文本：Windows 用 PowerShell，macOS/Linux 用常见命令。 */
async function captureClipboardText(): Promise<string> {
	if (process.platform === "win32") {
		return (
			await runCommand("powershell.exe", [
				"-NoProfile",
				"-NonInteractive",
				"-Command",
				"[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; [Console]::Out.Write((Get-Clipboard -Raw))",
			])
		).toString("utf8");
	}
	if (process.platform === "darwin") return (await runCommand("pbpaste", [])).toString("utf8");
	try {
		return (await runCommand("wl-paste", ["--no-newline"])).toString("utf8");
	} catch {
		return (await runCommand("xclip", ["-selection", "clipboard", "-o"])).toString("utf8");
	}
}

/** 文本写入系统剪贴板；失败时返回 false，由界面退回 OSC 52。 */
async function copyToClipboard(text: string): Promise<boolean> {
	if (process.platform === "win32") {
		try {
			const { args, input } = windowsClipboardWrite(text);
			await runCommand("powershell.exe", args, input);
			return true;
		} catch {
			return false;
		}
	}
	try {
		await runCommand(
			process.platform === "darwin" ? "pbcopy" : "xclip",
			process.platform === "darwin" ? [] : ["-selection", "clipboard"],
			text,
		);
		return true;
	} catch {
		return false;
	}
}

/** 跑一个平台命令：可写入 stdin，收集 stdout；失败时给出可读的英文错误。 */
function runCommand(command: string, args: readonly string[], input?: string): Promise<Buffer> {
	return new Promise((resolvePromise, reject) => {
		const child = spawn(command, [...args], { stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
		const chunks: Buffer[] = [];
		child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));
		child.once("error", () => reject(new Error(`${command} is unavailable`)));
		child.once("close", (code) => {
			if (code !== 0) reject(new Error(`${command} exited with code ${code}`));
			else resolvePromise(Buffer.concat(chunks));
		});
		child.stdin?.end(input);
	});
}

function modelChoices(state: AdapterState): readonly ModelMenuItem[] {
	const current = state.selectedModel;
	return state.catalog.providers.flatMap((provider) =>
		provider.models.map((model) => ({
			provider: provider.name,
			model: model.id,
			...(model.name === undefined ? {} : { name: model.name }),
			current: current?.provider === provider.name && current.model === model.id,
		})),
	);
}

function sessionChoices(state: AdapterState): readonly SessionMenuItem[] {
	// 当前会话不出现在列表里：它已经在界面上，菜单只列可切换的目标
	return (
		[...state.metas]
			.filter((meta) => meta.id !== state.currentSessionId)
			// listSessions 按最后活动升序，反转后最近使用的排在最前
			.reverse()
			.map((meta) => ({
				id: meta.id,
				title: meta.title,
				time: new Date(meta.updatedAt).toLocaleString(),
				current: false,
				...(meta.forkedFrom === undefined ? {} : { forkedFrom: meta.forkedFrom }),
			}))
	);
}

function parseToolCalls(value: unknown): Array<{ id: string; name: string; arguments: Record<string, unknown> }> {
	if (!Array.isArray(value)) return [];
	const calls: Array<{ id: string; name: string; arguments: Record<string, unknown> }> = [];
	for (const item of value) {
		const record = asRecord(item);
		if (!record || typeof record.id !== "string" || typeof record.name !== "string") continue;
		calls.push({ id: record.id, name: record.name, arguments: asRecord(record.arguments) ?? {} });
	}
	return calls;
}

function mediaExtension(mediaType: string): string {
	switch (mediaType) {
		case "image/jpeg":
			return "jpg";
		case "image/webp":
			return "webp";
		case "image/gif":
			return "gif";
		default:
			return "png";
	}
}
