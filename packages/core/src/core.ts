import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { extname, isAbsolute, join, resolve } from "node:path";

import { z } from "zod";

import { atomicWriteFile } from "./atomic-file.ts";
import type { EventRecord, UserInputImage } from "./events/schema.ts";
import { ContextCompactor } from "./compaction/compactor.ts";
import { decodeDiffText, diffLines, summarizeChangeStats, type DiffResult } from "./diff/line-diff.ts";
import { loadConfig as loadConfigFiles, type LoadedConfig } from "./config/loader.ts";
import {
	type ModelMetadata as CatalogModelMetadata,
	lookupModelMetadata as lookupModelMetadataInCatalog,
} from "./config/model-catalog/metadata.ts";
import {
	discoverProviderModels,
	type DiscoveredModel,
	type DiscoverModelsRequest,
	type TestModelRequest,
	type TestModelResult,
} from "./config/model-discovery.ts";
import { parseModelRef } from "./config/model-ref.ts";
import { resolveActiveProvider, type ResolvedProvider } from "./config/resolve-providers.ts";
import { redactSecrets, runSecretCommand } from "./config/secrets.ts";
import {
	parseProvidersFile,
	type AppConfig,
	type ModelCapability,
	type ModelInputType,
	type ProviderConfig,
	type ProvidersFile,
} from "./config/schema.ts";
import { updateGlobalConfig, updateGlobalMcpServers, updateGlobalTrusts } from "./config/writer.ts";
import {
	deleteProvider,
	readSettings,
	revealProviderSecret,
	upsertProvider,
	renameProvider,
	writeSettings,
	type ProviderDraft,
	type SettingsPatch,
	type SettingsSnapshot,
} from "./config/settings.ts";
import { createBuiltinTools, createPresentPlanTool, createSkillTool, detectEnvironment } from "./tools/index.ts";
import { ToolPipeline } from "./harness/pipeline.ts";
import { createPolicy } from "./harness/policy.ts";
import type {
	ApprovalDecision,
	ApprovalRequest,
	Mode,
	ReviewRequest,
	ReviewVerdict,
	ToolContext,
	ToolResult,
} from "./harness/types.ts";
import { LlmClient } from "./llm/client.ts";
import { MAX_IMAGE_BYTES_PER_REQUEST, MAX_IMAGES_PER_REQUEST, formatImageBytes } from "./llm/image-limits.ts";
import { validateMcpServerDraft, type McpServerDraft } from "./mcp/config.ts";
import { McpManager } from "./mcp/manager.ts";
import type { McpServerConfig, McpStatus } from "./mcp/types.ts";
import { VERSION } from "./version.ts";
import { AgentLoop, type LoopResult } from "./loop/agent-loop.ts";
import { replayMessages } from "./loop/message-replay.ts";
import { Session, SessionManager, type SessionMeta } from "./session/session-manager.ts";
import { SessionLease } from "./session/session-lease.ts";
import { AttachmentStore } from "./session/attachment-store.ts";
import { prepareImageBuffer, prepareImageFile, type SessionImageInput } from "./session/image-file.ts";
import { prepareImageUrl as prepareImageFromUrl } from "./session/image-url.ts";
import { renderSessionExport, type SessionExportFormat, type SessionExportResult } from "./session/session-export.ts";
import { createTitleGenerator } from "./session/title-generator.ts";
import { resolveSandboxPath } from "./harness/path-sandbox.ts";
import { createCommandReviewer } from "./review.ts";
export type { SessionExportFormat, SessionExportResult } from "./session/session-export.ts";
import { SnapshotStore, type SnapshotFile } from "./session/snapshot-store.ts";
import type { CanonicalMessage, ModelRequest, ReasoningEffort } from "./llm/types.ts";
import {
	buildSystemMessage,
	formatInstructionsSection,
	formatSkillsSection,
	REVIEW_INSTRUCTION,
} from "./system-prompt.ts";
import { loadWorkspaceInstructions } from "./instructions.ts";
import { normalizeProjectRoot } from "./session/project-dir.ts";
import {
	listSkills as collectSkills,
	projectSkillsDirectory,
	userSkillDirectories,
	userSkillsDirectory,
	type SkillSummary,
} from "./skills.ts";
import {
	requiresWorkspaceTrust,
	resolveWorkspaceTrust,
	trustPromptSkillFiles,
	workspaceTrustResources,
} from "./trust.ts";

export interface CoreOptions {
	readonly homeDir?: string;
	readonly fetch?: typeof fetch;
	/** 可替换的环境变量来源，用于供应商密钥与 HTTPS 代理解析。 */
	readonly env?: NodeJS.ProcessEnv;
	/** 接收非致命诊断（配置装载问题等）；由宿主决定呈现通道，Core 不直接写终端。 */
	readonly onWarning?: (message: string) => void;
	/**
	 * 工具审批回调；返回三档决定（allow / deny / allow-session）。
	 * 第二个参数是发起审批的会话 ID：并行多会话时宿主据此把审批卡路由给正确的会话。
	 */
	readonly requestApproval?: (
		request: ApprovalRequest,
		sessionId: string,
		signal?: AbortSignal,
	) => Promise<ApprovalDecision>;
	readonly now?: () => Date;
	readonly monotonicNow?: () => number;
	readonly random?: () => number;
	readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
	/** 覆盖租约使用的 PID，测试注入用。 */
	readonly processId?: number;
	/** 租约诊断里的宿主类型（tui / test）。 */
	readonly hostKind?: string;
}

export interface DiagnosticReport {
	readonly nodeVersion: string;
	readonly configLoaded: boolean;
	readonly providers: readonly { name: string; available: boolean; modelCount: number }[];
	/** 已配置的 MCP server；doctor 只报告配置，不实际启动进程。 */
	readonly mcpServers: readonly { name: string; type: string; enabled: boolean }[];
	readonly environment: Awaited<ReturnType<typeof detectEnvironment>>;
	readonly errors: readonly string[];
}

/** 交给报告总结器的会话对话、文件变更与 Shell 命令。 */
export interface ReportInput {
	readonly messages: readonly CanonicalMessage[];
	readonly fileChanges: readonly { path: string; op: "create" | "modify" | "delete" }[];
	readonly commands: readonly { tool: string; command: string }[];
}

export type { SessionImageInput } from "./session/image-file.ts";

/** 会话用量指标；统计口径由 Core 定义，端侧只负责显示。 */
export interface SessionMetrics {
	/** 最近一次请求的输入 token，近似当前上下文占用。 */
	readonly contextUsed: number;
	/** 累计缓存读取 / 累计总输入，0 到 1。 */
	readonly cacheHitRate: number;
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly cacheReadTokens: number;
	readonly cacheWriteTokens: number;
}

/** 一次文件变更快照的完整内容，供端侧渲染 Diff 预览。 */
export interface FileChangeContent {
	readonly seq: number;
	readonly path: string;
	readonly op: "create" | "modify" | "delete";
	/** 变更前内容；文件为新建时为 null。 */
	readonly before: Buffer | null;
	/** 变更后内容；文件被删除时为 null。 */
	readonly after: Buffer | null;
}

/** 一次文件变更的行级 Diff，供界面查看。 */
export interface FileChangeDiff extends DiffResult {
	readonly seq: number;
	readonly path: string;
	readonly op: "create" | "modify" | "delete";
}

/** 会话级文件变更汇总：按 path 去重后的净变化统计。 */
export interface ChangeStats {
	/** 净发生变化的文件数（内容最终回到原样的不计）。 */
	readonly files: number;
	/** 累计新增行数。 */
	readonly added: number;
	/** 累计删除行数。 */
	readonly removed: number;
}

/** 面向 UI 的模型目录；不包含密钥或端点凭据。 */
export interface ModelCatalog {
	readonly providers: readonly {
		readonly name: string;
		readonly models: readonly {
			readonly id: string;
			readonly name?: string;
			readonly maxTokens: number;
			readonly contextWindow?: number;
			readonly reasoning: boolean;
			/** 模型支持的推理档位（不含 off）；未配置时端侧回退为全档位可选。 */
			readonly reasoningEfforts?: readonly Exclude<ReasoningEffort, "off">[];
			readonly input: readonly ModelInputType[];
			readonly capabilities?: readonly ModelCapability[];
		}[];
	}[];
	/** 当前配置选中的 provider/model；未配置时缺省。 */
	readonly selected?: { readonly provider: string; readonly model: string };
}

/** 控制单次会话运行以及可选图片输入。 */
export interface RunSessionOptions {
	/** 中止本次运行的外部信号。 */
	readonly signal?: AbortSignal;
	/** 本次用户输入附带的预处理图片；图片数据会写入会话附件目录。 */
	readonly images?: readonly SessionImageInput[];
	/** 接收主模型响应的流式文本增量；不落盘，仅供 UI 实时显示。 */
	readonly onText?: (text: string) => void;
	/** 接收本次运行中的非致命诊断；未提供时回退到 Core 级 warning 回调。 */
	readonly onWarning?: (message: string) => void;
	/** 接收推理模型的推理增量；不落盘，仅供 UI 实时显示。 */
	readonly onReasoning?: (text: string) => void;
	/** 流因空闲超时或提前结束而重试时回调，用于清空 UI 中的未完成增量。 */
	readonly onRetry?: () => void;
	/** 标记本次运行是一次性子代理会话：工具面不再注入 task，防止递归。 */
	readonly subagent?: boolean;
	/** 会话运行在内部任务工作区：系统提示词不披露工作区路径；项目会话不设置。 */
	readonly internalWorkspace?: boolean;
	/** 接收子代理实时进度（步数/耗时），不落盘。 */
	readonly onSubagent?: (progress: SubagentProgress) => void;
	/** 接收工具执行中的实时输出；不落盘，仅供界面展示。 */
	readonly onToolOutput?: (toolCallId: string, chunk: string) => void;
}

/** 子代理运行进度；界面卡片实时展示，结构化完成态另落 subagent.finished 事件。 */
export interface SubagentProgress {
	readonly toolCallId: string;
	readonly steps: number;
	readonly totalTokens: number;
	readonly elapsedMs: number;
}

/** task 工具回传给界面的结构化统计；随 tool.result 事件进入主会话事件流。 */
export interface SubagentRunStats {
	readonly steps: number;
	readonly totalTokens: number;
	readonly durationMs: number;
	/** 子代理请求步数上限；达到时子代理被暂停而非自然结束。 */
	readonly paused: boolean;
}

const SessionImageInputSchema = z
	.object({
		mediaType: z.enum(["image/png", "image/jpeg", "image/webp", "image/gif"]),
		data: z
			.string()
			.min(4)
			.regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
		width: z.number().int().positive().max(2000),
		height: z.number().int().positive().max(2000),
		/** 网络图片的来源 URL；本地文件/剪贴板不带。 */
		sourceUrl: z.string().min(1).max(4096).optional(),
	})
	.strict();

/** 与 llm/types.ts 的 ReasoningEffort 一致；用于运行时校验外部传入的档位值。 */
const REASONING_EFFORTS = new Set<string>(["off", "minimal", "low", "medium", "high", "max"]);

/** 会话内审批档位覆盖；与 config.toml 的 approval 同一组值（ask|auto|yolo）。 */
export type ApprovalMode = "ask" | "auto" | "yolo";

/** 与 config schema 的 approval 枚举一致；用于运行时校验外部传入的档位。 */
const APPROVAL_MODES = new Set<string>(["ask", "auto", "yolo"]);

/** spill 目录：执行副产物易失，放系统临时目录借其生命周期管理。 */
const SPILL_DIRECTORY = join(tmpdir(), "moros-spill");

/**
 * 单次高危审查的时限。
 *
 * 不做成配置项：审查是执行路径上的同步等待，给使用者调大只会让 agent 卡得更久；
 * 超时按 error 收尾、退回人工，本身就是安全侧。
 */
/**
 * 数据目录根：显式 `homeDir` > `MOROS_HOME` > 系统 home。
 *
 * 探针、E2E 脚本与并行测试常以临时目录当项目根，若 `new Core()` 直接落到真实的
 * `~/.moros`，每次运行都会多出一个项目哈希目录。设置 `MOROS_HOME` 即可把整棵数据
 * 树（配置、会话、快照）隔离到临时目录；相对路径按 cwd 解析。
 */
function resolveHomeDir(explicit: string | undefined): string {
	const override = explicit ?? process.env.MOROS_HOME;
	return override === undefined || override.length === 0 ? homedir() : resolve(override);
}

const ToolSchema = z.object({
	name: z.string(),
	description: z.string(),
	parameters: z.record(z.string(), z.unknown()),
});

/** 变更总结报告的系统提示；作为独立请求运行，不影响会话上下文。 */
const REPORT_SYSTEM_PROMPT =
	"Write a concise Markdown session report with sections: Changes (grouped by operation), Commands, Decisions, Risks, Follow-ups. Use only the supplied data; never invent files, commands, or changes.";

/** 校验供应商与模型都存在于注册表；两处「选择模型」共用同一套报错。 */
function assertRegisteredModel(loaded: LoadedConfig, provider: string, model: string): void {
	const registry = loaded.providers.providers[provider];
	if (!registry) throw new Error(`Unknown provider: ${provider}`);
	if (!registry.models.some((candidate) => candidate.id === model))
		throw new Error(`Unknown model: ${provider}/${model}`);
}

/**
 * 应用层业务入口：组装配置、会话、LLM 与 Harness 服务。
 *
 * 所有外部依赖（`fetch`、`env`、时钟、随机数、审批回调、诊断回调）都可从 `CoreOptions`
 * 注入，因此它是 headless 的——不写终端、不读全局状态，测试里可以带假 LLM 跑完整会话。
 */
export class Core {
	readonly #homeDir: string;
	readonly #dataDir: string;
	readonly #options: CoreOptions;
	readonly #sessions: SessionManager;
	readonly #snapshots: SnapshotStore;
	readonly #attachments: AttachmentStore;
	readonly #loadedConfigs = new Map<string, LoadedConfig>();
	readonly #sessionLoops = new Map<string, AgentLoop>();
	/** 当前回合活跃的工具管线；审批/模式在运行中切换时据此即时推送新策略。 */
	readonly #sessionPipelines = new Map<string, ToolPipeline>();
	readonly #sessionSignals = new Map<string, AbortController>();
	/** 在飞的会话标题任务（按会话 ID 去重）；后台锦上添花，绝不阻塞主回合。 */
	readonly #titleTasks = new Map<string, Promise<void>>();
	/** 会话内 `/model` 切换产生的内存级模型选择；仅影响后续 runSession，不写入配置文件。 */
	readonly #sessionModels = new Map<string, { provider: string; model: string }>();
	/** 会话内 `/effort` 切换的推理强度；覆盖后续请求的 reasoning_effort，不写配置文件。 */
	readonly #sessionEfforts = new Map<string, ReasoningEffort>();
	/** 会话内审批档位切换；覆盖后续工具调用的审批策略，不写配置文件。 */
	readonly #sessionApprovals = new Map<string, ApprovalMode>();
	/**
	 * 会话级的 `allow-session` 放行作用域；跨管线实例保留，换一轮对话不再重问。
	 * 值为 approval-scope.ts 产出的缓存键，会话删除时一并清理。
	 */
	readonly #sessionApprovedScopes = new Map<string, Set<string>>();
	/** 本次运行内的一次性工作区信任（归一化路径）；不落盘。 */
	readonly #sessionTrust = new Set<string>();
	/** 会话内计划模式开关：只读叠加层，不写入会话元数据。 */
	readonly #sessionPlans = new Map<string, boolean>();
	/** 当前实例持有的会话租约；存 Promise 让同一实例的并发获取也串行。 */
	readonly #sessionLeases = new Map<string, Promise<SessionLease>>();
	/** 每个项目一份 MCP 连接管理；键是归一化项目根。 */
	readonly #mcpManagers = new Map<string, McpManager>();
	#disposed = false;

	constructor(options: CoreOptions = {}) {
		this.#homeDir = resolveHomeDir(options.homeDir);
		this.#dataDir = join(this.#homeDir, ".moros");
		this.#options = options;
		this.#sessions = new SessionManager(this.#dataDir, {
			...(options.now ? { now: options.now } : {}),
			// 恢复诊断接线（ADR-15）：会话目录跳过、事件流截断等恢复告警经宿主的 onWarning 通道显示，
			// 不再落进 SessionManager 缺省的 no-op（此前「会话无声消失」零诊断的根源之一）。
			...(options.onWarning ? { onRecoveryWarning: options.onWarning } : {}),
		});
		this.#snapshots = new SnapshotStore(
			join(this.#dataDir, "snapshots"),
			options.now,
			options.onWarning ? { onRecoveryWarning: options.onWarning } : undefined,
		);
		this.#attachments = new AttachmentStore();
		void this.#pruneSpillLogs();
	}

	/** 加载并校验用户配置和供应商注册表；对外返回的供应商凭据一律脱敏。 */
	async loadConfig(projectRoot?: string): Promise<LoadedConfig> {
		const loaded = await this.#loadRawConfig(projectRoot);
		return { ...loaded, providers: parseProvidersFile(redactSecrets(loaded.providers)).providers };
	}

	/**
	 * 内部装载：返回含真实凭据的配置并写入缓存。
	 *
	 * 公共 `loadConfig` 必须脱敏，但运行期解析供应商需要原始 apiKey；两者共用同一份缓存，
	 * 避免出现「第一次调用拿到 `***`、后续调用拿到明文」的隐蔽差异。
	 */
	async #loadRawConfig(projectRoot?: string): Promise<LoadedConfig> {
		const project = projectRoot ? resolve(projectRoot) : "";
		const cached = this.#loadedConfigs.get(project);
		if (cached) return cached;
		const loaded = await loadConfigFiles({
			homeDir: this.#homeDir,
			...(project ? { projectRoot: project } : {}),
		});
		this.#loadedConfigs.set(project, loaded);
		return loaded;
	}

	/** 创建一个项目会话；ADR-14 起会话恒为 creator 档（缺省由 SessionManager 兜底），不再恢复项目模式偏好。 */
	async createSession(
		projectRoot: string,
		options: { mode?: Mode; title?: string; id?: string } = {},
	): Promise<Session> {
		const root = resolve(projectRoot);
		return this.#sessions.create(root, options);
	}

	/**
	 * 恢复已存在的会话并校验事件流。
	 *
	 * 接受完整 ID 或唯一前缀：26 位 ULID 不便手输，前缀歧义时由 SessionManager 抛出
	 * 带候选列表的错误，不会擅自选一个会话。
	 */
	async openSession(sessionId: string): Promise<Session> {
		const session = await this.#sessions.open(await this.#sessions.resolveId(sessionId));
		await this.#restoreSessionRuntime(session);
		return session;
	}

	/**
	 * 从事件流折叠最近一次真实请求的路由，恢复会话级模型与推理档位覆盖。
	 *
	 * ZCode / DeepSeek Harness 语义：持久事实是「实际发出的请求」（llm.request 事件），
	 * 而不是 UI 选择本身——选过但从未使用的覆盖在重启后回落全局默认。旧格式事件没有
	 * provider 字段（更早的历史也不会有），向后折叠到它即止，保持全局默认。
	 */
	async #restoreSessionRuntime(session: Session): Promise<void> {
		const sessionId = session.meta.id;
		if (this.#sessionModels.has(sessionId) && this.#sessionEfforts.has(sessionId)) return;
		const events = await session.events.read();
		for (let index = events.length - 1; index >= 0; index -= 1) {
			const event = events[index];
			if (event === undefined || event.type !== "llm.request") continue;
			const { provider, model, reasoningEffort } = event.payload;
			if (provider === undefined) break;
			if (!this.#sessionModels.has(sessionId)) this.#sessionModels.set(sessionId, { provider, model });
			if (!this.#sessionEfforts.has(sessionId) && reasoningEffort !== undefined) {
				this.#sessionEfforts.set(sessionId, reasoningEffort);
			}
			return;
		}
	}

	/**
	 * 为当前实例长期持有会话租约：TUI 当前会话在整个界面期内独占写入。
	 *
	 * 已经持有同一个会话时是幂等的。冲突时抛 `SessionBusyError`；`force` 会忽略现存
	 * 租约强制接管（用于用户确认「在另一个窗口打开」之后）。
	 * @param session 目标会话。
	 * @param options force 强制接管。
	 */
	async acquireSessionLease(session: Session, options: { force?: boolean } = {}): Promise<void> {
		const id = session.meta.id;
		const existing = this.#sessionLeases.get(id);
		if (existing) {
			await existing;
			return;
		}
		const pending = SessionLease.acquire(session.directory, id, {
			...(this.#options.processId === undefined ? {} : { pid: this.#options.processId }),
			...(this.#options.hostKind === undefined ? {} : { host: this.#options.hostKind }),
			...(options.force ? { force: true } : {}),
		});
		this.#sessionLeases.set(id, pending);
		try {
			await pending;
		} catch (error) {
			this.#sessionLeases.delete(id);
			throw error;
		}
	}

	/** 释放会话租约；未持有时无操作，可重复调用。 */
	async releaseSessionLease(sessionId: string): Promise<void> {
		const pending = this.#sessionLeases.get(sessionId);
		if (!pending) return;
		this.#sessionLeases.delete(sessionId);
		const lease = await pending.catch(() => undefined);
		await lease?.release();
	}

	/** 当前实例是否持有该会话租约。 */
	hasSessionLease(sessionId: string): boolean {
		return this.#sessionLeases.has(sessionId);
	}

	/** 在租约保护下执行写操作；已有租约时复用，否则临时获取并在结束后释放。 */
	async #withSessionLease<T>(session: Session, operation: () => Promise<T>): Promise<T> {
		const id = session.meta.id;
		if (this.#sessionLeases.has(id)) return operation();
		await this.acquireSessionLease(session);
		try {
			return await operation();
		} finally {
			await this.releaseSessionLease(id);
		}
	}

	/**
	 * 停止后台资源并释放全部租约：中止进行中的回合、清理心跳定时器。
	 * 宿主退出前必须调用；调用后仍可读取事件流，但新回合需要重新创建实例。
	 */
	async dispose(): Promise<void> {
		if (this.#disposed) return;
		this.#disposed = true;
		for (const sessionId of [...this.#sessionSignals.keys()]) this.abortSession(sessionId, "session");
		this.#sessionSignals.clear();
		this.#sessionLoops.clear();
		this.#sessionPipelines.clear();
		await Promise.allSettled([...this.#mcpManagers.values()].map((manager) => manager.close()));
		this.#mcpManagers.clear();
		await Promise.allSettled([...this.#sessionLeases.keys()].map((id) => this.releaseSessionLease(id)));
	}

	/**
	 * 返回该项目最近活动的会话 ID；没有会话时返回 undefined。
	 * 顺序与 `listSessions` 一致（按最后活动时间升序），供 `--last` / 无参 `--resume` 使用。
	 */
	async latestSessionId(projectRoot: string): Promise<string | undefined> {
		const metas = await this.#sessions.list(projectRoot);
		return metas.at(-1)?.id;
	}

	/**
	 * 订阅会话的实时事件流；回调在事件落盘后按追加次序送达。
	 * @param session 目标会话。
	 * @param listener 事件回调。
	 * @returns 取消订阅函数。
	 */
	subscribeEvents(session: Session, listener: (event: EventRecord) => void): () => void {
		return session.events.subscribe(listener);
	}

	/**
	 * 按序回读会话事件；与 subscribeEvents 组合可实现「先补历史、再跟实时」。
	 * @param session 目标会话。
	 * @param options 可选的 seq 范围过滤。
	 */
	async readEvents(
		session: Session,
		options: { fromSeq?: number; toSeq?: number } = {},
	): Promise<readonly EventRecord[]> {
		return session.events.read(options);
	}

	/**
	 * 分页回读会话事件，供界面向上翻历史。
	 * @param session 目标会话。
	 * @param options beforeSeq 上界（不含）与条数上限。
	 */
	async readEventsPage(
		session: Session,
		options: { beforeSeq?: number; limit?: number } = {},
	): Promise<readonly EventRecord[]> {
		return session.events.readPage(options);
	}

	/**
	 * 列出本地会话元数据，按最后活动时间升序（`updatedAt` 为事件流末条事件时间）；损坏目录被跳过。
	 * @param projectRoot 提供时只返回该项目的会话。
	 */
	async listSessions(projectRoot?: string): Promise<SessionMeta[]> {
		return this.#sessions.list(projectRoot);
	}

	/**
	 * 分页列出会话：按最后活动时间倒序，支持关键词与归档过滤。
	 * @param projectRoot 工作区根目录。
	 * @param options cursor 偏移（上一页 nextCursor）、limit 1~100、query 标题关键词、includeArchived。
	 */
	async listSessionsPage(
		projectRoot: string,
		options: { cursor?: number; limit?: number; query?: string; includeArchived?: boolean } = {},
	): Promise<{ items: readonly SessionMeta[]; nextCursor?: number }> {
		const limit = Math.min(Math.max(options.limit ?? 50, 1), 100);
		const query = options.query?.trim().toLocaleLowerCase() ?? "";
		const all = (await this.#sessions.list(projectRoot))
			.filter((meta) => (options.includeArchived ?? false) || !meta.archived)
			.filter((meta) => query.length === 0 || meta.title.toLocaleLowerCase().includes(query))
			.reverse();
		const offset = Math.max(0, options.cursor ?? 0);
		const items = all.slice(offset, offset + limit);
		const next = offset + items.length;
		return { items, ...(next < all.length ? { nextCursor: next } : {}) };
	}

	/**
	 * 修改会话标题（append-only 事件 + 列表投影）。
	 * @throws 标题为空或会话被其他窗口占用时抛出错误。
	 */
	async renameSession(session: Session, title: string): Promise<void> {
		await this.#withSessionLease(session, () => this.#sessions.rename(session, title));
	}

	/** 归档或取消归档会话。 */
	async archiveSession(session: Session, archived: boolean): Promise<void> {
		await this.#withSessionLease(session, () => this.#sessions.archive(session, archived));
	}

	/**
	 * 批量删除会话；单个失败不阻断其余删除。
	 * @param sessionIds 目标会话 ID 列表。
	 * @param options force 强制接管被其他窗口占用的会话。
	 * @returns 成功与失败清单。
	 */
	async deleteSessions(
		sessionIds: readonly string[],
		options: { force?: boolean } = {},
	): Promise<{ deleted: readonly string[]; failed: readonly { id: string; error: string }[] }> {
		const deleted: string[] = [];
		const failed: { id: string; error: string }[] = [];
		for (const id of sessionIds) {
			try {
				if (this.#sessionLoops.has(id)) throw new Error(`Session ${id} has an active run`);
				const session = await this.#sessions.open(id);
				if (options.force) await this.acquireSessionLease(session, { force: true });
				await this.#withSessionLease(session, () => this.#sessions.delete(id));
				await this.releaseSessionLease(id);
				this.#sessionApprovedScopes.delete(id);
				deleted.push(id);
			} catch (error) {
				failed.push({ id, error: error instanceof Error ? error.message : String(error) });
			}
		}
		return { deleted, failed };
	}

	/**
	 * 清理从未产生对话活动的新建会话；目录随删除直接销毁，不进入会话列表。
	 * @param sessionId 目标会话 ID。
	 * @returns 是否确实清理；有活跃运行或已有对话活动时返回 false。
	 * @throws 会话不存在或事件流损坏（seq 不连续）时抛出错误。
	 */
	async discardEmptySession(sessionId: string): Promise<boolean> {
		if (this.#sessionLoops.has(sessionId)) return false;
		const session = await this.#sessions.open(sessionId);
		return this.#withSessionLease(session, async () => {
			const events = await session.events.read();
			// 模式切换不算对话活动；改名/归档是用户显式动作，保留会话。
			const hasActivity = events.some((event) => !["session.created", "mode.switched"].includes(event.type));
			if (hasActivity) return false;
			await this.#sessions.delete(sessionId);
			this.#sessionApprovedScopes.delete(sessionId);
			return true;
		});
	}

	/**
	 * 删除会话：会话目录直接销毁，不可恢复。
	 * @throws 会话不存在或仍有活跃运行时抛出错误。
	 */
	async deleteSession(sessionId: string): Promise<void> {
		if (this.#sessionLoops.has(sessionId)) throw new Error(`Session ${sessionId} has an active run`);
		const session = await this.#sessions.open(sessionId);
		await this.#withSessionLease(session, async () => {
			await this.#sessions.delete(sessionId);
			this.#sessionApprovedScopes.delete(sessionId);
		});
	}

	/**
	 * 回滚会话最近一次文件变更（单步回滚）；回滚本身会追加反向快照，可再次回滚。
	 * @throws 会话无快照记录或快照对象损坏时抛出错误。
	 */
	async rollbackStep(session: Session): Promise<void> {
		return this.#withSessionLease(session, async () => {
			const pipeline = await this.createPipeline({
				session,
				projectRoot: session.meta.projectRoot,
				mode: session.meta.mode,
			});
			await pipeline.rollbackStep();
		});
	}

	/**
	 * 回滚整个会话的全部文件变更（整任务回滚）；回滚本身会追加反向快照，可再次回滚。
	 * @throws 会话无快照记录或快照对象损坏时抛出错误。
	 */
	async rollbackTask(session: Session): Promise<void> {
		return this.#withSessionLease(session, async () => {
			const pipeline = await this.createPipeline({
				session,
				projectRoot: session.meta.projectRoot,
				mode: session.meta.mode,
			});
			await pipeline.rollbackTask();
		});
	}

	/**
	 * 读取会话最近一个可恢复的检查点：最后一条 after/rollback 快照记录。
	 * @returns 检查点 id、事件序号、写入时间与涉及的文件；无记录时返回 undefined。
	 */
	async latestCheckpoint(
		session: Session,
	): Promise<{ id: string; seq: number; ts?: string; files: readonly SnapshotFile[] } | undefined> {
		const records = await this.#snapshots.readRecords(session.meta.id);
		const record = [...records].reverse().find((entry) => entry.phase !== "before");
		if (!record) return undefined;
		return {
			id: record.id,
			seq: record.seq,
			...(record.ts === undefined ? {} : { ts: record.ts }),
			files: record.files,
		};
	}

	/**
	 * 恢复到指定检查点：把该记录涉及文件的 before 状态写回，并追加反向快照与 rollback.done 事件。
	 * @param session 目标会话。
	 * @param id 检查点 id（快照记录 id）。
	 * @returns 恢复与删除的文件数。
	 * @throws 检查点不存在或快照对象损坏时抛出错误。
	 */
	async restoreCheckpoint(session: Session, id: string): Promise<{ restored: number; removed: number }> {
		return this.#withSessionLease(session, async () => {
			const pipeline = await this.createPipeline({
				session,
				projectRoot: session.meta.projectRoot,
				mode: session.meta.mode,
			});
			return pipeline.restoreCheckpoint(id);
		});
	}

	/**
	 * 从源会话分叉出新会话（复制截止到 uptoSeq 的事件）；源会话不受影响。
	 * @param source 源会话。
	 * @param uptoSeq 复制到的事件序号；缺省复制全部。
	 * @returns 新会话与复制的事件条数。
	 */
	async forkSession(source: Session, uptoSeq?: number): Promise<{ session: Session; copied: number }> {
		return this.#withSessionLease(source, async () => this.#sessions.fork(source, uptoSeq));
	}

	/**
	 * 读取指定 seq 的文件变更快照内容，供端侧渲染 Diff 预览。
	 * @throws seq 对应事件不是 file.changed 或快照对象缺失时抛出错误。
	 */
	async readFileChange(sessionId: string, seq: number): Promise<FileChangeContent> {
		const session = await this.#sessions.open(sessionId);
		const event = (await session.events.read()).find((record) => record.seq === seq);
		if (!event || event.type !== "file.changed") throw new Error(`No file change event at seq ${seq}`);
		const before = event.payload.before ? await this.#snapshots.get(event.payload.before) : null;
		const after = event.payload.after ? await this.#snapshots.get(event.payload.after) : null;
		return { seq, path: event.payload.path, op: event.payload.op, before, after };
	}

	/**
	 * 计算指定文件变更快照的行级 Diff，供界面 Diff 页渲染。
	 * 二进制与超大内容降级为整体替换，不抛错。
	 * @param sessionId 目标会话 ID。
	 * @param seq file.changed 事件序号。
	 */
	async diffChange(sessionId: string, seq: number): Promise<FileChangeDiff> {
		const change = await this.readFileChange(sessionId, seq);
		const before = decodeDiffText(change.before);
		const after = decodeDiffText(change.after);
		const diff = diffLines(before.text, after.text, {
			binary: before.binary || after.binary,
			beforeBytes: before.bytes,
			afterBytes: after.bytes,
		});
		return { seq, path: change.path, op: change.op, ...diff };
	}

	/**
	 * 会话级变更汇总：按 path 去重的净变化（首个 before → 末个 after），批量计算增删行。
	 *
	 * 只读取一次事件流，避免逐文件调用 diffChange 带来的重复读取；单个文件的快照缺失
	 * 或损坏时跳过该文件，不影响整体统计。二进制/超大文件沿用 diffLines 的降级行为。
	 */
	async changeStats(sessionId: string): Promise<ChangeStats> {
		const session = await this.#sessions.open(sessionId);
		const events = await session.events.read();
		const entries = events.flatMap((event) =>
			event.type === "file.changed"
				? [{ path: event.payload.path, before: event.payload.before, after: event.payload.after }]
				: [],
		);
		return summarizeChangeStats(entries, (hash) => this.#snapshots.get(hash));
	}

	/**
	 * 读取脱敏的模型目录与当前选择；不含密钥。
	 * @param projectRoot 配置解析的项目根目录；缺省时仅用全局层。
	 */
	async listModels(projectRoot?: string): Promise<ModelCatalog> {
		const loaded = await this.#getConfig(projectRoot ? resolve(projectRoot) : "");
		const providers = Object.entries(loaded.providers.providers).map(([name, provider]) => ({
			name,
			models: provider.models.map((model) => ({
				id: model.id,
				...(model.name ? { name: model.name } : {}),
				maxTokens: model.maxTokens,
				...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
				reasoning: model.reasoning,
				...(model.reasoningEfforts === undefined ? {} : { reasoningEfforts: model.reasoningEfforts }),
				input: model.input,
				...(model.capabilities === undefined ? {} : { capabilities: model.capabilities }),
			})),
		}));
		const selected =
			loaded.config.provider && loaded.config.model
				? { provider: loaded.config.provider, model: loaded.config.model }
				: undefined;
		return { providers, ...(selected ? { selected } : {}) };
	}

	/**
	 * 读取会话的当前模型选择：会话内 `/model` 覆盖优先，否则回退到配置选择。
	 * @throws 配置无效时抛出错误。
	 */
	async getSelectedModel(session: Session): Promise<{ provider: string; model: string } | undefined> {
		const override = this.#sessionModels.get(session.meta.id);
		if (override) return override;
		const loaded = await this.#getConfig(resolve(session.meta.projectRoot));
		return loaded.config.provider && loaded.config.model
			? { provider: loaded.config.provider, model: loaded.config.model }
			: undefined;
	}

	/**
	 * 选择会话后续请求使用的推理强度；只作用于当前进程内的该会话，不写回配置文件。
	 * @param session 目标会话。
	 * @param effort Core 支持的六档之一。
	 * @throws 档位不在允许集合时抛出错误。
	 */
	selectEffort(session: Session, effort: ReasoningEffort): void {
		if (!REASONING_EFFORTS.has(effort)) throw new Error(`Unknown reasoning effort: ${effort}`);
		this.#sessionEfforts.set(session.meta.id, effort);
	}

	/** 读取会话内已切换的推理强度；未切换时返回 undefined，由配置默认值生效。 */
	getSelectedEffort(session: Session): ReasoningEffort | undefined {
		return this.#sessionEfforts.get(session.meta.id);
	}

	/**
	 * 选择会话后续工具调用使用的审批档位；仅作用于当前进程内的该会话，不写回配置文件。
	 * @param session 目标会话。
	 * @param mode ask | auto | yolo 三档之一。
	 * @throws 档位不在允许集合时抛出错误。
	 */
	setSessionApproval(session: Session, mode: ApprovalMode): void {
		if (!APPROVAL_MODES.has(mode)) throw new Error(`Unknown approval mode: ${mode}`);
		const sessionId = session.meta.id;
		this.#sessionApprovals.set(sessionId, mode);
		// 运行中切换：把新档位推给当前回合的管线，后续工具调用立即按新档位审批；
		// 已经挂起或正在执行的调用不受影响（setPolicy 的语义）。
		this.#sessionPipelines.get(sessionId)?.setPolicy(session.meta.mode, mode);
	}

	/** 读取会话内已切换的审批档位；未切换时返回 undefined，由配置默认值生效。 */
	getSelectedApproval(session: Session): ApprovalMode | undefined {
		return this.#sessionApprovals.get(session.meta.id);
	}

	/**
	 * 打开或关闭会话的计划模式：只读叠加层，write/shell 工具直接拒绝，并注入 present_plan 工具。
	 * 仅作用于当前进程内的该会话，不写入会话元数据。
	 * @param session 目标会话。
	 * @param enabled 是否进入计划模式。
	 */
	setSessionPlan(session: Session, enabled: boolean): void {
		if (enabled) this.#sessionPlans.set(session.meta.id, true);
		else this.#sessionPlans.delete(session.meta.id);
	}

	/** 会话当前是否处于计划模式。 */
	isSessionPlan(session: Session): boolean {
		return this.#sessionPlans.get(session.meta.id) === true;
	}

	/**
	 * 为会话选择后续 runSession 使用的模型；仅作用于当前进程内的该会话，不写入配置文件。
	 * @throws 供应商或模型不在注册表中时抛出错误。
	 */
	async selectModel(session: Session, provider: string, model: string): Promise<void> {
		assertRegisteredModel(await this.#getConfig(resolve(session.meta.projectRoot)), provider, model);
		this.#sessionModels.set(session.meta.id, { provider, model });
	}

	/**
	 * 把全局默认模型选择写回 `~/.moros/config.toml`（provider 与 model 键）。
	 *
	 * 校验规则与 selectModel 一致：供应商与模型必须存在于注册表。会话内覆盖不受影响，
	 * 本次运行仍以会话选择优先；写回后失效配置缓存，后续读取立即可见，重启与新会话
	 * 都从这份默认开始。
	 * @throws 供应商或模型不在注册表中，或配置文件不可读/写回失败时抛出错误。
	 */
	async setDefaultModel(provider: string, model: string): Promise<void> {
		assertRegisteredModel(await this.#getConfig(""), provider, model);
		await updateGlobalConfig({ provider, model }, { homeDir: this.#homeDir });
		this.#loadedConfigs.clear();
	}

	/**
	 * 把全局默认推理强度写回 `~/.moros/config.toml`（reasoning_effort 键）。
	 *
	 * 会话内覆盖（selectEffort）不受影响；写回后失效配置缓存，重启与新会话都从这份
	 * 默认开始。仅 reasoning=true 的模型实际生效，与配置加载口径一致。
	 * @throws 档位不在允许集合，或配置文件不可读/写回失败时抛出错误。
	 */
	async setDefaultEffort(effort: ReasoningEffort): Promise<void> {
		if (!REASONING_EFFORTS.has(effort)) throw new Error(`Unknown reasoning effort: ${effort}`);
		await updateGlobalConfig({ reasoningEffort: effort }, { homeDir: this.#homeDir });
		this.#loadedConfigs.clear();
	}

	/**
	 * 返回脱敏的三层合并配置摘要，供 `/config` 等只读展示；不含密钥。
	 * @param projectRoot 配置解析的项目根目录；缺省时仅用全局层。
	 */
	async getConfigSummary(projectRoot?: string): Promise<Record<string, unknown>> {
		const loaded = await this.#getConfig(projectRoot ? resolve(projectRoot) : "");
		return {
			provider: loaded.config.provider,
			model: loaded.config.model,
			approval: loaded.config.approval,
			reasoningEffort: loaded.config.reasoningEffort,
			shellPath: loaded.config.shellPath,
			httpProxy: loaded.config.httpProxy,
			limits: loaded.config.limits,
			retry: loaded.config.retry,
			compaction: loaded.config.compaction,
			ui: loaded.config.ui,
			providers: Object.keys(loaded.providers.providers),
			mcpServers: loaded.config.mcpServers.map((server) => ({
				name: server.name,
				type: server.type,
				enabled: !server.disabled,
			})),
			skipped: loaded.skipped,
		};
	}

	/** 读取全局设置快照（密钥脱敏），供设置页渲染。 */
	async getSettings(): Promise<SettingsSnapshot> {
		return readSettings(this.#homeDir);
	}

	/**
	 * 写回全局设置补丁并失效配置缓存。
	 * @throws 补丁不合法或配置文件损坏时抛出错误。
	 */
	async updateSettings(patch: SettingsPatch): Promise<SettingsSnapshot> {
		const snapshot = await writeSettings(this.#homeDir, patch);
		this.#loadedConfigs.clear();
		return snapshot;
	}

	/** 读取供应商原始密钥表达式（`${ENV}` / `!command` 原样返回）。 */
	async revealProviderSecret(name: string): Promise<string> {
		return revealProviderSecret(this.#homeDir, name);
	}

	/**
	 * 读取供应商 `/models` 接口的可用模型；未提供 API Key 时复用已保存供应商的密钥。
	 * @throws Base URL/密钥缺失、供应商不存在、请求失败或响应无法解析时。
	 */
	async discoverModels(input: DiscoverModelsRequest): Promise<readonly DiscoveredModel[]> {
		let apiKey = input.apiKey?.trim() ?? "";
		if (apiKey.length === 0) {
			if (input.providerName === undefined) throw new Error("请先填写 API Key");
			apiKey = (await revealProviderSecret(this.#homeDir, input.providerName)).trim();
			if (apiKey.length === 0) throw new Error("请先填写 API Key");
		}
		return discoverProviderModels({
			api: input.api,
			baseUrl: input.baseUrl,
			apiKey,
			...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
		});
	}

	/**
	 * 按模型 ID 查询 models.dev 元数据用于回填表单。
	 * 优先读本地缓存，缓存过期时后台刷新；命中失败返回 null，不影响用户手填。
	 */
	async lookupModelMetadata(id: string): Promise<CatalogModelMetadata | null> {
		return lookupModelMetadataInCatalog(id, { cachePath: join(this.#homeDir, "model-catalog.json") });
	}

	/**
	 * 用当前表单中的供应商配置向指定模型发一条最小请求，验证连通性。
	 * 复用已保存供应商密钥（当未直接提供 apiKey 时）；不写入配置、不进入会话事件流。
	 * @returns 测试结果：成功时带回包预览，失败时带已脱敏的错误原因。
	 */
	async testModel(input: TestModelRequest): Promise<TestModelResult> {
		const started = Date.now();
		let apiKey = input.apiKey?.trim() ?? "";
		if (apiKey.length === 0) {
			if (input.providerName === undefined) {
				return { ok: false, durationMs: Date.now() - started, error: "请先填写 API Key" };
			}
			try {
				apiKey = (await revealProviderSecret(this.#homeDir, input.providerName)).trim();
			} catch (error) {
				return {
					ok: false,
					durationMs: Date.now() - started,
					error: error instanceof Error ? error.message : String(error),
				};
			}
			if (apiKey.length === 0) {
				return { ok: false, durationMs: Date.now() - started, error: "请先填写 API Key" };
			}
		}
		const client = this.#createLlmClient({ maxRetries: 0, maxDelayMs: 0 });
		try {
			const response = await client.complete({
				provider: input.providerName ?? "test",
				model: input.modelId,
				api: input.api,
				baseUrl: input.baseUrl,
				...(input.httpProxy ? { httpProxy: input.httpProxy } : {}),
				apiKey,
				...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
				maxTokens: 16,
				reasoningEffort: "off",
				messages: [{ role: "user", content: "Reply with OK." }],
			});
			const text = response.text.trim().slice(0, 200);
			return { ok: true, durationMs: Date.now() - started, ...(text.length > 0 ? { text } : {}) };
		} catch (error) {
			return {
				ok: false,
				durationMs: Date.now() - started,
				error: error instanceof Error ? error.message : String(error),
			};
		}
	}

	/** 新增或更新供应商；`apiKey: "***"` 保留原密钥。 */
	async upsertProvider(name: string, draft: ProviderDraft): Promise<SettingsSnapshot> {
		const snapshot = await upsertProvider(this.#homeDir, name, draft);
		this.#loadedConfigs.clear();
		return snapshot;
	}

	/** 删除供应商。 */
	async deleteProvider(name: string): Promise<SettingsSnapshot> {
		const snapshot = await deleteProvider(this.#homeDir, name);
		this.#loadedConfigs.clear();
		return snapshot;
	}

	/** 重命名供应商，保留原配置（含密钥与 headers）。 */
	async renameProvider(from: string, to: string): Promise<SettingsSnapshot> {
		const snapshot = await renameProvider(this.#homeDir, from, to);
		this.#loadedConfigs.clear();
		return snapshot;
	}

	/**
	 * 校验并读取本地图片为会话附件输入；不缩放、不转码。
	 * @throws 文件缺失、格式不支持或边长超过 2000 像素时抛出错误。
	 */
	async prepareImage(projectRoot: string, path: string): Promise<SessionImageInput> {
		return prepareImageFile(projectRoot, path);
	}

	/**
	 * 抓取网络图片并校验（用户显式粘贴/拖入 URL 时调用）。
	 * @param url http/https 图片地址。
	 * @returns 标准 Base64 数据、像素尺寸与来源 URL。
	 * @throws 目标为私网地址、HTTP 失败、超出体积或格式不受支持时抛出英文错误。
	 */
	async prepareImageUrl(url: string): Promise<SessionImageInput> {
		return prepareImageFromUrl(url, this.#options.fetch ? { fetch: this.#options.fetch } : {});
	}

	/**
	 * 校验内存图片字节（粘贴/拖拽）；与文件入口同一套格式与尺寸规则。
	 * @param bytes PNG/JPEG/WebP/GIF 原始字节。
	 */
	prepareImageBytes(bytes: Buffer): SessionImageInput {
		return prepareImageBuffer(bytes);
	}

	/**
	 * 读取历史输入图片附件，供界面渲染对话记录。
	 * @param sessionId 目标会话 ID。
	 * @param attachmentId user.input 事件里记录的附件 ID。
	 * @returns 标准 Base64 数据与原始元数据。
	 * @throws 附件缺失或 ID 非法时抛出错误。
	 */
	async readAttachment(
		sessionId: string,
		attachmentId: string,
	): Promise<{
		attachmentId: string;
		mediaType: UserInputImage["mediaType"];
		width: number;
		height: number;
		data: string;
	}> {
		const session = await this.#sessions.open(sessionId);
		const events = await session.events.read();
		let meta: UserInputImage | undefined;
		for (const event of events) {
			if (event.type !== "user.input") continue;
			meta = event.payload.images?.find((image) => image.attachmentId === attachmentId);
			if (meta) break;
		}
		if (!meta) throw new Error(`Unknown attachment: ${attachmentId}`);
		const bytes = await this.#attachments.get(session.directory, attachmentId);
		return {
			attachmentId,
			mediaType: meta.mediaType,
			width: meta.width,
			height: meta.height,
			data: bytes.toString("base64"),
		};
	}

	/** 创建共享统一管线的工具执行器。 */
	async createPipeline(options: {
		readonly session: Session;
		readonly projectRoot: string;
		readonly mode: Mode;
		readonly approval?: "ask" | "auto" | "yolo";
		readonly tools?: ReturnType<typeof createBuiltinTools>;
		/** 计划模式：叠加只读闸门（write/shell 直接拒绝）。 */
		readonly plan?: boolean;
		/** 工具实时输出回调。 */
		readonly onToolOutput?: (toolCallId: string, chunk: string) => void;
	}): Promise<ToolPipeline> {
		const projectRoot = resolve(options.projectRoot);
		const config = await this.#getConfig(projectRoot);
		// 会话内 /model 的切换只存在于内存，这里合并进来：辅助模型的「缺省复用主模型」
		// 必须跟随当前会话实际在用的模型，而不是配置文件里的默认值
		const selected = this.#sessionModels.get(options.session.meta.id);
		const effective: AppConfig = {
			...config.config,
			...(selected === undefined ? {} : { provider: selected.provider, model: selected.model }),
		};
		const tools = options.tools ?? createBuiltinTools(effective.shellPath ? { shellPath: effective.shellPath } : {});
		const approval = options.approval ?? effective.approval;
		// 只有 auto 档会把高危动作送审；其余档位省掉这次供应商解析
		const reviewCommand =
			approval === "auto"
				? await this.#createReviewCommand({ projectRoot, config: effective, providers: config.providers })
				: undefined;
		return new ToolPipeline({
			sessionId: options.session.meta.id,
			projectRoot,
			mode: options.mode,
			approval,
			...(options.plan === true ? { plan: true } : {}),
			sessionApproved: this.#approvedScopesFor(options.session.meta.id),
			events: options.session.events,
			snapshots: this.#snapshots,
			tools,
			...(this.#options.requestApproval ? { requestApproval: this.#options.requestApproval } : {}),
			...(reviewCommand === undefined ? {} : { reviewCommand }),
			spillThreshold: effective.limits.spillThreshold,
			spillDirectory: SPILL_DIRECTORY,
			...(this.#options.monotonicNow ? { monotonicNow: this.#options.monotonicNow } : {}),
			...(options.onToolOutput ? { onToolOutput: options.onToolOutput } : {}),
		});
	}

	/**
	 * 为项目准备 MCP 连接：装载配置并在后台启动全部启用的 server。
	 *
	 * 只做配置读取与启动，不等待握手；TUI 启动时先调用它，`mcpStatus` 立刻就有
	 * connecting 状态，首条消息前再由 `awaitMcpStartup` 做一次限时收口。
	 * @param projectRoot 项目根目录；MCP 配置只来自用户级 config.toml。
	 */
	async prepareMcp(projectRoot: string): Promise<void> {
		if (this.#disposed) return;
		const manager = await this.#ensureMcpManager(projectRoot);
		manager?.start();
	}

	/** 限时等待 MCP 启动收口；没有配置 server 时立即返回。 */
	async awaitMcpStartup(projectRoot: string): Promise<void> {
		const manager = await this.#ensureMcpManager(projectRoot);
		if (!manager) return;
		manager.start();
		await manager.awaitStartup();
	}

	/** 当前项目的 MCP 连接状态；尚未准备时返回空数组。 */
	mcpStatus(projectRoot: string): readonly McpStatus[] {
		return this.#mcpManagers.get(normalizeProjectRoot(resolve(projectRoot)))?.status() ?? [];
	}

	/**
	 * 手动重连一个 MCP server。
	 * @throws 没有配置任何 MCP server 或名称不存在时抛出。
	 */
	async reconnectMcp(projectRoot: string, name: string): Promise<string> {
		const manager = await this.#ensureMcpManager(projectRoot);
		if (!manager) throw new Error("No MCP servers are configured");
		manager.start();
		return manager.reconnect(name);
	}

	/** 检查全部 MCP 连接；没有配置时返回空数组。 */
	async healthCheckMcp(projectRoot: string): Promise<readonly string[]> {
		const manager = await this.#ensureMcpManager(projectRoot);
		if (!manager) return [];
		manager.start();
		return manager.healthCheck();
	}

	/**
	 * 使 MCP 相关缓存失效：配置缓存重读、旧管理器关闭并移除。
	 * 管理器持有构造时的配置快照，光清配置缓存不会更新已缓存的连接。
	 */
	async #invalidateMcp(projectRoot: string): Promise<void> {
		this.#loadedConfigs.clear();
		const key = normalizeProjectRoot(resolve(projectRoot));
		const manager = this.#mcpManagers.get(key);
		if (manager !== undefined) {
			await manager.close();
			this.#mcpManagers.delete(key);
		}
	}

	/**
	 * 新增或更新一个 MCP server：校验 → 写回 config.toml → 重建运行时连接。
	 * 写盘在缓存失效之前，失败时现有连接不受影响。
	 * @param name server 名（config.toml 的表名，只允许字母数字 - _）。
	 * @param draft 传输方式与参数；校验复用 parseMcpServers。
	 * @returns 规范化后的 server 配置（含推断的 type 与默认值）。
	 */
	async upsertMcpServer(projectRoot: string, name: string, draft: McpServerDraft): Promise<McpServerConfig> {
		if (this.#disposed) throw new Error("Core is disposed");
		const config = validateMcpServerDraft(name, draft);
		await updateGlobalMcpServers({ set: { [name]: draft } }, { homeDir: this.#homeDir });
		await this.#invalidateMcp(projectRoot);
		const manager = await this.#ensureMcpManager(projectRoot);
		manager?.start();
		return config;
	}

	/** 删除一个 MCP server：写回 config.toml 后重建运行时（删掉最后一个时状态自然为空）。 */
	async removeMcpServer(projectRoot: string, name: string): Promise<void> {
		if (this.#disposed) throw new Error("Core is disposed");
		await updateGlobalMcpServers({ remove: [name] }, { homeDir: this.#homeDir });
		await this.#invalidateMcp(projectRoot);
		const manager = await this.#ensureMcpManager(projectRoot);
		manager?.start();
	}

	/** 重新加载 MCP 配置并重建运行时连接（使用者手改 config.toml 后调用）。 */
	async reloadMcp(projectRoot: string): Promise<void> {
		if (this.#disposed) throw new Error("Core is disposed");
		await this.#invalidateMcp(projectRoot);
		const manager = await this.#ensureMcpManager(projectRoot);
		manager?.start();
	}

	/**
	 * 取项目的 MCP 管理器；配置为空时不创建，配置损坏时告警并降级为无 MCP。
	 * 非致命：MCP 是可选能力，配置问题不应让会话跑不起来。
	 */
	async #ensureMcpManager(projectRoot: string): Promise<McpManager | undefined> {
		if (this.#disposed) return undefined;
		const root = resolve(projectRoot);
		const key = normalizeProjectRoot(root);
		const existing = this.#mcpManagers.get(key);
		if (existing) return existing;
		try {
			const loaded = await this.#getConfig(root);
			if (loaded.config.mcpServers.length === 0) return undefined;
			const manager = new McpManager({
				projectRoot: root,
				servers: loaded.config.mcpServers,
				version: VERSION,
				...(this.#options.env ? { env: this.#options.env } : {}),
				...(this.#options.fetch ? { fetch: this.#options.fetch } : {}),
			});
			this.#mcpManagers.set(key, manager);
			return manager;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.#options.onWarning?.(`Cannot load MCP configuration: ${message}`);
			return undefined;
		}
	}

	/**
	 * 建立高危动作的审查回调。
	 *
	 * `review_model` 支持 `modelId` 与 `provider/modelId` 两种写法；不填时复用会话模型——
	 * auto 档默认是有审查的，只是审查者与被审查者同为那个模型。要真正的第三方视角，
	 * 就显式配成另一个模型。解析失败只降级为「无审查」并告警，不让整个会话跑不起来。
	 */
	async #createReviewCommand(options: {
		readonly projectRoot: string;
		readonly config: AppConfig;
		readonly providers: ProvidersFile;
	}): Promise<((request: ReviewRequest, signal?: AbortSignal) => Promise<ReviewVerdict>) | undefined> {
		const configured = options.config.reviewModel;
		const ref =
			configured === undefined
				? {
						...(options.config.provider === undefined ? {} : { provider: options.config.provider }),
						model: options.config.model ?? "",
					}
				: parseModelRef(configured, options.providers);
		const provider = ref.provider ?? options.config.provider;
		// 没有可用模型时退回人工：宁可多问一次，也不要拿一个空请求去撞供应商
		if (provider === undefined || ref.model.length === 0) return undefined;
		const active = await this.#resolveAuxProvider(
			{ provider, model: ref.model },
			options.config,
			options.providers,
			"Reviewer",
		);
		if (active === undefined) return undefined;
		if (
			configured !== undefined &&
			active.name === options.config.provider &&
			active.modelId === options.config.model
		) {
			// 显式配成同一个模型是使用者的选择，但要让它在日志里留痕：同一个模型审自己，
			// 比没人审更容易给出「没问题」。
			this.#options.onWarning?.("review_model resolves to the session model; the reviewer will grade its own work");
		}
		return createCommandReviewer({
			llm: this.#createLlmClient(options.config.retry),
			request: this.#modelRequest(active, options.config, { maxTokens: 512, reasoningEffort: "off" }),
			modelLabel: `${active.name}/${active.modelId}`,
			timeoutSec: options.config.limits.reviewTimeoutSec,
			projectRoot: options.projectRoot,
		});
	}

	/**
	 * 解析辅助模型（审查、压缩）用的供应商。
	 *
	 * 供应商来自引用本身或会话当前那一个；辅助调用沿用该供应商的端点与凭据，
	 * 不额外解析第二套密钥。
	 * @returns 解析成功返回供应商；解析失败返回 undefined，由调用方降级。
	 */
	async #resolveAuxProvider(
		ref: { readonly provider: string; readonly model: string },
		config: AppConfig,
		providers: ProvidersFile,
		label: string,
	): Promise<ResolvedProvider | undefined> {
		try {
			return await resolveActiveProvider({ ...config, provider: ref.provider, model: ref.model }, providers, {
				runCommand: runSecretCommand,
				...(this.#options.env ? { env: this.#options.env } : {}),
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.#options.onWarning?.(`${label} model is unavailable: ${message}`);
			return undefined;
		}
	}

	/** 由解析后的供应商拼出请求模板；主流程、审查与压缩共用，避免三处字段漂移。 */
	#modelRequest(
		active: ResolvedProvider,
		config: AppConfig,
		overrides: { readonly maxTokens?: number; readonly reasoningEffort?: ReasoningEffort } = {},
	): Omit<ModelRequest, "messages"> {
		return {
			provider: active.name,
			model: active.modelId,
			api: active.api,
			baseUrl: active.baseUrl,
			...(config.httpProxy ? { httpProxy: config.httpProxy } : {}),
			apiKey: active.apiKey,
			...(Object.keys(active.headers).length > 0 ? { headers: active.headers } : {}),
			timeoutMs: active.timeoutMs,
			streamIdleTimeoutSec: config.limits.streamIdleTimeoutSec,
			maxTokens: overrides.maxTokens ?? active.maxTokens,
			reasoningEffort: overrides.reasoningEffort ?? config.reasoningEffort,
		};
	}

	/** 取会话级放行作用域集合；同一会话的每条管线共享同一份，首次使用时创建。 */
	#approvedScopesFor(sessionId: string): Set<string> {
		let scopes = this.#sessionApprovedScopes.get(sessionId);
		if (scopes === undefined) {
			scopes = new Set();
			this.#sessionApprovedScopes.set(sessionId, scopes);
		}
		return scopes;
	}

	/**
	 * 运行或恢复一个会话；工具调用始终通过 Harness 管线。
	 * @param session 目标会话及其 append-only 事件流。
	 * @param text 本次用户输入文本；可以为空但仍须提供图片时有效。
	 * @param options 取消信号与图片附件选项。
	 * @returns 会话完整规范消息及运行状态。
	 * @throws 配置无效、图片数据不合规、模型不支持图片或同会话已有运行时抛出错误。
	 */
	async runSession(session: Session, text = "", options: RunSessionOptions = {}): Promise<LoopResult> {
		return this.#withSessionLease(session, () => this.#runSessionUnlocked(session, text, options));
	}

	async #runSessionUnlocked(session: Session, text: string, options: RunSessionOptions): Promise<LoopResult> {
		const sessionId = session.meta.id;
		if (this.#sessionLoops.has(sessionId)) throw new Error("Agent loop is already running");
		const { projectRoot, config, active, llm, request, compactor } = await this.#resolveRuntime(
			session,
			options.signal,
		);
		const imageInputs = SessionImageInputSchema.array().parse(options.images ?? []);
		if (imageInputs.length > 0 && !active.input.includes("image")) {
			throw new Error(`Model ${active.name}/${active.modelId} does not accept image input`);
		}
		const imageAttachments = await this.#storeImages(session.directory, imageInputs);
		const plan = this.#sessionPlans.get(sessionId) === true;
		// 技能清单要在构造工具面之前拿到：有技能才注入 skill 工具，且工具与系统提示词
		// 必须基于同一份清单（否则清单里列了技能、工具却查不到）。
		const skills = await this.listSkills(projectRoot);
		// MCP 工具只进主会话：子代理的任务是收敛的独立工作，给它一套远端工具会扩大权限面，
		// 也让「子代理工具面受限」这条约束失效。主代理可以先调 MCP 再把结果写进任务说明。
		const mcp = options.subagent ? undefined : await this.#ensureMcpManager(projectRoot);
		if (mcp) {
			mcp.start();
			await mcp.awaitStartup();
		}
		const mcpTools = mcp?.tools() ?? [];
		// 递归深度 1：只有主会话（非子代理）才注入 task 执行通道；子代理的工具面没有 task
		const baseTools = options.subagent
			? createBuiltinTools(config.shellPath ? { shellPath: config.shellPath } : {})
			: createBuiltinTools({
					...(config.shellPath ? { shellPath: config.shellPath } : {}),
					taskRunner: (task, context) => this.#runSubagent(session, projectRoot, task, context, options),
				});
		const tools = [
			...baseTools,
			...mcpTools,
			// 有技能才装配 skill 工具：模型按清单里的名字加载正文，绕开工作区外的路径沙箱。
			...(skills.length > 0 ? [createSkillTool(skills)] : []),
			...(plan ? [createPresentPlanTool()] : []),
		];
		const pipeline = await this.createPipeline({
			session,
			projectRoot,
			mode: session.meta.mode,
			approval: config.approval,
			tools,
			...(plan ? { plan: true } : {}),
			...(options.onToolOutput ? { onToolOutput: options.onToolOutput } : {}),
		});
		const toolSchemas = tools.map((tool) =>
			ToolSchema.parse({
				name: tool.name,
				description: tool.description,
				// 外部工具（MCP）自带 JSON Schema；内置工具才需要从 zod 推导
				parameters: tool.parameters ?? (z.toJSONSchema(tool.schema) as Record<string, unknown>),
			}),
		);
		// 工作区指令（ADR-16）：用户级直接生效；项目级仅在已信任时读取（未信任=提示词注入面）
		const instructions = await loadWorkspaceInstructions({
			homeDir: this.#homeDir,
			projectRoot,
			includeProject: !(await this.#isTrustGated(projectRoot)),
			// 本次运行的回调优先；旧实现声明了 RunSessionOptions.onWarning 却从不消费
			onSkip: (message) => (options.onWarning ?? this.#options.onWarning)?.(message),
		});
		// ADR-15：探测不注入提示词，模型按需探索；提示词由 system-prompt.ts 追加式组装
		const systemMessage = buildSystemMessage({
			toolNames: tools.map((tool) => tool.name),
			instructionsSection: formatInstructionsSection(instructions),
			skillsSection: formatSkillsSection(skills),
			workingDirectory: options.internalWorkspace === true ? undefined : projectRoot,
			plan,
		});
		const loop = new AgentLoop({
			llm,
			request: { ...request, tools: toolSchemas },
			events: session.events,
			systemMessage,
			compactor,
			contextWindow: active.contextWindow,
			maxTurns: config.limits.maxTurns,
			breakpoint: createPolicy(session.meta.mode, plan).breakpoint,
			...(options.onText ? { onText: options.onText } : {}),
			...(options.onReasoning ? { onReasoning: options.onReasoning } : {}),
			...(options.onRetry ? { onRetry: options.onRetry } : {}),
			loadImage: async (image) =>
				(await this.#attachments.get(session.directory, image.attachmentId)).toString("base64"),
			tools: {
				execute: async (invocation, execution) => {
					const result = await pipeline.run(
						invocation.name,
						invocation.arguments,
						execution.corr,
						execution.signal,
						invocation.id,
					);
					return {
						content: result.content,
						...(result.isError ? { isError: true } : {}),
						...(result.paused ? { paused: true } : {}),
					};
				},
			},
		});
		this.#sessionLoops.set(sessionId, loop);
		this.#sessionPipelines.set(sessionId, pipeline);
		const signal = options.signal;
		const abortLoop = () => loop.abort(signal?.reason);
		try {
			// 标题后台生成（opencode 模式）：输入可见即并行发起，不 await、不阻塞主请求
			if (text.length > 0) this.#scheduleTitleGeneration(session, llm, request, text);
			const running = loop.run(text, imageAttachments);
			if (signal) {
				if (signal.aborted) abortLoop();
				else signal.addEventListener("abort", abortLoop, { once: true });
			}
			return await running;
		} finally {
			signal?.removeEventListener("abort", abortLoop);
			if (this.#sessionLoops.get(sessionId) === loop) this.#sessionLoops.delete(sessionId);
			if (this.#sessionPipelines.get(sessionId) === pipeline) this.#sessionPipelines.delete(sessionId);
		}
	}

	/**
	 * 调度后台会话标题生成（fire-and-forget）。
	 *
	 * 仅当会话仍无显式命名（`isAutoTitleable`）时接管；生成与写回全部后台完成，
	 * 失败只经 onWarning 留诊断痕迹，绝不影响主回合。写回前在租约内复查接管条件——
	 * 用户在生成期间手动改名则放弃写入，等价于对改名竞态的 CAS。在飞按会话去重；
	 * 任务 settle 后移除条目，会话仍未命名时下回合自然重试。
	 */
	#scheduleTitleGeneration(
		session: Session,
		llm: LlmClient,
		request: Omit<ModelRequest, "messages">,
		text: string,
	): void {
		const sessionId = session.meta.id;
		if (this.#titleTasks.has(sessionId)) return;
		const generateTitle = createTitleGenerator({
			llm,
			request,
			...(this.#options.onWarning === undefined ? {} : { onWarning: this.#options.onWarning }),
		});
		const task = (async () => {
			if (!(await this.#sessions.isAutoTitleable(session))) return;
			const title = await generateTitle(text);
			if (title === undefined) return;
			await this.#withSessionLease(session, async () => {
				if (!(await this.#sessions.isAutoTitleable(session))) return;
				await this.#sessions.rename(session, title);
			});
		})()
			.catch((error) => {
				// 生成器内部错误已走 onWarning；这里兜底的是租约忙（跨进程）等周边错误
				const message = error instanceof Error ? error.message : String(error);
				this.#options.onWarning?.(`Session title generation failed: ${message}`);
			})
			.finally(() => {
				if (this.#titleTasks.get(sessionId) === task) this.#titleTasks.delete(sessionId);
			});
		this.#titleTasks.set(sessionId, task);
	}

	/**
	 * 运行一次 task 委派：一次性子会话，跑完只回传最终文本，子会话随即删除。
	 *
	 * 串行由 agent-loop 的工具执行模型天然保证（一次只跑一个工具调用）；递归由 runSession
	 * 的 `subagent` 标记掐断（子代理工具面没有 task）。子会话独立事件流完整落盘供审计，
	 * 删除失败不影响结果回传——审计记录只是晚一点被清理。
	 * @param projectRoot 主会话的项目根；子代理共享同一工作区与信任决定。
	 * @param task 模型给的完整任务说明。
	 * @param context 管线传入的工具上下文；signal 用于把主回合的中止传导进子代理。
	 * @returns 回传给主对话的最终文本与结构化统计；失败时 isError 为真。
	 */
	async #runSubagent(
		parent: Session,
		projectRoot: string,
		task: string,
		context: ToolContext,
		runOptions: RunSessionOptions,
	): Promise<ToolResult> {
		const startedAt = Date.now();
		const toolCallId = context.toolCallId ?? "task";
		// 与主会话同挂 creator 档（ADR-14）：写动作沿用主会话审批档位；
		// standard 档会整体拒绝写并过滤审计，与「委派可含批量整理」的设计相悖。
		const session = await this.#sessions.create(resolve(projectRoot), {
			mode: "creator",
			title: "Subagent task",
		});
		const warn = (error: unknown): void => {
			this.#options.onWarning?.(
				`Subagent event write failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		};
		await parent.append({ type: "subagent.started", payload: { toolCallId, task: task.slice(0, 2_000) } }).catch(warn);
		const signal = context.signal;
		let progressTimer: NodeJS.Timeout | undefined;
		if (runOptions.onSubagent !== undefined) {
			progressTimer = setInterval(() => {
				void this.#subagentStats(session, Date.now() - startedAt).then((stats) => {
					runOptions.onSubagent?.({
						toolCallId,
						steps: stats.steps,
						totalTokens: stats.totalTokens,
						elapsedMs: Date.now() - startedAt,
					});
				});
			}, 500);
			progressTimer.unref();
		}
		try {
			const result = await this.runSession(session, task, {
				subagent: true,
				...(runOptions.internalWorkspace === true ? { internalWorkspace: true } : {}),
				...(signal ? { signal } : {}),
			});
			const finalText = lastAssistantText(result.messages);
			const stats = await this.#subagentStats(session, Date.now() - startedAt);
			// abort 的语义由外层回合统一描述；这里只区分「有产出」与「没跑完」
			const aborted = signal?.aborted ?? false;
			await parent
				.append({
					type: "subagent.finished",
					payload: {
						toolCallId,
						steps: stats.steps,
						totalTokens: stats.totalTokens,
						durationMs: stats.durationMs,
						ok: !aborted,
						paused: stats.paused,
						preview: finalText.slice(0, 500),
					},
				})
				.catch(warn);
			const content =
				aborted && finalText.length === 0
					? "Subagent was cancelled before producing a result."
					: finalText.length > 0
						? finalText
						: "The subagent finished without a final answer.";
			// 统计放开头：结果超 spillThreshold 落盘时模型只看到前 1KB 预览，放尾部会被截掉
			return {
				content: `[subagent] steps: ${stats.steps} · tokens: ${stats.totalTokens} · ${(Date.now() - startedAt) / 1000}s\n\n${content}`,
				...(aborted && finalText.length === 0 ? { isError: true } : {}),
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : "Subagent failed";
			await parent
				.append({
					type: "subagent.finished",
					payload: {
						toolCallId,
						steps: 0,
						totalTokens: 0,
						durationMs: Date.now() - startedAt,
						ok: false,
						paused: false,
						preview: message.slice(0, 500),
					},
				})
				.catch(warn);
			return { content: `Subagent failed: ${message}`, isError: true };
		} finally {
			if (progressTimer) clearInterval(progressTimer);
			// 子会话只留审计痕迹：结果已经回传主对话，事件流不再有消费方
			this.#sessionApprovedScopes.delete(session.meta.id);
			await this.#sessions.delete(session.meta.id).catch(() => undefined);
		}
	}

	/** 汇总子会话事件流里的请求步数与 token 用量；事件读不出来时按 0 处理。 */
	async #subagentStats(session: Session, durationMs: number): Promise<SubagentRunStats> {
		let steps = 0;
		let totalTokens = 0;
		try {
			for (const event of await session.events.read()) {
				if (event.type !== "llm.response") continue;
				steps += 1;
				const usage = event.payload.usage;
				if (typeof usage === "object" && usage !== null) {
					const input = typeof usage.inputTokens === "number" ? usage.inputTokens : 0;
					const output = typeof usage.outputTokens === "number" ? usage.outputTokens : 0;
					totalTokens += input + output;
				}
			}
		} catch {
			// 审计失败不阻断结果回传
		}
		return { steps, totalTokens, durationMs, paused: false };
	}

	/** 在当前模型或工具步骤结束后暂停指定会话。 */
	pauseSession(sessionId: string): void {
		if (!this.#requireLoop(sessionId).pause()) throw new Error("Breakpoints are disabled by the active policy");
	}

	/** 恢复指定会话的暂停 Loop。 */
	resumeSession(sessionId: string): void {
		if (!this.#requireLoop(sessionId).resume()) throw new Error("Breakpoints are disabled by the active policy");
	}

	/** 取消指定会话当前执行。 */
	abortSession(sessionId: string, reason?: unknown): void {
		this.#requireLoop(sessionId).abort(reason);
	}

	/**
	 * 立即压缩会话上下文（/compact）：重放事件流、强制生成摘要并写入 compaction.done。
	 * 之后的新请求与重启后的恢复都会使用折叠后的上下文；原始事件流不动。
	 * @param session 目标会话。
	 * @param options 中止信号。
	 * @returns 压缩统计；上下文不足以压缩时 compacted 为 false。
	 * @throws 配置无效或模型缺少上下文窗口时抛出错误。
	 */
	async compactSession(
		session: Session,
		options: { readonly signal?: AbortSignal } = {},
	): Promise<{
		readonly compacted: boolean;
		readonly covered: number;
		readonly tokensBefore: number;
		readonly tokensAfter: number;
		readonly fromSeq: number;
		readonly toSeq: number;
		readonly summaryChars: number;
	}> {
		return this.#withSessionLease(session, () => this.#compactSessionUnlocked(session, options));
	}

	async #compactSessionUnlocked(
		session: Session,
		options: { readonly signal?: AbortSignal },
	): Promise<{
		readonly compacted: boolean;
		readonly covered: number;
		readonly tokensBefore: number;
		readonly tokensAfter: number;
		readonly fromSeq: number;
		readonly toSeq: number;
		readonly summaryChars: number;
	}> {
		const { active, compactor } = await this.#resolveRuntime(session, options.signal);
		const replayed = await replayMessages(await session.events.read(), async (image: UserInputImage) =>
			(await this.#attachments.get(session.directory, image.attachmentId)).toString("base64"),
		);
		const result = await compactor.compact(replayed.messages, active.contextWindow, options.signal, replayed.seqs, {
			force: true,
		});
		return {
			compacted: result.compacted,
			covered: result.covered ?? 0,
			tokensBefore: result.tokensBefore ?? 0,
			tokensAfter: result.tokensAfter ?? 0,
			fromSeq: result.fromSeq ?? 0,
			toSeq: result.toSeq ?? 0,
			summaryChars: result.summaryChars ?? 0,
		};
	}

	/**
	 * 只读审查：在一次性标准模式会话里运行审查子代理，完成后删除该会话。
	 * @param projectRoot 项目根目录。
	 * @param prompt 审查范围/关注点；为空时使用缺省说明。
	 * @param options 中止信号与流式文本回调。
	 * @returns 审查报告文本与运行统计。
	 */
	async reviewSession(
		projectRoot: string,
		prompt: string,
		options: {
			readonly signal?: AbortSignal;
			readonly onText?: (text: string) => void;
			readonly onRetry?: () => void;
			readonly internalWorkspace?: boolean;
		} = {},
	): Promise<{ readonly report: string; readonly turns: number; readonly stopReason: "done" | "steps" | "aborted" }> {
		const root = resolve(projectRoot);
		const session = await this.#sessions.create(root, { mode: "standard", title: "Code review" });
		try {
			const scope =
				prompt.trim().length > 0
					? prompt.trim()
					: "Review the current workspace for correctness, security, and maintainability issues.";
			const instruction = `${REVIEW_INSTRUCTION}\n\nReview scope:\n${scope}`;
			const result = await this.runSession(session, instruction, {
				...(options.signal ? { signal: options.signal } : {}),
				...(options.onText ? { onText: options.onText } : {}),
				...(options.onRetry ? { onRetry: options.onRetry } : {}),
				...(options.internalWorkspace === true ? { internalWorkspace: true } : {}),
			});
			const lastAssistant = [...result.messages].reverse().find((message) => message.role === "assistant");
			const report = typeof lastAssistant?.content === "string" ? lastAssistant.content : "";
			return {
				report,
				turns: result.turns,
				stopReason: options.signal?.aborted ? "aborted" : result.paused ? "steps" : "done",
			};
		} finally {
			this.#sessionApprovedScopes.delete(session.meta.id);
			await this.#sessions.delete(session.meta.id).catch(() => undefined);
		}
	}

	#requireLoop(sessionId: string): AgentLoop {
		const loop = this.#sessionLoops.get(sessionId);
		if (!loop) throw new Error(`Session ${sessionId} has no active loop`);
		return loop;
	}

	async #storeImages(
		sessionDirectory: string,
		images: readonly z.infer<typeof SessionImageInputSchema>[],
	): Promise<UserInputImage[]> {
		// 单条消息的图片预算在这里兜底：TUI 也有更严格的同名限制，但 Core 是公共入口，
		// 不能把「外部输入不可信」的校验寄托在某一层界面上。
		if (images.length > MAX_IMAGES_PER_REQUEST) {
			throw new Error(`Too many images: ${images.length}; the maximum per message is ${MAX_IMAGES_PER_REQUEST}`);
		}
		const totalBytes = images.reduce((sum, image) => sum + Buffer.byteLength(image.data, "base64"), 0);
		if (totalBytes > MAX_IMAGE_BYTES_PER_REQUEST) {
			throw new Error(
				`Images total ${formatImageBytes(totalBytes)}; the maximum per message is ${formatImageBytes(MAX_IMAGE_BYTES_PER_REQUEST)}`,
			);
		}
		const stored = images.map((image) => {
			const data = Buffer.from(image.data, "base64");
			if (data.toString("base64") !== image.data) throw new Error("Image data must use canonical Base64 encoding");
			return {
				attachmentId: randomUUID().replaceAll("-", ""),
				mediaType: image.mediaType,
				width: image.width,
				height: image.height,
				bytes: data.byteLength,
				data,
				...(image.sourceUrl === undefined ? {} : { sourceUrl: image.sourceUrl }),
			};
		});
		await Promise.all(stored.map((image) => this.#attachments.put(sessionDirectory, image.attachmentId, image.data)));
		return stored.map((image) => ({
			attachmentId: image.attachmentId,
			mediaType: image.mediaType,
			width: image.width,
			height: image.height,
			bytes: image.bytes,
			...(image.sourceUrl === undefined ? {} : { sourceUrl: image.sourceUrl }),
		}));
	}

	/** 清理系统临时目录中超过保留期的 spill 日志；清理失败静默，不影响运行。 */
	async #pruneSpillLogs(): Promise<void> {
		const retentionMs = 7 * 24 * 60 * 60 * 1000;
		const cutoff = Date.now() - retentionMs;
		try {
			const entries = await readdir(SPILL_DIRECTORY);
			await Promise.all(
				entries.map(async (entry) => {
					const path = join(SPILL_DIRECTORY, entry);
					const info = await stat(path).catch(() => undefined);
					if (!info?.isFile() || info.mtimeMs >= cutoff) return;
					await unlink(path).catch(() => undefined);
				}),
			);
		} catch {
			// 目录不存在或不可读都无所谓；spill 只是易失的执行副产物
		}
	}

	/** 校验事件并生成按事件顺序排列的回放数据。 */
	async replay(sessionId: string): Promise<readonly EventRecord[]> {
		const session = await this.#sessions.open(sessionId);
		return session.events.read();
	}

	/**
	 * 导出会话为 JSON 结构化快照、Markdown 或自包含 HTML；按目标扩展名选格式。
	 * @param session 目标会话；导出只读其事件流，不追加、不改写。
	 * @param target 目标路径；相对路径基于项目根解析，缺省为 `<项目根>/moros-<sid>.md`。
	 * @returns 导出结果（经沙箱校验的绝对路径、格式、字节数、是否为新文件）。
	 * @throws 目标越出项目沙箱、落在保护目录、或写入失败时抛出错误。
	 */
	async exportSession(
		session: Session,
		target?: string,
		options: { allowOutsideSandbox?: boolean } = {},
	): Promise<SessionExportResult> {
		const filename = target ?? `moros-${session.meta.id}.md`;
		const path =
			options.allowOutsideSandbox === true && target !== undefined && isAbsolute(target)
				? resolve(target)
				: await resolveSandboxPath(session.meta.projectRoot, filename, { allowMissingLeaf: true });
		const extension = extname(path).toLowerCase();
		const format: SessionExportFormat =
			extension === ".json" ? "json" : extension === ".html" || extension === ".htm" ? "html" : "markdown";
		const events = await session.events.read();
		const content = renderSessionExport(session.meta, events, format);
		const created = !existsSync(path);
		await atomicWriteFile(path, content);
		return { path, format, bytes: Buffer.byteLength(content, "utf8"), created };
	}

	/**
	 * 聚合会话用量：上下文占用取最近一次请求的输入 token，缓存命中率取累计缓存读取 / 累计总输入。
	 * @param session 目标会话；只读事件流。
	 * @returns 可直接交给页脚显示的指标；无用量事件时各项为 0。
	 */
	async getSessionMetrics(session: Session): Promise<SessionMetrics> {
		const events = await session.events.read();
		let inputTokens = 0;
		let outputTokens = 0;
		let cacheReadTokens = 0;
		let cacheWriteTokens = 0;
		let contextUsed = 0;
		for (const event of events) {
			if (event.type !== "llm.response") continue;
			const usage = usageOf(event.payload.usage);
			if (!usage) continue;
			inputTokens += usage.inputTokens;
			outputTokens += usage.outputTokens;
			cacheReadTokens += usage.cacheReadTokens;
			cacheWriteTokens += usage.cacheWriteTokens;
			contextUsed = usage.inputTokens;
		}
		const cacheHitRate = inputTokens > 0 ? Math.min(1, Math.max(0, cacheReadTokens / inputTokens)) : 0;
		return { contextUsed, cacheHitRate, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens };
	}

	/**
	 * 按项目聚合跨会话审计记录；数据源是各会话的 append-only 事件流，不再维护第二份投影。
	 * @param projectRoot 项目根目录；只聚合该项目的会话。
	 * @param options grep 为可选正则，匹配整条记录的序列化文本。
	 * @returns 形如 `{ sid, seq, type, summary }` 的记录，按会话创建顺序与 seq 排列。
	 * @throws 正则无效或会话事件流损坏（seq 不连续、末行残缺）时抛出错误。
	 */
	async readAudit(projectRoot: string, options: { grep?: string } = {}): Promise<readonly Record<string, unknown>[]> {
		const root = resolve(projectRoot);
		const matcher = options.grep !== undefined ? new RegExp(options.grep) : undefined;
		const metas = await this.#sessions.list(root);
		const records: Record<string, unknown>[] = [];
		for (const meta of metas) {
			const session = await this.#sessions.open(meta.id);
			const events = await session.events.read();
			// 标准模式只保留拒绝/错误类事件，与两套策略的差异一致。
			const full = meta.mode === "creator";
			for (const event of events) {
				if (!full && !["error", "limit.blocked", "approval.denied"].includes(event.type)) continue;
				const record: Record<string, unknown> = {
					sid: meta.id,
					seq: event.seq,
					type: event.type,
					summary: auditSummary(event),
				};
				if (!matcher || matcher.test(JSON.stringify(record))) records.push(record);
			}
		}
		return records;
	}

	/** 生成项目范围的配置、供应商与本机依赖诊断。 */
	async doctor(projectRoot?: string): Promise<DiagnosticReport> {
		const errors: string[] = [];
		let configLoaded = false;
		let providers: DiagnosticReport["providers"] = [];
		let mcpServers: DiagnosticReport["mcpServers"] = [];
		try {
			const loaded = await this.#getConfig(projectRoot ? resolve(projectRoot) : "");
			configLoaded = true;
			// 选择有效性诊断（ADR-15）：加载期不再阻断，但 doctor 必须把失效的选择报出来
			const { provider, model } = loaded.config;
			if (provider && !loaded.providers.providers[provider]) {
				errors.push(`Unknown provider configured: ${provider}`);
			} else if (
				provider &&
				model &&
				!loaded.providers.providers[provider]!.models.some((candidate) => candidate.id === model)
			) {
				errors.push(`Unknown model configured: ${provider}/${model}`);
			}
			// 逐条容错跳过的坏条目：不阻断加载，但 doctor 必须列出来让使用者能修
			for (const skip of loaded.skipped) {
				errors.push(`Skipped invalid config entry at ${skip.path}: ${skip.reason}`);
			}
			providers = Object.entries(loaded.providers.providers).map(([name, provider]) => ({
				name,
				available: providerHasConfiguredCredential(provider, this.#options.env ?? process.env),
				modelCount: provider.models.length,
			}));
			mcpServers = loaded.config.mcpServers.map((server) => ({
				name: server.name,
				type: server.type,
				enabled: !server.disabled,
			}));
		} catch (error) {
			errors.push(error instanceof Error ? error.message : "Configuration validation failed");
		}
		return {
			nodeVersion: process.version,
			configLoaded,
			providers,
			mcpServers,
			environment: await detectEnvironment(this.#options.env ? { env: this.#options.env } : {}),
			errors,
		};
	}

	/** 按指定项目配置解析当前激活供应商，密钥不会写入诊断或审计。 */
	async resolveProvider(projectRoot?: string) {
		const loaded = await this.#getConfig(projectRoot ? resolve(projectRoot) : "");
		return resolveActiveProvider(loaded.config, loaded.providers, {
			runCommand: runSecretCommand,
			...(this.#options.env ? { env: this.#options.env } : {}),
		});
	}

	/**
	 * 汇总会话消息、文件变更与 Shell 命令并保存 Markdown 报告。
	 * @param sessionId 目标会话 ID。
	 * @param summarize 自定义总结器；缺省时通过当前激活模型以独立请求生成总结。
	 * @throws 未配置激活模型且未提供总结器时抛出错误。
	 */
	async generateReport(sessionId: string, summarize?: (input: ReportInput) => Promise<string>): Promise<string> {
		return (await this.generateReportResult(sessionId, summarize)).text;
	}

	/**
	 * 与会话 generateReport 相同，但额外返回报告文件路径，供宿主直接打开。
	 */
	async generateReportResult(
		sessionId: string,
		summarize?: (input: ReportInput) => Promise<string>,
	): Promise<{ text: string; path: string }> {
		const session = await this.#sessions.open(sessionId);
		return this.#withSessionLease(session, () => this.#generateReportUnlocked(session, summarize));
	}

	async #generateReportUnlocked(
		session: Session,
		summarize?: (input: ReportInput) => Promise<string>,
	): Promise<{ text: string; path: string }> {
		const summarizer = summarize ?? (await this.#createModelSummarizer(resolve(session.meta.projectRoot)));
		const events = await session.events.read();
		const messages = events
			.filter((event) => event.type === "user.input" || event.type === "llm.response")
			.map((event): CanonicalMessage =>
				event.type === "user.input"
					? { role: "user", content: event.payload.text }
					: { role: "assistant", content: event.payload.text },
			);
		const fileChanges = events
			.filter((event) => event.type === "file.changed")
			.map((event) => ({ path: event.payload.path, op: event.payload.op }));
		const commands = events.flatMap((event) => {
			if (event.type !== "tool.call" || (event.payload.tool !== "bash" && event.payload.tool !== "powershell"))
				return [];
			const args = asRecordOrEmpty(event.payload.args);
			return typeof args.command === "string" ? [{ tool: event.payload.tool, command: args.command }] : [];
		});
		const report = await summarizer({ messages, fileChanges, commands });
		const reportPath = join(session.directory, "report.md");
		await mkdir(session.directory, { recursive: true });
		await writeFile(reportPath, report, { flag: "w" });
		return { text: report, path: reportPath };
	}

	/**
	 * 读取工作区信任状态与需要展示的资源清单。
	 * @param projectRoot 项目根目录。
	 * @returns required 是否存在需要信任的资源；decision true/false/null（null 待询问）；
	 *          files 信任页展示的配置/技能文件；skillDirectories 项目技能目录。
	 */
	async getWorkspaceTrust(projectRoot: string): Promise<{
		readonly required: boolean;
		readonly decision: boolean | null;
		readonly files: readonly string[];
		readonly skillDirectories: readonly string[];
	}> {
		const global = await this.#getConfig("");
		const resources = workspaceTrustResources(projectRoot);
		const files = [
			...(resources.projectConfig === undefined ? [] : [resources.projectConfig]),
			...(resources.agentsFile === undefined ? [] : [resources.agentsFile]),
			...(resources.skillsDirectory === undefined ? [] : trustPromptSkillFiles(resources.skillsDirectory)),
		];
		return {
			required: requiresWorkspaceTrust(projectRoot),
			decision: resolveWorkspaceTrust(global.config, projectRoot, this.#sessionTrust),
			files,
			skillDirectories: resources.skillsDirectory === undefined ? [] : [resources.skillsDirectory],
		};
	}

	/**
	 * 授予工作区信任。
	 * @param projectRoot 项目根目录。
	 * @param remember true 写入 config.toml 的 [trusts] 表；false 只对本次运行生效。
	 */
	async acceptWorkspaceTrust(projectRoot: string, remember: boolean): Promise<void> {
		const normalized = normalizeProjectRoot(projectRoot);
		if (!remember) {
			this.#sessionTrust.add(normalized);
			this.#loadedConfigs.clear();
			return;
		}
		await updateGlobalTrusts({ set: { [normalized]: true } }, { homeDir: this.#homeDir });
		this.#loadedConfigs.clear();
	}

	/** 拒绝工作区信任并持久化（下次启动不再询问；项目配置与技能保持不生效）。 */
	async denyWorkspaceTrust(projectRoot: string): Promise<void> {
		await updateGlobalTrusts({ set: { [normalizeProjectRoot(projectRoot)]: false } }, { homeDir: this.#homeDir });
		this.#loadedConfigs.clear();
	}

	/**
	 * 列出可用技能：用户级技能总是可见；项目级技能仅在已信任时可见。
	 * @param projectRoot 项目根目录；省略时只列用户级技能。
	 */
	async listSkills(projectRoot?: string): Promise<SkillSummary[]> {
		const trusted =
			projectRoot === undefined
				? false
				: resolveWorkspaceTrust((await this.#getConfig("")).config, projectRoot, this.#sessionTrust) === true;
		return collectSkills({
			homeDir: this.#homeDir,
			...(projectRoot === undefined ? {} : { projectRoot }),
			trusted,
		});
	}

	/** 用户级与项目级技能目录（技能页脚注展示实际扫描路径）。 */
	skillsDirectories(projectRoot?: string): {
		readonly user: string;
		readonly allUser: readonly string[];
		readonly project?: string;
	} {
		return {
			user: userSkillsDirectory(this.#homeDir),
			allUser: userSkillDirectories(this.#homeDir),
			...(projectRoot === undefined ? {} : { project: projectSkillsDirectory(projectRoot) }),
		};
	}

	async #getConfig(projectRoot: string): Promise<LoadedConfig> {
		// 严格门控：未信任且项目存在需要信任的资源时，project.toml 不参与合并
		if (projectRoot !== "" && (await this.#isTrustGated(projectRoot))) {
			return this.#loadRawConfig();
		}
		return this.#loadRawConfig(projectRoot || undefined);
	}

	/** 运行路径是否被信任门控（doctor 等诊断直读不走这里）。 */
	async #isTrustGated(projectRoot: string): Promise<boolean> {
		if (!requiresWorkspaceTrust(projectRoot)) return false;
		const global = await this.#getConfig("");
		return resolveWorkspaceTrust(global.config, projectRoot, this.#sessionTrust) !== true;
	}

	/**
	 * 解析一次运行所需的配置、激活供应商与请求模板。
	 *
	 * 会话内的模型、推理强度与审批覆盖在此合并；主循环与手动压缩共用这份结果，避免两处
	 * 各拼一遍配置而逐渐走样。
	 * @param session 目标会话；其项目根决定配置层与工作区信任。
	 * @param signal 供应商密钥解析使用的中止信号。
	 * @throws 没有激活供应商，或模型未声明正的上下文窗口时抛出。
	 */
	async #resolveRuntime(session: Session, signal?: AbortSignal) {
		const projectRoot = resolve(session.meta.projectRoot);
		const loaded = await this.#getConfig(projectRoot);
		const sessionId = session.meta.id;
		const model = this.#sessionModels.get(sessionId);
		const effort = this.#sessionEfforts.get(sessionId);
		const approval = this.#sessionApprovals.get(sessionId);
		const config: AppConfig = {
			...loaded.config,
			...(model ? { provider: model.provider, model: model.model } : {}),
			...(effort ? { reasoningEffort: effort } : {}),
			...(approval ? { approval } : {}),
		};
		const active = await resolveActiveProvider(config, loaded.providers, {
			runCommand: runSecretCommand,
			...(this.#options.env ? { env: this.#options.env } : {}),
			...(signal ? { signal } : {}),
		});
		if (!active) throw new Error("No active provider and model are configured");
		if (active.contextWindow <= 0) {
			throw new Error(`Model ${active.name}/${active.modelId} must define a positive contextWindow`);
		}
		const llm = this.#createLlmClient(config.retry);
		const request = this.#modelRequest(active, config);
		return {
			projectRoot,
			config,
			active,
			llm,
			request,
			compactor: await this.#createSummaryCompactor(config, loaded.providers, llm, session, request),
		};
	}

	/**
	 * 建立上下文压缩器：默认复用当前激活模型，`compaction.model` 可指定更便宜的模型。
	 * 摘要请求不带工具声明，也不进主会话上下文。
	 */
	async #createSummaryCompactor(
		config: AppConfig,
		providers: ProvidersFile,
		llm: LlmClient,
		session: Session,
		request: Omit<ModelRequest, "messages">,
	): Promise<ContextCompactor> {
		const target = await this.#summaryRequest(config, providers, request);
		return new ContextCompactor(
			config.compaction,
			{
				summarize: async (messages, signal) => {
					const response = await llm.complete(
						{
							...omitTools(target),
							messages: [
								{
									role: "system",
									content:
										"Summarize the conversation as durable project context. Include decisions with rationale, completed work, pending tasks, open risks, and relevant file paths. Preserve exact identifiers and paths. Do not invent facts. Keep the summary under 200 words.",
								},
								{ role: "user", content: JSON.stringify(messages) },
							],
						},
						signal ? { signal } : {},
					);
					return response.text;
				},
			},
			session.events,
			this.#options.monotonicNow,
		);
	}

	/**
	 * 摘要请求模板。
	 *
	 * `compact_model` 不填时复用会话模型；填写时支持 `modelId` 与 `provider/modelId`，
	 * 解析失败回退会话模型并告警。
	 */
	async #summaryRequest(
		config: AppConfig,
		providers: ProvidersFile,
		base: Omit<ModelRequest, "messages">,
	): Promise<Omit<ModelRequest, "messages">> {
		const model = config.compactModel;
		if (model === undefined) return base;
		const ref = parseModelRef(model, providers);
		const provider = ref.provider ?? config.provider;
		if (provider === undefined || ref.model.length === 0) return base;
		const active = await this.#resolveAuxProvider({ provider, model: ref.model }, config, providers, "Compaction");
		return active === undefined ? base : this.#modelRequest(active, config);
	}

	/** 创建带项目重试配置与注入依赖的 LLM 客户端。 */
	#createLlmClient(retry: { maxRetries: number; maxDelayMs: number }): LlmClient {
		return new LlmClient({
			retry,
			...(this.#options.fetch ? { fetch: this.#options.fetch } : {}),
			...(this.#options.env ? { env: this.#options.env } : {}),
			...(this.#options.monotonicNow ? { now: this.#options.monotonicNow } : {}),
			...(this.#options.random ? { random: this.#options.random } : {}),
			...(this.#options.sleep ? { sleep: this.#options.sleep } : {}),
		});
	}

	/**
	 * 构建基于当前激活模型的报告总结器；作为独立请求运行，不污染会话上下文。
	 * @throws 未配置激活供应商或密钥解析失败时抛出错误。
	 */
	async #createModelSummarizer(projectRoot: string): Promise<(input: ReportInput) => Promise<string>> {
		const loaded = await this.#getConfig(projectRoot);
		const active = await resolveActiveProvider(loaded.config, loaded.providers, {
			runCommand: runSecretCommand,
			...(this.#options.env ? { env: this.#options.env } : {}),
		});
		if (!active) throw new Error("No active provider and model are configured");
		const llm = this.#createLlmClient(loaded.config.retry);
		return async (input) => {
			const response = await llm.complete(
				{
					provider: active.name,
					model: active.modelId,
					api: active.api,
					baseUrl: active.baseUrl,
					apiKey: active.apiKey,
					...(Object.keys(active.headers).length > 0 ? { headers: active.headers } : {}),
					...(loaded.config.httpProxy ? { httpProxy: loaded.config.httpProxy } : {}),
					timeoutMs: active.timeoutMs,
					maxTokens: active.maxTokens,
					reasoningEffort: loaded.config.reasoningEffort,
					messages: [
						{ role: "system", content: REPORT_SYSTEM_PROMPT },
						{ role: "user", content: JSON.stringify(input) },
					],
				},
				{},
			);
			return response.text;
		};
	}
}

/** 取消息数组里最后一条助手消息的纯文本；没有助手消息或正文为空时返回空串。 */
function lastAssistantText(messages: readonly CanonicalMessage[]): string {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message?.role === "assistant") return typeof message.content === "string" ? message.content : "";
	}
	return "";
}

function providerHasConfiguredCredential(provider: ProviderConfig, env: NodeJS.ProcessEnv): boolean {
	const rawKey = provider.apiKey;
	if (rawKey) {
		const envMatch = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(rawKey);
		return envMatch ? Boolean(env[envMatch[1]!]) : true;
	}
	const fallbackName = provider.api === "anthropic-messages" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY";
	if (env[fallbackName] || isLocalEndpoint(provider.baseUrl)) return true;
	return Object.entries(provider.headers ?? {}).some(([name, value]) => {
		if (!/authorization|api.?key|token|secret|password/i.test(name)) return false;
		const envMatch = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(value);
		return envMatch ? Boolean(env[envMatch[1]!]) : value.length > 0;
	});
}

function isLocalEndpoint(baseUrl: string): boolean {
	const hostname = new URL(baseUrl).hostname.toLowerCase();
	return (
		hostname === "localhost" ||
		hostname.endsWith(".localhost") ||
		hostname === "127.0.0.1" ||
		hostname === "::1" ||
		hostname === "[::1]"
	);
}

function omitTools<T extends { tools?: unknown }>(value: T): Omit<T, "tools"> {
	const result: Record<string, unknown> = { ...value };
	delete result.tools;
	return result as Omit<T, "tools">;
}

function asRecordOrEmpty(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/**
 * 从事件 payload 派生精简审计摘要：保留路径、命令、审批结果与耗时等可 grep 字段，
 * 但不把工具输出全文、图片数据或上下文消息带进查询目标。
 */
/** 读取事件里的用量字段；缓存字段由协议可选，缺省按 0 计。 */
function usageOf(value: {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens?: number | undefined;
	cacheWriteTokens?: number | undefined;
}): { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number } {
	return {
		inputTokens: value.inputTokens,
		outputTokens: value.outputTokens,
		cacheReadTokens: value.cacheReadTokens ?? 0,
		cacheWriteTokens: value.cacheWriteTokens ?? 0,
	};
}

function auditSummary(event: EventRecord): Record<string, unknown> {
	switch (event.type) {
		case "session.created":
			return { title: event.payload.title, mode: event.payload.mode };
		case "mode.switched":
			return { from: event.payload.from, to: event.payload.to };
		case "message.feedback":
			return { targetSeq: event.payload.targetSeq, rating: event.payload.rating };
		case "model.changed":
			return {
				from: event.payload.fromModel,
				to: event.payload.toModel,
				appliesNextTurn: event.payload.appliesNextTurn,
			};
		case "session.renamed":
			return { title: event.payload.title };
		case "session.archived":
			return { archived: event.payload.archived };
		case "user.input":
			return {
				text: event.payload.text.slice(0, 200),
				...(event.payload.images ? { images: event.payload.images.length } : {}),
			};
		case "llm.request":
			return { endpoint: event.payload.endpoint, model: event.payload.model, messageCount: event.payload.messageCount };
		case "llm.response":
			return { stopReason: event.payload.stopReason, toolCalls: event.payload.toolCalls.length };
		case "tool.call":
			return {
				tool: event.payload.tool,
				args: event.payload.args,
				...(event.payload.toolCallId ? { toolCallId: event.payload.toolCallId } : {}),
			};
		case "tool.result":
			return {
				tool: event.payload.tool,
				isError: event.payload.isError,
				...(event.payload.elapsedMs !== undefined ? { elapsedMs: event.payload.elapsedMs } : {}),
				...(event.payload.toolCallId ? { toolCallId: event.payload.toolCallId } : {}),
			};
		case "approval.requested":
			return { id: event.payload.id, tool: event.payload.tool, args: event.payload.args, reason: event.payload.reason };
		case "approval.granted":
			return {
				...(event.payload.id ? { id: event.payload.id } : {}),
				tool: event.payload.tool,
				decisionMs: event.payload.decisionMs,
				...(event.payload.automatic ? { automatic: true } : {}),
				...(event.payload.sessionApproved ? { sessionApproved: true } : {}),
			};
		case "approval.denied":
			return { id: event.payload.id, tool: event.payload.tool, decisionMs: event.payload.decisionMs };
		case "approval.reviewed":
			return {
				tool: event.payload.tool,
				risk: event.payload.risk,
				decision: event.payload.decision,
				reason: event.payload.reason,
				...(event.payload.model ? { model: event.payload.model } : {}),
			};
		case "file.changed":
			return { path: event.payload.path, op: event.payload.op, snapshotId: event.payload.snapshotId };
		case "rollback.done":
			return { scope: event.payload.scope, files: event.payload.files };
		case "breakpoint.paused":
		case "breakpoint.resumed":
			return { reason: event.payload.reason };
		case "compaction.done":
			return { fromSeq: event.payload.fromSeq, toSeq: event.payload.toSeq, summaryChars: event.payload.summaryChars };
		case "subagent.started":
			return { toolCallId: event.payload.toolCallId, task: event.payload.task };
		case "subagent.finished":
			return {
				toolCallId: event.payload.toolCallId,
				steps: event.payload.steps,
				totalTokens: event.payload.totalTokens,
				durationMs: event.payload.durationMs,
				ok: event.payload.ok,
			};
		case "limit.blocked":
			return {
				...(event.payload.rule ? { rule: event.payload.rule } : {}),
				...(event.payload.kind ? { kind: event.payload.kind } : {}),
				...(event.payload.message ? { message: event.payload.message } : {}),
				...(event.payload.command ? { command: event.payload.command } : {}),
			};
		case "error":
			return { kind: event.payload.kind, message: event.payload.message, recoverable: event.payload.recoverable };
	}
}
