import type { EventRecord } from "@moros/core/events/schema.ts";
import type { TraceStep, TraceStepKind, TraceTurn } from "../shared/contract.ts";

/** 详情面板单字段上限；完整事件仍在会话流里，轨迹只做定位与摘要。 */
const MAX_DETAIL_CHARS = 4_000;

interface MutableStep {
	id: string;
	kind: TraceStepKind;
	title: string;
	status: TraceStep["status"];
	startedAt?: string;
	durationMs?: number;
	tool?: string;
	args?: string;
	result?: string;
	risk?: string;
}

interface MutableTurn {
	id: string;
	index: number;
	prompt: string;
	startedAt?: string;
	steps: MutableStep[];
}

/**
 * 把 append-only 事件流压成「回合 -> 步骤」的轨迹投影。
 *
 * 只依赖事件协议，不读 Core 内部状态；同一份投影同时服务实时刷新与重启后的历史回放。
 * 工具与审批按 id 关联，`corr` 用于把多次 llm.request/response 归位到同一轮。
 * @param events 按 seq 升序的会话事件。
 * @returns 回合列表；没有 user.input 的会话返回空数组。
 */
export function buildTrace(events: readonly EventRecord[]): readonly TraceTurn[] {
	const turns: MutableTurn[] = [];
	const toolSteps = new Map<string, MutableStep>();
	const llmSteps = new Map<string, MutableStep>();
	let current: MutableTurn | undefined;
	let lastLlm: MutableStep | undefined;
	let sequence = 0;

	const ensureTurn = (): MutableTurn => {
		if (current) return current;
		current = {
			id: `turn-${turns.length + 1}`,
			index: turns.length + 1,
			prompt: "Session",
			steps: [],
		};
		turns.push(current);
		return current;
	};

	const addStep = (step: MutableStep): MutableStep => {
		ensureTurn().steps.push(step);
		return step;
	};

	const nextId = (prefix: string): string => {
		sequence += 1;
		return `${prefix}-${sequence}`;
	};

	for (const event of events) {
		switch (event.type) {
			case "user.input": {
				current = {
					id: `turn-${turns.length + 1}`,
					index: turns.length + 1,
					prompt: event.payload.text.trim().length > 0 ? event.payload.text : "[image]",
					startedAt: event.ts,
					steps: [],
				};
				turns.push(current);
				lastLlm = undefined;
				toolSteps.clear();
				break;
			}
			case "llm.request": {
				const id = `llm-${event.corr ?? nextId("request")}`;
				const step: MutableStep = {
					id,
					kind: "llm",
					title: `Model ${event.payload.model}`,
					status: "running",
					startedAt: event.ts,
					args: `${event.payload.endpoint} · ${event.payload.messageCount} messages`,
				};
				addStep(step);
				llmSteps.set(event.corr ?? id, step);
				lastLlm = step;
				break;
			}
			case "llm.response": {
				const step = (event.corr ? llmSteps.get(event.corr) : undefined) ?? lastLlm;
				const target =
					step ??
					addStep({
						id: nextId("llm"),
						kind: "llm",
						title: "Model response",
						status: "running",
					});
				target.status = event.payload.stopReason === "error" ? "error" : "ok";
				const llmDuration = elapsedMs(target.startedAt, event.ts);
				if (llmDuration !== undefined) target.durationMs = llmDuration;
				const usage = `${event.payload.usage.inputTokens} in / ${event.payload.usage.outputTokens} out`;
				const text = truncate(event.payload.text);
				target.result = [`stop=${event.payload.stopReason}`, usage, text].filter((part) => part.length > 0).join("\n");
				break;
			}
			case "tool.call": {
				const step: MutableStep = {
					id: `tool-${event.payload.toolCallId}`,
					kind: "tool",
					title: event.payload.tool,
					tool: event.payload.tool,
					status: "running",
					startedAt: event.ts,
					args: truncate(formatJson(event.payload.args)),
				};
				addStep(step);
				toolSteps.set(event.payload.toolCallId, step);
				break;
			}
			case "tool.result": {
				const step = toolSteps.get(event.payload.toolCallId);
				const target =
					step ??
					addStep({
						id: `tool-${event.payload.toolCallId}`,
						kind: "tool",
						title: event.payload.tool,
						status: "running",
					});
				target.status = event.payload.isError ? "error" : "ok";
				if (event.payload.elapsedMs !== undefined) target.durationMs = event.payload.elapsedMs;
				const notes = [
					event.payload.spillPath === undefined ? "" : `spill: ${event.payload.spillPath}`,
					event.payload.truncated === true ? "result truncated" : "",
				].filter((part) => part.length > 0);
				target.result = [truncate(event.payload.result), ...notes].join("\n");
				break;
			}
			case "approval.requested": {
				addStep({
					id: `approval-${event.payload.id}`,
					kind: "approval",
					title: `Approval · ${event.payload.tool}`,
					status: "pending",
					startedAt: event.ts,
					tool: event.payload.tool,
					...(event.payload.risk === undefined ? {} : { risk: event.payload.risk }),
					args: truncate(event.payload.reason),
				});
				break;
			}
			case "approval.granted": {
				const approvalId = event.payload.id;
				const target = approvalId === undefined ? undefined : findStep(ensureTurn(), "approval", approvalId);
				const step =
					target ??
					addStep({
						id: `approval-${approvalId ?? nextId("approval")}`,
						kind: "approval",
						title: `Approval · ${event.payload.tool}`,
						status: "ok",
					});
				step.status = "ok";
				step.durationMs = event.payload.decisionMs;
				step.result = event.payload.reviewed === true ? "Granted by model review" : "Granted";
				if (event.payload.sessionApproved === true) step.result = "Granted for this session";
				break;
			}
			case "approval.denied": {
				const target = findStep(ensureTurn(), "approval", event.payload.id);
				const step =
					target ??
					addStep({
						id: `approval-${event.payload.id}`,
						kind: "approval",
						title: `Approval · ${event.payload.tool}`,
						status: "blocked",
					});
				step.status = "blocked";
				step.durationMs = event.payload.decisionMs;
				step.result = "Denied";
				break;
			}
			case "approval.reviewed": {
				addStep({
					id: `review-${event.seq}`,
					kind: "approval",
					title: `Model review · ${event.payload.tool}`,
					status: event.payload.decision === "allow" ? "ok" : "blocked",
					startedAt: event.ts,
					risk: event.payload.risk,
					result: `${event.payload.decision}: ${event.payload.reason}`,
				});
				break;
			}
			case "subagent.started": {
				const target = toolSteps.get(event.payload.toolCallId);
				if (target) {
					target.kind = "subagent";
					target.title = "Subagent task";
					target.args = truncate(event.payload.task);
					break;
				}
				const subagentStep = addStep({
					id: `subagent-${event.payload.toolCallId}`,
					kind: "subagent",
					title: "Subagent task",
					status: "running",
					startedAt: event.ts,
					args: truncate(event.payload.task),
				});
				toolSteps.set(event.payload.toolCallId, subagentStep);
				break;
			}
			case "subagent.finished": {
				const target = toolSteps.get(event.payload.toolCallId);
				const step =
					target ??
					addStep({
						id: `subagent-${event.payload.toolCallId}`,
						kind: "subagent",
						title: "Subagent task",
						status: "running",
					});
				step.status = event.payload.ok ? (event.payload.paused ? "blocked" : "ok") : "error";
				step.durationMs = event.payload.durationMs;
				step.result = [
					`${event.payload.steps} steps · ${event.payload.totalTokens} tokens`,
					truncate(event.payload.preview),
				].join("\n");
				break;
			}
			case "file.changed": {
				const path = event.payload.path.replaceAll("\\", "/");
				addStep({
					id: `file-${event.seq}`,
					kind: "file",
					title: `${event.payload.op} · ${path}`,
					status: "ok",
					startedAt: event.ts,
					result: path,
				});
				break;
			}
			case "rollback.done": {
				addStep({
					id: `rollback-${event.seq}`,
					kind: "file",
					title: `Rollback ${event.payload.scope}`,
					status: "ok",
					startedAt: event.ts,
					result: event.payload.files.map((file) => file.replaceAll("\\", "/")).join(", "),
				});
				break;
			}
			case "compaction.done": {
				addStep({
					id: `compact-${event.seq}`,
					kind: "compaction",
					title: "Context compacted",
					status: "ok",
					startedAt: event.ts,
					result: `${event.payload.summaryChars} chars · events ${event.payload.fromSeq}–${event.payload.toSeq}`,
				});
				break;
			}
			case "breakpoint.paused":
			case "breakpoint.resumed": {
				addStep({
					id: `breakpoint-${event.seq}`,
					kind: "system",
					title: event.type === "breakpoint.paused" ? "Paused" : "Resumed",
					status: "ok",
					startedAt: event.ts,
					result: event.payload.reason,
				});
				break;
			}
			case "limit.blocked": {
				addStep({
					id: `limit-${event.seq}`,
					kind: "error",
					title: "Blocked by policy",
					status: "blocked",
					startedAt: event.ts,
					result: event.payload.message ?? event.payload.command ?? event.payload.kind ?? "",
				});
				break;
			}
			case "error": {
				addStep({
					id: `error-${event.seq}`,
					kind: "error",
					title: `Error · ${event.payload.kind}`,
					status: "error",
					startedAt: event.ts,
					result: event.payload.message,
				});
				break;
			}
			case "session.created":
			case "session.renamed":
			case "session.archived":
			case "mode.switched":
				break;
		}
	}

	return turns
		.filter((turn) => turn.steps.length > 0 || turn.prompt !== "Session")
		.map((turn) => ({
			id: turn.id,
			index: turn.index,
			prompt: turn.prompt,
			...(turn.startedAt === undefined ? {} : { startedAt: turn.startedAt }),
			steps: turn.steps.map((step) => ({
				id: step.id,
				kind: step.kind,
				title: step.title,
				status: step.status,
				...(step.tool === undefined ? {} : { tool: step.tool }),
				...(step.startedAt === undefined ? {} : { ts: step.startedAt }),
				...(step.durationMs === undefined ? {} : { durationMs: step.durationMs }),
				...(step.args === undefined ? {} : { args: step.args }),
				...(step.result === undefined ? {} : { result: step.result }),
				...(step.risk === undefined ? {} : { risk: step.risk }),
			})),
		}));
}

function findStep(turn: MutableTurn, kind: TraceStepKind, id: string): MutableStep | undefined {
	return turn.steps.find((step) => step.kind === kind && step.id === `approval-${id}`);
}

function elapsedMs(start: string | undefined, end: string): number | undefined {
	if (start === undefined) return undefined;
	const startMs = Date.parse(start);
	const endMs = Date.parse(end);
	if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return undefined;
	return endMs - startMs;
}

function truncate(text: string): string {
	if (text.length <= MAX_DETAIL_CHARS) return text;
	return `${text.slice(0, MAX_DETAIL_CHARS)}…`;
}

function formatJson(value: unknown): string {
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value, null, 2) ?? String(value);
	} catch {
		return String(value);
	}
}
