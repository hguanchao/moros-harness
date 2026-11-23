import type {
	DiscoveredModel,
	DiscoverModelsRequest,
	TestModelRequest,
	TestModelResult,
} from "@moros/core/config/model-discovery.ts";
import type { ModelMetadata as CatalogModelMetadata } from "@moros/core/config/model-catalog/fill.ts";
import type { SettingsPatch, SettingsSnapshot, ProviderDraft } from "@moros/core/config/settings.ts";
import type { ApprovalMode, ChangeStats, FileChangeDiff, ModelCatalog, SessionMetrics } from "@moros/core/core.ts";
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
	appOpenProjectFolder: "moros:app-open-project-folder",
	appOpenTerminal: "moros:app-open-terminal",
	appCopyProjectPath: "moros:app-copy-project-path",
	appForgetProject: "moros:app-forget-project",
	workspacePrepare: "moros:workspace-prepare",
	gitBranches: "moros:git-branches",
	gitCheckout: "moros:git-checkout",
	appOpenExternal: "moros:app-open-external",
	windowMinimize: "moros:window-minimize",
	windowToggleMaximize: "moros:window-toggle-maximize",
	windowClose: "moros:window-close",
	windowState: "moros:window-state",
	windowSetTheme: "moros:window-set-theme",
	sidebarSetWidth: "moros:sidebar-set-width",
	sessionsList: "moros:sessions-list",
	sessionsCreate: "moros:sessions-create",
	sessionsActivate: "moros:sessions-activate",
	sessionsRename: "moros:sessions-rename",
	sessionsArchive: "moros:sessions-archive",
	sessionsDelete: "moros:sessions-delete",
	sessionsRenameInTarget: "moros:sessions-rename-in-target",
	sessionsArchiveInTarget: "moros:sessions-archive-in-target",
	sessionsDeleteInTarget: "moros:sessions-delete-in-target",
	sessionPin: "moros:session-pin",
	sessionsFork: "moros:sessions-fork",
	sessionsExport: "moros:sessions-export",
	sessionsReplay: "moros:sessions-replay",
	sessionsEvents: "moros:sessions-events",
	messageFeedback: "moros:message-feedback",
	sessionsChanges: "moros:sessions-changes",
	sessionsChangeStats: "moros:sessions-change-stats",
	sessionsCheckpoint: "moros:sessions-checkpoint",
	sessionsRollback: "moros:sessions-rollback",
	sessionsRollbackTask: "moros:sessions-rollback-task",
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
	settingsDiscoverModels: "moros:settings-discover-models",
	settingsTestModel: "moros:settings-test-model",
	settingsLookupModelMetadata: "moros:settings-lookup-model-metadata",
	modelsList: "moros:models-list",
	configSummary: "moros:config-summary",
	sessionSelectModel: "moros:session-select-model",
	sessionSelectEffort: "moros:session-select-effort",
	sessionSelectApproval: "moros:session-select-approval",
	sessionSetPlan: "moros:session-set-plan",
	skillsList: "moros:skills-list",
	skillUpsert: "moros:skill-upsert",
	skillRemove: "moros:skill-remove",
	skillDetail: "moros:skill-detail",
	skillImport: "moros:skill-import",
	trustAccept: "moros:trust-accept",
	trustDeny: "moros:trust-deny",
	mcpStatus: "moros:mcp-status",
	mcpReconnect: "moros:mcp-reconnect",
	mcpHealth: "moros:mcp-health",
	mcpServerUpsert: "moros:mcp-server-upsert",
	mcpServerRemove: "moros:mcp-server-remove",
	mcpServerDetail: "moros:mcp-server-detail",
	mcpReload: "moros:mcp-reload",
	imagesPick: "moros:images-pick",
	imagesFromBytes: "moros:images-from-bytes",
	imagesFromUrl: "moros:images-from-url",
} as const;

/** 侧栏宽度默认值与拖拽范围；与主流 agent 会话列表（约 264~300px）对齐。 */
export const DEFAULT_SIDEBAR_WIDTH = 280;
export const MIN_SIDEBAR_WIDTH = 200;
export const MAX_SIDEBAR_WIDTH = 480;
/** 内容区保底宽度：窗口收窄时侧栏自动让位，避免对话与输入框被挤变形。 */
export const MIN_CONTENT_WIDTH = 480;

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
	/** 侧栏本地宽度；启动时由宿主读取持久化值。 */
	readonly sidebarWidth: number;
	/** 侧栏本地置顶的会话 ID；按最近置顶时间排序。 */
	readonly pinnedSessionIds: readonly string[];
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

/**
 * 设置页填写的 MCP server 草稿（IPC 传输用，三个形态互斥）。
 * 与 core 的 McpServerDraft 对应；完整字段由表单录入，高级项（timeout/disabled）
 * 由 core 的 writer 在编辑时原位保留。
 */
export type McpServerDraftInput =
	| {
			readonly type: "stdio";
			readonly command: string;
			readonly args?: readonly string[] | undefined;
			readonly env?: Readonly<Record<string, string>> | undefined;
	  }
	| {
			readonly type: "http" | "sse";
			readonly url: string;
			readonly headers?: Readonly<Record<string, string>> | undefined;
	  };

/** MCP server 详情（编辑表单回填用；只有表单暴露的字段，高级项不回传）。 */
export type McpServerDetail = McpServerDraftInput & { readonly name: string };

/** 技能草稿（设置页表单→IPC）：新增带 name，编辑复用同一结构但忽略 name（以 path 为准）。 */
export interface SkillDraftInput {
	readonly name: string;
	readonly description: string;
	readonly body: string;
}

/** 技能完整文档（编辑表单回填）。 */
export interface SkillDocumentResult {
	readonly name: string;
	readonly description: string;
	readonly body: string;
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
	| { readonly type: "session-pins"; readonly ids: readonly string[] }
	| { readonly type: "sidebar-width"; readonly width: number }
	| { readonly type: "session-view"; readonly view: SessionView }
	| { readonly type: "session-cleared"; readonly sessionId: string }
	| { readonly type: "sessions-changed" }
	| { readonly type: "workspace"; readonly paths: readonly string[] }
	/** 会话级警告/错误，渲染在对应会话的对话流顶部而非浮动提示。 */
	| {
			readonly type: "inline-notice";
			readonly sessionId: string;
			readonly tone: "warn" | "error";
			readonly text: string;
	  }
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
	/** 在系统文件管理器中打开已登记项目目录；不切换工作区。 */
	openProjectFolder(root: string): Promise<RpcResult<void>>;
	/** 在已登记项目根目录打开系统终端。 */
	openTerminal(root: string): Promise<RpcResult<void>>;
	/** 复制已登记项目目录路径到剪贴板。 */
	copyProjectPath(root: string): Promise<RpcResult<void>>;
	/** 只从最近项目列表移除，不删除目录或会话；返回更新后的列表。 */
	forgetProject(root: string): Promise<RpcResult<readonly RecentProject[]>>;
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
	/** 持久化拖拽调整后的侧栏宽度，返回钳制后的实际值。 */
	sidebarSetWidth(width: number): Promise<RpcResult<number>>;

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
	/** 在明确目标根内重命名，不切换当前工作区；target 必须与会话归属一致。 */
	sessionsRenameInTarget(id: string, title: string, target: WorkspaceTarget): Promise<RpcResult<void>>;
	/** 在明确目标根内归档/取消归档，不切换当前工作区。 */
	sessionsArchiveInTarget(id: string, archived: boolean, target: WorkspaceTarget): Promise<RpcResult<void>>;
	/** 在明确目标根内删除，不切换当前工作区；当前根沿用现有会话回退语义。 */
	sessionsDeleteInTarget(
		ids: readonly string[],
		target: WorkspaceTarget,
	): Promise<RpcResult<{ deleted: readonly string[]; failed: readonly { id: string; error: string }[] }>>;
	/** 设置或取消侧栏置顶；只接受完整会话 ID，返回更新后的置顶列表。 */
	sessionPin(id: string, pinned: boolean): Promise<RpcResult<readonly string[]>>;
	sessionsFork(id: string, uptoSeq?: number): Promise<RpcResult<SessionView>>;
	sessionsExport(id: string): Promise<RpcResult<SessionExportResult | null>>;
	sessionsReplay(id: string): Promise<RpcResult<readonly EventRecord[]>>;
	sessionsEvents(id: string, beforeSeq?: number, limit?: number): Promise<RpcResult<readonly EventRecord[]>>;
	/** 对某条 llm.response 事件点赞/点踩/撤销；写入会话事件流，跨重启保留。 */
	messageFeedback(sessionId: string, targetSeq: number, rating: "up" | "down" | "none"): Promise<RpcResult<void>>;
	sessionsChanges(id?: string): Promise<RpcResult<readonly FileChangeSummary[]>>;
	/** 会话级净变更统计（按文件去重）。 */
	sessionsChangeStats(id: string): Promise<RpcResult<ChangeStats>>;
	sessionsCheckpoint(): Promise<RpcResult<CheckpointView | null>>;
	sessionsRollback(): Promise<RpcResult<void>>;
	/** 撤销本次会话的全部文件改动。 */
	sessionsRollbackTask(): Promise<RpcResult<void>>;
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
	settingsDiscoverModels(input: DiscoverModelsRequest): Promise<RpcResult<readonly DiscoveredModel[]>>;
	settingsTestModel(input: TestModelRequest): Promise<RpcResult<TestModelResult>>;
	settingsLookupModelMetadata(id: string): Promise<RpcResult<CatalogModelMetadata | null>>;
	modelsList(): Promise<RpcResult<ModelCatalog>>;
	configSummary(): Promise<RpcResult<ConfigSummary>>;

	sessionSelectModel(provider: string, model: string): Promise<RpcResult<void>>;
	sessionSelectEffort(effort: ReasoningEffort): Promise<RpcResult<void>>;
	sessionSelectApproval(mode: ApprovalMode): Promise<RpcResult<void>>;
	sessionSetPlan(enabled: boolean): Promise<RpcResult<boolean>>;
	skillsList(): Promise<RpcResult<readonly SkillSummary[]>>;
	skillUpsert(draft: SkillDraftInput, path?: string): Promise<RpcResult<SkillSummary>>;
	skillRemove(path: string): Promise<RpcResult<void>>;
	skillDetail(path: string): Promise<RpcResult<SkillDocumentResult>>;
	skillImport(): Promise<RpcResult<SkillSummary | null>>;
	trustAccept(remember: boolean): Promise<RpcResult<WorkspaceTrustView>>;
	trustDeny(): Promise<RpcResult<WorkspaceTrustView>>;
	mcpStatus(): Promise<RpcResult<readonly McpStatus[]>>;
	mcpReconnect(name: string): Promise<RpcResult<string>>;
	mcpHealth(): Promise<RpcResult<readonly string[]>>;
	mcpServerUpsert(name: string, draft: McpServerDraftInput): Promise<RpcResult<McpServerDetail>>;
	mcpServerRemove(name: string): Promise<RpcResult<void>>;
	mcpServerDetail(name: string): Promise<RpcResult<McpServerDetail | null>>;
	mcpReload(): Promise<RpcResult<void>>;

	imagesPick(): Promise<RpcResult<PreparedImage | null>>;
	imagesFromBytes(bytes: Uint8Array, mediaType?: string): Promise<RpcResult<PreparedImage>>;
	imagesFromUrl(url: string): Promise<RpcResult<PreparedImage>>;

	onPush(listener: (message: PushMessage) => void): () => void;
}
