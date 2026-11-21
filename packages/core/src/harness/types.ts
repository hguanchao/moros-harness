import type { ZodType } from "zod";

import type { EventStore } from "../session/event-store.ts";
import type { SnapshotStore } from "../session/snapshot-store.ts";
import type { PolicyProfile } from "./policy.ts";
import type { RiskAssessment, RiskLevel } from "./risk.ts";

export type Mode = "standard" | "creator";
export type Resource = "read" | "write" | "shell";

export interface ToolContext {
	readonly toolCallId?: string;
	readonly sessionId: string;
	readonly projectRoot: string;
	readonly policy: PolicyProfile;
	readonly signal?: AbortSignal;
	readonly writeOutput?: (chunk: string) => Promise<void>;
}

export interface ToolDefinition {
	readonly name: string;
	readonly description: string;
	readonly schema: ZodType;
	readonly resource: Resource;
	/**
	 * 交给模型的参数 JSON Schema；外部工具（MCP）直接用它，内置工具缺省由 zod schema 推导。
	 * 声明在工具上而不是在循环里特判来源，避免核心循环知道 MCP 的存在。
	 */
	readonly parameters?: Record<string, unknown>;
	/**
	 * 固定风险等级；外部工具（MCP）无法从命令文本分级，统一按 high 处理。
	 * 缺省时由管线按 command/文件写入推断。
	 */
	readonly risk?: RiskAssessment;
	readonly paths?: (args: unknown) => readonly string[];
	readonly applyResolvedPaths?: (args: unknown, paths: readonly string[]) => unknown;
	readonly command?: (args: unknown) => string | undefined;
	execute(args: unknown, context: ToolContext): Promise<ToolResult>;
}

export interface ToolResult {
	readonly content: string;
	readonly isError?: boolean;
	readonly changedPaths?: readonly string[];
	readonly paused?: boolean;
}

export interface ApprovalRequest {
	readonly id: string;
	readonly tool: string;
	readonly args: unknown;
	readonly reason: string;
	/** 命令风险分级；审批卡据此提示风险，事件流据此区分「自动放行」与「人工确认」。 */
	readonly risk: RiskLevel;
}

/**
 * 审批交互的三种决定：单次放行、拒绝，以及「本会话同类动作放行」（审批卡 `a`）。
 */
export type ApprovalDecision = "allow" | "deny" | "allow-session";

/**
 * 送审的事实：只给动作本身，不给主模型的解释。
 *
 * 主模型对被拦下的动作总有话说（「这是用户要的」「已经确认过」），把它的说辞一起送进去，
 * 等于让被审查者替自己辩护。审查者只看命令、工具与命中规则。
 */
export interface ReviewRequest {
	readonly tool: string;
	readonly command: string;
	readonly risk: RiskAssessment;
	/** 无命令文本的外部工具（MCP）送审的参数；不传时审查者只看命令。 */
	readonly args?: unknown;
}

/** 审查结论；error 表示审查不可用（超时、模型报错、答复不可解析），调用方必须退回人工。 */
export interface ReviewVerdict {
	readonly decision: "allow" | "deny" | "error";
	readonly reason: string;
	/** 实际参与审查的模型，写进事件便于事后追责。 */
	readonly model?: string;
}

export interface PipelineOptions {
	readonly sessionId: string;
	readonly monotonicNow?: () => number;
	readonly projectRoot: string;
	readonly mode: Mode;
	readonly approval: "ask" | "auto" | "yolo";
	readonly events: EventStore;
	readonly snapshots: SnapshotStore;
	readonly tools: readonly ToolDefinition[];
	/** 审批回调；`sessionId` 标识发起审批的会话，供宿主按会话路由审批卡。 */
	readonly requestApproval?: (
		request: ApprovalRequest,
		sessionId: string,
		signal?: AbortSignal,
	) => Promise<ApprovalDecision>;
	/**
	 * 高危动作的模型审查；缺省时高危动作直接转人工。
	 * 返回 error 或抛错都按「审查不可用」处理，一律退回人工，绝不放行。
	 */
	readonly reviewCommand?: (request: ReviewRequest, signal?: AbortSignal) => Promise<ReviewVerdict>;
	/**
	 * 会话级的 `allow-session` 放行集合；由 Core 按会话持有并跨管线实例传递。
	 * 缺省时由管线自建（单次运行语义），测试与独立装配仍可用。
	 */
	readonly sessionApproved?: Set<string>;
	readonly now?: () => Date;
	readonly spillThreshold?: number;
	readonly spillDirectory?: string;
	/** 计划模式：叠加只读闸门（write/shell 直接拒绝），不改变会话模式。 */
	readonly plan?: boolean;
	/** 工具执行中的实时输出块；不落盘，仅供界面展示。 */
	readonly onToolOutput?: (toolCallId: string, chunk: string) => void;
}
