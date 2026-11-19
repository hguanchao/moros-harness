import type { SettingsPatch, SettingsSnapshot, ProviderDraft } from "@moros/core/config/settings.ts";
import type { ApprovalMode, FileChangeDiff, ModelCatalog, SessionMetrics } from "@moros/core/core.ts";
import type { EventRecord } from "@moros/core/events/schema.ts";
import type { ReasoningEffort } from "@moros/core/llm/types.ts";
import type { McpStatus } from "@moros/core/mcp/types.ts";
import type { SessionMeta } from "@moros/core/session/session-manager.ts";
import type { SessionExportResult } from "@moros/core/session/session-export.ts";
import type { SkillSummary } from "@moros/core/skills.ts";
import type { WorkspaceEntry, ReadTextFileResult } from "@moros/core/workspace/files.ts";

/** 主进程推送统一走这一个 channel；消息按 type 判别。 */
export const PUSH_CHANNEL = "moros:push";

/** invoke 方法名；preload 与主进程共用，避免字符串两处各写一遍。 */
export const IPC = {
	appState: "moros:app-state",
	appOpenProjectDialog: "moros:app-open-project-dialog",
	appOpenProject: "moros:app-open-project",
	appSelectProjectDialog: "moros:app-select-project-dialog",
	appCreateProjectDialog: "moros:app-create-project-dialog",
	workspacePrepare: "moros:workspace-prepare",
	gitBranches: "moros:git-branches",
	gitCheckout: "moros:git-checkout",
	appOpenExternal: "moros:app-open-external",
	windowMinimize: "moros:window-minimize",
	windowToggleMaximize: "moros:window-toggle-maximize",
	windowClose: "moros:window-close",
	windowState: "moros:window-state",
	windowSetTheme: "moros:window-set-theme",
	sessionsList: "moros:sessions-list",
	sessionsCreate: "moros:sessions-create",
	sessionsActivate: "moros:sessions-activate",
	sessionsRename: "moros:sessions-rename",
	sessionsArchive: "moros:sessions-archive",
	sessionsDelete: "moros:sessions-delete",
	sessionsFork: "moros:sessions-fork",
	sessionsExport: "moros:sessions-export",
	sessionsReplay: "moros:sessions-replay",
	sessionsEvents: "moros:sessions-events",
	sessionsChanges: "moros:sessions-changes",
	sessionsCheckpoint: "moros:sessions-checkpoint",
	sessionsRollback: "moros:sessions-rollback",
	sessionsRestore: "moros:sessions-restore",
	sessionsCompact: "moros:sessions-compact",
	sessionsReview: "moros:sessions-review",
	chatSend: "moros:chat-send",
	chatAbort: "moros:chat-abort",
	chatPause: "moros:chat-pause",
	chatResume: "moros:chat-resume",
	chatLive: "moros:chat-live",
	chatClearQueue: "moros:chat-clear-queue",
	approvalRespond: "moros:approval-respond",
	workspaceList: "moros:workspace-list",
	workspaceRead: "moros:workspace-read",
	workspaceReadBinary: "moros:workspace-read-binary",
	diffGet: "moros:diff-get",
	traceGet: "moros:trace-get",
	settingsGet: "moros:settings-get",
	settingsUpdate: "moros:settings-update",
	settingsUpsertProvider: "moros:settings-upsert-provider",
	settingsDeleteProvider: "moros:settings-delete-provider",
	settingsRenameProvider: "moros:settings-rename-provider",
	settingsRevealSecret: "moros:settings-reveal-secret",
	modelsList: "moros:models-list",
	configSummary: "moros:config-summary",
	sessionSelectModel: "moros:session-select-model",
	sessionSelectEffort: "moros:session-select-effort",
	sessionSelectApproval: "moros:session-select-approval",
	sessionSetPlan: "moros:session-set-plan",
	skillsList: "moros:skills-list",
	trustAccept: "moros:trust-accept",
	trustDeny: "moros:trust-deny",
	mcpStatus: "moros:mcp-status",
	mcpReconnect: "moros:mcp-reconnect",
	mcpHealth: "moros:mcp-health",
	imagesPick: "moros:images-pick",
	imagesFromBytes: "moros:images-from-bytes",
	imagesFromUrl: "moros:images-from-url",
} as const;

export interface RpcError {
	readonly message: string;
	/** 稳定错误码；界面按码分支，不解析文案。 */
	readonly code?: string;
}

export type RpcResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: RpcError };

export interface RecentProject {
	readonly root: string;
	readonly name: string;
	readonly lastOpenedAt: string;
}

/**
 * 桌面任务的明确归属；内部任务目录由主进程决定，客户端不能覆盖其路径。
 * @example { kind: "tasks" } 或 { kind: "project", root: "/work/project" }
 */
export type WorkspaceTarget = { readonly kind: "tasks" } | { readonly kind: "project"; readonly root: string };

/** 已校验的项目目录引用；仅供草稿关联，不代表已经激活该项目或会话。 */
export interface ProjectRef {
	readonly root: string;
	readonly name: string;
}

/** 选择或创建项目的结果；包含更新后的最近项目，取消目录对话框时返回 null 而非该结构。 */
export interface ProjectSelection {
	readonly project: ProjectRef;
	readonly recentProjects: readonly RecentProject[];
}

/** 项目 Git 分支查询结果；非 Git 仓库或查询失败时 branches 为空。 */
export interface GitBranches {
	readonly branches: readonly string[];
	/** 当前分支；detached HEAD 时缺省。 */
	readonly current?: string;
}

/** 切换分支成功后的目标分支。 */
export interface GitCheckoutResult {
	readonly branch: string;
}

/**
 * 首次发送时创建会话的参数；归属必填，未提供的会话选项沿用目标工作区的配置。
 * 配置选择在创建后应用，失败不得留下未发送的空会话。
 */
export interface SessionCreateInput {
	readonly target: WorkspaceTarget;
	readonly model?: { readonly provider: string; readonly model: string };
	readonly effort?: ReasoningEffort;
	readonly approval?: ApprovalMode;
	readonly plan?: boolean;
}

export interface WorkspaceTrustView {
	readonly required: boolean;
	readonly decision: boolean | null;
	readonly files: readonly string[];
	readonly skillDirectories: readonly string[];
}

export interface LiveState {
	readonly running: boolean;
	readonly paused: boolean;
	readonly runId?: string;
	readonly text: string;
	readonly reasoning: string;
	readonly toolOutputs: Readonly<Record<string, string>>;
	readonly startedAt?: number;
}

export interface SessionView {
	readonly meta: SessionMeta;
	readonly readOnly: boolean;
	readonly running: boolean;
	readonly model?: { readonly provider: string; readonly model: string };
	readonly effort: ReasoningEffort;
	readonly approval: ApprovalMode;
	readonly plan: boolean;
	readonly metrics: SessionMetrics;
	readonly live: LiveState;
	readonly queued: number;
}

export interface ProjectSnapshot {
	readonly root: string;
	readonly name: string;
	/** 实际工作区归属；tasks 工作区不作为普通项目展示。 */
	readonly target: WorkspaceTarget;
	readonly recentProjects: readonly RecentProject[];
	readonly trust: WorkspaceTrustView;
	readonly models: ModelCatalog;
	readonly skills: readonly SkillSummary[];
	readonly mcp: readonly McpStatus[];
	readonly warnings: readonly string[];
	readonly session?: SessionView;
}

/** 创建或激活会话后的完整上下文；会话与工作区必须一起切换，避免沿用旧项目的信任或模型。 */
export interface SessionContext {
	readonly project: ProjectSnapshot;
	readonly session: SessionView;
}

export interface AppSnapshot {
	readonly version: string;
	readonly platform: NodeJS.Platform;
	/** 稳定的内部任务根，只用于会话归组；不是客户端指定执行目录的入口。 */
	readonly taskRoot: string;
	readonly recentProjects: readonly RecentProject[];
	readonly project?: ProjectSnapshot;
}

export interface WindowState {
	readonly maximized: boolean;
	readonly fullScreen: boolean;
}

export interface SessionPage {
	readonly items: readonly SessionMeta[];
	readonly nextCursor?: number;
}

export interface SessionListQuery {
	/** 查询指定归属，不切换执行工作区；省略时查询当前工作区以兼容会话管理页。 */
	readonly target?: WorkspaceTarget;
	readonly query?: string;
	readonly includeArchived?: boolean;
	readonly cursor?: number;
	readonly limit?: number;
}

export interface ApprovalCard {
	readonly id: string;
	readonly sessionId: string;
	readonly tool: string;
	readonly risk: "low" | "medium" | "high";
	readonly reason: string;
	readonly summary: string;
	readonly preview: string;
	readonly saveShort?: string;
	readonly requestedAt: string;
}

export interface QueuedMessage {
	readonly id: string;
	readonly text: string;
	readonly imageCount: number;
}

export interface PreparedImage {
	readonly id: string;
	readonly mediaType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
	readonly width: number;
	readonly height: number;
	readonly bytes: number;
	/** 仅用于输入框预览，不随消息落盘。 */
	readonly dataUrl: string;
}

export interface ChatSendInput {
	/** 发起发送时渲染层看到的会话；主进程校验，避免切会话瞬间把消息写进另一个会话。 */
	readonly sessionId: string;
	readonly text: string;
	readonly imageIds?: readonly string[];
}

export interface ChatSendResult {
	readonly queued: boolean;
}

export interface ChatLiveResult {
	readonly sessionId: string;
	readonly live: LiveState;
	readonly queued: readonly QueuedMessage[];
}

export interface WorkspaceBinary {
	readonly path: string;
	readonly bytes: number;
	readonly mime: string;
	readonly dataUrl: string;
	readonly truncated: boolean;
}

export interface FileChangeSummary {
	readonly seq: number;
	readonly path: string;
	readonly op: "create" | "modify" | "delete";
	readonly ts: string;
}

export interface CheckpointView {
	readonly id: string;
	readonly seq: number;
	readonly ts?: string;
	readonly files: readonly { readonly path: string; readonly op: string }[];
}

export type TraceStepKind = "llm" | "tool" | "approval" | "subagent" | "file" | "compaction" | "error" | "system";

export interface TraceStep {
	readonly id: string;
	readonly kind: TraceStepKind;
	readonly title: string;
	readonly status: "pending" | "running" | "ok" | "error" | "blocked";
	readonly tool?: string;
	readonly ts?: string;
	readonly durationMs?: number;
	readonly args?: string;
	readonly result?: string;
	readonly risk?: string;
}

export interface TraceTurn {
	readonly id: string;
	readonly index: number;
	readonly prompt: string;
	readonly startedAt?: string;
	readonly steps: readonly TraceStep[];
}

export interface ReviewResult {
	readonly report: string;
	readonly turns: number;
	readonly stopReason: "done" | "steps" | "aborted";
}

export interface ConfigSummary {
	readonly provider?: string;
	readonly model?: string;
	readonly reasoningEffort?: string;
	readonly approval?: string;
	readonly shellPath?: string;
	readonly httpProxy?: string;
	readonly providers: readonly string[];
	readonly mcpServers: readonly { readonly name: string; readonly type: string; readonly enabled: boolean }[];
	readonly skipped: readonly { readonly path: string; readonly reason: string }[];
	readonly limits?: Record<string, unknown>;
	readonly retry?: Record<string, unknown>;
	readonly compaction?: Record<string, unknown>;
	readonly ui?: Record<string, unknown>;
}

export type PushMessage =
	| { readonly type: "event"; readonly sessionId: string; readonly event: EventRecord }
	| {
			readonly type: "stream";
			readonly sessionId: string;
			readonly runId: string;
			readonly kind: "text" | "reasoning";
			readonly delta: string;
	  }
	| {
			readonly type: "tool-output";
			readonly sessionId: string;
			readonly runId: string;
			readonly toolCallId: string;
			readonly delta: string;
	  }
	| { readonly type: "retry"; readonly sessionId: string; readonly runId: string }
	| {
			readonly type: "subagent";
			readonly sessionId: string;
			readonly runId: string;
			readonly progress: {
				readonly toolCallId: string;
				readonly steps: number;
				readonly totalTokens: number;
				readonly elapsedMs: number;
			};
	  }
	| {
			readonly type: "run";
			readonly sessionId: string;
			readonly runId: string;
			readonly state: "running" | "paused" | "idle" | "error";
			readonly error?: string;
	  }
	| { readonly type: "approval"; readonly card: ApprovalCard }
	| { readonly type: "approval-cleared"; readonly id: string }
	| { readonly type: "session-updated"; readonly meta: SessionMeta }
	| { readonly type: "session-view"; readonly view: SessionView }
	| { readonly type: "session-cleared"; readonly sessionId: string }
	| { readonly type: "sessions-changed" }
	| { readonly type: "workspace"; readonly paths: readonly string[] }
	| { readonly type: "notice"; readonly level: "info" | "warn" | "error"; readonly message: string }
	| { readonly type: "project"; readonly project: ProjectSnapshot }
	| { readonly type: "trust"; readonly trust: WorkspaceTrustView }
	| { readonly type: "queue"; readonly sessionId: string; readonly items: readonly QueuedMessage[] }
	| {
			readonly type: "review";
			readonly sessionId: string;
			readonly runId: string;
			readonly state: "running" | "done" | "error";
			readonly text?: string;
			readonly report?: string;
			readonly error?: string;
	  }
	| { readonly type: "window-state"; readonly state: WindowState };

export interface DesktopBridge {
	appState(): Promise<RpcResult<AppSnapshot>>;
	openProjectDialog(): Promise<RpcResult<ProjectSnapshot | null>>;
	openProject(path: string): Promise<RpcResult<ProjectSnapshot>>;
	/** 只选择并登记目录，不切换执行工作区；取消返回 null，路径错误以 RpcError 返回。 */
	selectProjectDialog(): Promise<RpcResult<ProjectSelection | null>>;
	/** 在用户选择的父目录中新建 name 文件夹；取消返回 null，已有路径不会被覆盖。 */
	createProjectDialog(name: string): Promise<RpcResult<ProjectSelection | null>>;
	/** 准备明确的任务目标，不自动恢复或创建会话；返回信任与模型信息供首次发送校验。 */
	prepareWorkspace(target: WorkspaceTarget): Promise<RpcResult<ProjectSnapshot>>;
	/** 查询已登记项目的本地分支；非 Git 仓库返回空列表。 */
	gitBranches(root: string): Promise<RpcResult<GitBranches>>;
	/** 首次发送前切换到所选分支；工作区有未提交改动或切换失败时返回 RpcError。 */
	gitCheckout(root: string, branch: string): Promise<RpcResult<GitCheckoutResult>>;
	openExternal(url: string): Promise<RpcResult<void>>;
	windowMinimize(): Promise<RpcResult<void>>;
	windowToggleMaximize(): Promise<RpcResult<void>>;
	windowClose(): Promise<RpcResult<void>>;
	windowState(): Promise<RpcResult<WindowState>>;
	windowSetTheme(dark: boolean): Promise<RpcResult<void>>;

	sessionsList(query: SessionListQuery): Promise<RpcResult<SessionPage>>;
	/** 在 input.target 下创建一次会话并应用草稿选项；错误以 RpcError 返回，不使用隐含项目。 */
	sessionsCreate(input: SessionCreateInput): Promise<RpcResult<SessionContext>>;
	/** 根据持久化会话归属激活 id；返回会话与正确工作区，保留租约及根路径校验。 */
	sessionsActivate(id: string): Promise<RpcResult<SessionContext>>;
	sessionsRename(id: string, title: string): Promise<RpcResult<void>>;
	sessionsArchive(id: string, archived: boolean): Promise<RpcResult<void>>;
	sessionsDelete(
		ids: readonly string[],
	): Promise<RpcResult<{ deleted: readonly string[]; failed: readonly { id: string; error: string }[] }>>;
	sessionsFork(id: string, uptoSeq?: number): Promise<RpcResult<SessionView>>;
	sessionsExport(id: string): Promise<RpcResult<SessionExportResult | null>>;
	sessionsReplay(id: string): Promise<RpcResult<readonly EventRecord[]>>;
	sessionsEvents(id: string, beforeSeq?: number, limit?: number): Promise<RpcResult<readonly EventRecord[]>>;
	sessionsChanges(id?: string): Promise<RpcResult<readonly FileChangeSummary[]>>;
	sessionsCheckpoint(): Promise<RpcResult<CheckpointView | null>>;
	sessionsRollback(): Promise<RpcResult<void>>;
	sessionsRestore(id: string): Promise<RpcResult<{ restored: number; removed: number }>>;
	sessionsCompact(): Promise<
		RpcResult<{ compacted: boolean; covered: number; tokensBefore: number; tokensAfter: number }>
	>;
	sessionsReview(prompt: string): Promise<RpcResult<ReviewResult>>;

	chatSend(input: ChatSendInput): Promise<RpcResult<ChatSendResult>>;
	chatAbort(): Promise<RpcResult<void>>;
	chatPause(): Promise<RpcResult<void>>;
	chatResume(): Promise<RpcResult<void>>;
	chatLive(sessionId?: string): Promise<RpcResult<ChatLiveResult>>;
	chatClearQueue(): Promise<RpcResult<void>>;
	approvalRespond(id: string, decision: "allow" | "deny" | "allow-session"): Promise<RpcResult<void>>;

	workspaceList(path: string, includeHidden?: boolean): Promise<RpcResult<readonly WorkspaceEntry[]>>;
	workspaceRead(path: string): Promise<RpcResult<ReadTextFileResult>>;
	workspaceReadBinary(path: string): Promise<RpcResult<WorkspaceBinary>>;
	diffGet(seq: number): Promise<RpcResult<FileChangeDiff>>;
	traceGet(sessionId?: string): Promise<RpcResult<readonly TraceTurn[]>>;

	settingsGet(): Promise<RpcResult<SettingsSnapshot>>;
	settingsUpdate(patch: SettingsPatch): Promise<RpcResult<SettingsSnapshot>>;
	settingsUpsertProvider(name: string, draft: ProviderDraft): Promise<RpcResult<SettingsSnapshot>>;
	settingsDeleteProvider(name: string): Promise<RpcResult<SettingsSnapshot>>;
	settingsRenameProvider(from: string, to: string): Promise<RpcResult<SettingsSnapshot>>;
	settingsRevealSecret(name: string): Promise<RpcResult<string>>;
	modelsList(): Promise<RpcResult<ModelCatalog>>;
	configSummary(): Promise<RpcResult<ConfigSummary>>;

	sessionSelectModel(provider: string, model: string): Promise<RpcResult<void>>;
	sessionSelectEffort(effort: ReasoningEffort): Promise<RpcResult<void>>;
	sessionSelectApproval(mode: ApprovalMode): Promise<RpcResult<void>>;
	sessionSetPlan(enabled: boolean): Promise<RpcResult<boolean>>;
	skillsList(): Promise<RpcResult<readonly SkillSummary[]>>;
	trustAccept(remember: boolean): Promise<RpcResult<WorkspaceTrustView>>;
	trustDeny(): Promise<RpcResult<WorkspaceTrustView>>;
	mcpStatus(): Promise<RpcResult<readonly McpStatus[]>>;
	mcpReconnect(name: string): Promise<RpcResult<string>>;
	mcpHealth(): Promise<RpcResult<readonly string[]>>;

	imagesPick(): Promise<RpcResult<PreparedImage | null>>;
	imagesFromBytes(bytes: Uint8Array, mediaType?: string): Promise<RpcResult<PreparedImage>>;
	imagesFromUrl(url: string): Promise<RpcResult<PreparedImage>>;

	onPush(listener: (message: PushMessage) => void): () => void;
}
