/**
 * 状态行与操作反馈文案。
 *
 * 界面文案按用途拆分，`copy.ts` 是唯一的对外入口；这里只负责状态行、通知与结果说明。
 */

import type { AbortCause } from "#src/tui/app/contract/events.ts";
import { formatDuration } from "#src/tui/app/contract/format.ts";

// ── 状态行 ────────────────────────────────────────────────────────────────

/**
 * 状态行文案。
 *
 * 进行中的状态统一以省略号收尾（单个 `…`，不用三个点），结局统一是「名词 + failed」；
 * 结果类短句不以句号收尾。说不清原因的禁用说明必须带上「为什么」或「怎么办」，
 * 不能只写 unavailable。
 */
export const STATUS = {
	waitingForModel: "Waiting for model…",
	waitingForSubagent: "Waiting for subagent…",
	thinking: "Thinking…",
	writingResponse: "Writing response…",
	writingToolCall: "Writing tool call…",
	runningTool: "Running tool…",
	compacting: "Compacting context…",
	stopping: "Stopping…",
	error: "Error",
	/** 配置不可用：状态行只给短提示，具体原因在同一次操作的对话流错误行里 */
	configurationInvalid: "Configuration unavailable",
	/** 存储不可用：说清后果，否则使用者以为会话还在后台保存。 */
	sessionStorageUnavailable: "Session storage unavailable · this session won't be saved",
	agentNotConnected: "Agent runtime isn't available",
	pluginCommandsInPlan: "Plugin commands don't run in Plan mode",
	skillsSkipped: "Workspace skills skipped · this workspace isn't trusted",
	restoringCheckpoint: "Restoring checkpoint…",
	readingCheckpoints: "Reading checkpoints…",
	exporting: "Exporting…",
	reviewing: "Reviewing changes…",
	cancellingReview: "Cancelling review…",
	checkingMcp: "Checking MCP servers…",
	mcpHealthCheckComplete: "MCP health check complete",
	mcpHealthCheckFailed: "MCP health check failed",
	mcpReconnectFailed: "MCP reconnect failed",
	readingImage: "Reading image…",
	readingClipboard: "Reading clipboard…",
	readingClipboardImage: "Reading clipboard image…",
	downloadingImage: "Downloading image…",
	recordingDecision: "Recording the decision…",
	exportFailed: "Export failed",
	reviewFailed: "Review failed",
	copyFailed: "Copy failed",
	/** 写入前的即时反馈：不能提前宣称「已复制」，结果回来后再订正 */
	copying: "Copying…",
	copySentToTerminal: "Copy sent to terminal",
	copied: "Copied!",
	nothingToView: "Nothing to view yet",
	planReady: "Plan ready · double-click the plan card to review",
	reviewAlreadyRunning: "A review is already running",
	/** 审查进行中又提交：告诉人怎么取消，而不是只说不能发。 */
	reviewRunningCancel: "A review is running · press Ctrl+C to cancel it",
	imagesUnsupported: "Image input isn't available · no image source configured",
	/** 能力整体不可用：命令清单与状态行共用同一句，避免同一件事两种说法。 */
	planUnavailable: "Plan mode isn't available in this session",
	exportUnavailable: "Session export isn't available in this session",
	reviewUnavailable: "Code review isn't available in this session",
	checkpointsUnavailable: "Checkpoints aren't available in this workspace",
	/** 计划已就绪但这一轮还没跑完，先把顺序说清楚。 */
	approveWhileTurn: "Wait for the running turn to finish, then approve the plan",
	/** 第一次 Esc 只是武装：整段草稿不该被一下按掉。 */
	clearArmed: "Esc again to clear",
	/** 清空之后给出撤销路径，否则使用者只会以为字丢了。 */
	cleared: "Input cleared · Ctrl+Z to undo",
	restored: "Input restored",
} as const;

/** 中断说明：先分类再出句子，拿不准就中性，绝不默认成「是你停的」。 */
export function cancelPhrase(cause: AbortCause | undefined): string {
	if (cause === "user") return "Turn stopped by you";
	if (cause === "session") return "Turn stopped because the session closed";
	return "Turn stopped";
}

/** 重试中的状态：动作在前，原因用 `·` 接在后面，不再拖一个省略号。 */
export function retryStatus(attempt: number, maxAttempts: number, reason: string): string {
	const head = `Retrying ${attempt}/${maxAttempts}`;
	return reason.length === 0 ? `${head}…` : `${head} · ${reason}`;
}

/** 某条命令要等这一轮跑完才能用。 */
export function waitForTurn(command: string): string {
	return `${command}: wait for the running turn to finish`;
}

/** 审查正在跑：挡住的操作要说清什么时候能再用。 */
export function reviewBlocks(action: string): string {
	return `${action}: a review is running, try again when it ends`;
}

/** 队列超出可显示行数。 */
export function queuedOverflow(queued: number, shown: number): string {
	return `${queued} messages queued · showing the first ${shown}`;
}

/** MCP 服务器重连进行中。 */
export function reconnecting(name: string): string {
	return `Reconnecting ${name}…`;
}

/** 插件命令正在执行。 */
export function commandRunning(name: string): string {
	return `Running /${name}…`;
}

/** 工具执行中的状态行；与 STATUS.runningTool 同一句式，只是带具体工具名。 */
export function toolRunning(name: string): string {
	return `Running ${name}…`;
}

/** 桌面通知：命令结束。 */
export function commandFinished(name: string): string {
	return `/${name} finished`;
}

/** 桌面通知：命令失败。 */
export function commandFailed(name: string): string {
	return `/${name} failed`;
}

/** 要求修改计划时预填的输入前缀。 */
export const REVISE_PLAN_PREFIX = "Revise the plan: ";

/** 两段确认：键位在前、动作在后，键位只在这一处维护。 */
/** 启动期 MCP 握手的状态行:带就绪进度,数字随刷新跳动。 */
export function mcpConnectingStatus(ready: number, total: number): string {
	return `Connecting to MCP servers (${ready}/${total} ready)…`;
}

export function pendingConfirm(action: string, key = "Ctrl+C"): string {
	return `${key}: press again to ${action}`;
}

/** 模型已切换。一句话说清目标与生效时机，不再另起一行补中性说明。 */
export function modelSwitched(target: string): string {
	return `Model switched to ${target} · applies from the next turn`;
}

/** 思考等级已设置。 */
export function effortSet(level: string, fromNextTurn: boolean): string {
	return `Effort set to ${level}${fromNextTurn ? " · applies from the next turn" : ""}`;
}

/** 会话已切换。 */
export function switchedSession(id: string): string {
	return `Switched to session ${id}`;
}

/** 分叉结果：来源、条目数、工作区与检查点的界限。 */
export function forkedSession(origin: string, copied: number): string {
	return `Forked from ${origin} · ${copied} ${copied === 1 ? "entry" : "entries"} copied`;
}

/** 分叉不影响工作区，检查点从分叉处重新开始。 */
export const FORK_WORKSPACE_NOTE = "Workspace unchanged · checkpoints start fresh within the fork";

/** 审查结束的一行摘要。 */
export function reviewResult(label: string, steps: number, durationMs: number, stopReason: string): string {
	const stepText = `${steps} ${steps === 1 ? "step" : "steps"}`;
	const suffix = stopReason === "done" ? "" : ` · ${stopReason}`;
	return `${label} · ${stepText} · ${formatDuration(durationMs)}${suffix}`;
}

/** 撤销结果。 */
export function undoResult(kind: "turn" | "safety", label: string, restored: number, removed: number): string {
	const verb = kind === "safety" ? "Restored" : "Undid";
	const removedText = removed > 0 ? ` · ${removed} removed` : "";
	return `${verb} ${label} · ${restored} restored${removedText}`;
}
