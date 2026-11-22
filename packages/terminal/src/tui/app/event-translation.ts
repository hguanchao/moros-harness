import type { EventRecord } from "@moros/core";
import { firstLine } from "./contract/format.ts";
import type { AgentEvent } from "./contract/events.ts";
import type { LlmStopReason } from "./contract/messages.ts";

/** 一轮运行期间的事件翻译状态；仅保存 UI 增量与阶段信息，不持久化。 */
interface CoreEventStreamState {
	/** 本轮模型请求是否已经收到过文本增量。 */
	streamedText: boolean;
	/** 本轮最后一次 llm.response 的 stopReason（Core 原值），供 turn_end 使用。 */
	stopReason: string | undefined;
}

/** 为一次 runTurn 创建独立的翻译状态。 */
export function createEventStreamState(): CoreEventStreamState {
	return { streamedText: false, stopReason: undefined };
}

/**
 * 把 Core 的 stopReason 映射到界面枚举。
 * Core 目前只会给出 end_turn / tool_use / max_tokens / error；未知值按「正常结束」处理，
 * 不把模型的新枚举猜成错误。
 */
export function toLlmStopReason(reason: string | undefined): LlmStopReason {
	switch (reason) {
		case "tool_use":
			return "toolUse";
		case "max_tokens":
			return "length";
		case "error":
			return "error";
		case "aborted":
			return "aborted";
		default:
			return "stop";
	}
}

/**
 * 把一条 Core 落盘事件翻译成界面消费的 AgentEvent 序列。
 * 文本增量由 onText 直接推送，这里只在无增量时用落盘文本兜底；工具行以 tool.call 为准。
 * @param event 事件流中的一条记录。
 * @param state 本轮翻译状态，会被就地更新（重置文本标记、记录工具 ID）。
 * @returns 需要交给界面监听器的事件序列；无关事件返回空数组。
 */
export function mapCoreEvent(event: EventRecord, state: CoreEventStreamState): readonly AgentEvent[] {
	const notice = (message: string, fields?: Record<string, unknown>): AgentEvent => ({
		type: "notice",
		message,
		...(fields === undefined ? {} : { fields }),
	});
	switch (event.type) {
		case "llm.request":
			state.streamedText = false;
			state.stopReason = undefined;
			return [];
		case "llm.response": {
			state.stopReason = event.payload.stopReason;
			const events: AgentEvent[] = [];
			if (!state.streamedText && event.payload.text.length > 0) {
				state.streamedText = true;
				events.push({ type: "text_delta", text: event.payload.text });
			}
			const usage = usageOf(event.payload.usage);
			if (usage) {
				events.push({
					type: "usage_recorded",
					kind: "turn",
					tokens: usage.inputTokens + usage.outputTokens,
					input: usage.inputTokens,
					output: usage.outputTokens,
					cacheRead: usage.cacheReadTokens,
					cacheWrite: usage.cacheWriteTokens,
					contextTokens: usage.inputTokens,
				});
			}
			return events;
		}
		case "tool.call": {
			const callId = event.payload.toolCallId;
			return [
				{ type: "writing_tool_call", name: event.payload.tool },
				{ type: "tool_start", callId, name: event.payload.tool, args: asRecord(event.payload.args) ?? {} },
			];
		}
		case "tool.result": {
			const callId = event.payload.toolCallId;
			const durationMs = event.payload.elapsedMs ?? 0;
			return [
				{
					type: "tool_end",
					callId,
					name: event.payload.tool,
					isError: event.payload.isError,
					durationMs,
					summary: firstLine(event.payload.result, 160),
					content: event.payload.result,
					// 把 Core 已有的结构化字段原样带给界面；不从结果文本里反推业务语义，
					// 那是内核的职责。折叠行、后台作业与耗时统计因此能拿到 details。
					// task 结果额外带子代理统计：组卡片据此显示步数与 token 合计。
					details: {
						tool: event.payload.tool,
						durationMs,
						isError: event.payload.isError,
						resultChars: event.payload.result.length,
						...(event.payload.spillPath === undefined ? {} : { spillPath: event.payload.spillPath }),
						...(event.payload.truncated === undefined ? {} : { truncated: event.payload.truncated }),
						...subagentStatsOf(event.payload.result),
					},
				},
			];
		}
		case "approval.requested":
			return [
				notice(`Approval requested: ${event.payload.tool}`, {
					id: event.payload.id,
					tool: event.payload.tool,
					args: event.payload.args,
					reason: event.payload.reason,
				}),
			];
		case "approval.granted":
			return [
				notice(
					event.payload.sessionApproved
						? "Approval granted for this session"
						: event.payload.reviewed === true
							? "Approval granted by model review"
							: "Approval granted",
					{
						tool: event.payload.tool,
						decisionMs: event.payload.decisionMs,
						...(event.payload.id === undefined ? {} : { id: event.payload.id }),
						...(event.payload.automatic === undefined ? {} : { automatic: event.payload.automatic }),
						...(event.payload.sessionApproved === undefined ? {} : { sessionApproved: event.payload.sessionApproved }),
					},
				),
			];
		case "approval.denied":
			return [
				notice(`Approval denied: ${event.payload.tool}`, {
					id: event.payload.id,
					tool: event.payload.tool,
					decisionMs: event.payload.decisionMs,
				}),
			];
		case "approval.reviewed":
			return [
				notice(`Review ${event.payload.decision}: ${event.payload.tool}`, {
					tool: event.payload.tool,
					risk: event.payload.risk,
					decision: event.payload.decision,
					reason: event.payload.reason,
				}),
			];
		case "error":
			return [
				{
					type: "error",
					message: event.payload.message,
					kind: event.payload.kind,
					recoverable: event.payload.recoverable,
				},
			];
		case "limit.blocked":
			return [
				notice(event.payload.message ?? event.payload.kind ?? "Request blocked by policy", {
					...(event.payload.rule === undefined ? {} : { rule: event.payload.rule }),
					...(event.payload.kind === undefined ? {} : { kind: event.payload.kind }),
					...(event.payload.command === undefined ? {} : { command: event.payload.command }),
				}),
			];
		case "file.changed": {
			// op 是核心事件里的动词原形（create/modify/delete），展示时转为过去分词
			const verb = event.payload.op === "create" ? "created" : event.payload.op === "delete" ? "deleted" : "modified";
			return [notice(`File ${verb}: ${event.payload.path} (use /diff ${event.seq})`)];
		}
		case "rollback.done":
			return [notice(`Rollback ${event.payload.scope} complete: ${event.payload.files.join(", ") || "no files"}`)];
		case "breakpoint.paused":
			return [notice(`Paused: ${event.payload.reason}`)];
		case "breakpoint.resumed":
			return [notice(`Resumed: ${event.payload.reason}`)];
		case "compaction.done":
			return [
				notice(
					`Context compacted · events ${event.payload.fromSeq}–${event.payload.toSeq} (${event.payload.summaryChars} chars)`,
					{
						fromSeq: event.payload.fromSeq,
						toSeq: event.payload.toSeq,
						summaryChars: event.payload.summaryChars,
						summary: event.payload.summary,
						...(event.payload.compactedTokens === undefined ? {} : { compactedTokens: event.payload.compactedTokens }),
					},
				),
			];
		case "mode.switched":
			return [notice(`Mode: ${event.payload.from} → ${event.payload.to}`)];
		case "message.feedback":
			// 反馈是桌面端交互语义，TUI 无对应操作栏，忽略即可（事件仍持久化在会话流）。
			return [];
		case "model.changed":
			return [
				notice(
					`Model: ${event.payload.from} → ${event.payload.to}${event.payload.appliesNextTurn ? " (next turn)" : ""}`,
				),
			];
		case "session.renamed":
			return [notice(`Session renamed: ${event.payload.title}`)];
		case "session.archived":
			return [notice(event.payload.archived ? "Session archived" : "Session unarchived")];
		case "subagent.started":
			return [];
		case "subagent.finished":
			return [];
		case "session.created":
		case "user.input":
			return [];
	}
}

/** 读取 Core 落盘的 ModelUsage；旧事件缺少缓存字段时按 0 处理。 */
function usageOf(
	value: unknown,
): { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number } | undefined {
	const record = asRecord(value);
	if (!record) return undefined;
	const number = (key: string): number => {
		const candidate = record[key];
		return typeof candidate === "number" && Number.isFinite(candidate) ? candidate : 0;
	};
	return {
		inputTokens: number("inputTokens"),
		outputTokens: number("outputTokens"),
		cacheReadTokens: number("cacheReadTokens"),
		cacheWriteTokens: number("cacheWriteTokens"),
	};
}

/** unknown 收窄为普通对象；数组与 null 不算。事件 payload 与工具参数解析共用。 */
export function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

/**
 * 从 task 结果文本里解析子代理统计尾注。
 *
 * Core 把统计放在结果首行（`[subagent] steps: N · tokens: M · Xs`）；这是唯一稳定
 * 的结构化通道，解析不出来时省略字段，组卡片退回只显示耗时。
 */
function subagentStatsOf(result: string): { steps?: number; totalTokens?: number } {
	const match = /\[subagent\] steps: (\d+) · tokens: (\d+)/.exec(result);
	if (!match) return {};
	return { steps: Number(match[1]), totalTokens: Number(match[2]) };
}
