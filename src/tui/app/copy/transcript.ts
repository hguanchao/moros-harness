/**
 * 对话流文案：消息标记、工具行、子代理与任务卡。
 *
 * 只放会显示给人看的词与句，排版与颜色留在渲染层。
 */

import { formatDuration } from "#src/tui/app/contract/format.ts";

// ── 对话流 ────────────────────────────────────────────────────────────────

/** 对话流里的标签、空态与折叠提示。 */
export const TRANSCRIPT = {
	/** 工具没有输出。 */
	noOutput: "(no output)",
	/** 历史里没有对应用户消息的助手内容。 */
	earlierConversation: "(earlier conversation)",
	/** 子代理没说原因就失败了。 */
	unknownFailure: "failed without a reason",
	/** 子代理既没结果也没失败，直接被丢了。 */
	subagentNoResult: "the subagent stopped without reporting a result",
	/** 计划卡上的提示。 */
	planHint: " · double-click to view",
	/** 终端过窄时的提示：给出办法，不只报告现状。 */
	terminalTooSmall: "▸ Terminal too small · widen the window",
	/** 警告行的前缀。 */
	warningPrefix: "Warning: ",
} as const;

/** 子代理标签。 */
export function subagentLabel(index: number): string {
	return `Subagent ${index}`;
}

/** 任务条目标签。 */
export function taskLabel(index: number): string {
	return `Task ${index}`;
}

/** 折叠了多少行；能全屏查看时才提键位。 */
export function hiddenLines(hidden: number, viewerKey?: string): string {
	const suffix = viewerKey === undefined ? "" : ` · ${viewerKey}`;
	return `… (${hidden} more lines${suffix})`;
}

/** 列表还有多少条没显示。 */
export function moreItems(hidden: number): string {
	return `… ${hidden} more`;
}

/** 页脚里排队消息的折叠计数。 */
export function queueMore(hidden: number): string {
	return `+${hidden} more`;
}

/** 工具组头：按固定顺序汇总，名词单复数与动词对齐。 */
export function toolGroupSummary(counts: {
	readonly read: number;
	readonly list: number;
	readonly search: number;
	readonly command: number;
}): string {
	const parts: string[] = [];
	if (counts.read > 0) parts.push(`Read ${counts.read} ${counts.read === 1 ? "file" : "files"}`);
	if (counts.list > 0) parts.push(`Listed ${counts.list} ${counts.list === 1 ? "folder" : "folders"}`);
	if (counts.search > 0) {
		parts.push(`Searched ${counts.search} ${counts.search === 1 ? "pattern" : "patterns"}`);
	}
	if (counts.command > 0) {
		parts.push(`Ran ${counts.command} ${counts.command === 1 ? "command" : "commands"}`);
	}
	return parts.join(", ");
}

/** 状态计数段：`1 running · 2 done`。 */
export function countSegments(counts: {
	readonly running?: number;
	readonly done?: number;
	readonly failed?: number;
	readonly pending?: number;
}): string {
	const parts: string[] = [];
	if ((counts.running ?? 0) > 0) parts.push(`${counts.running} running`);
	if ((counts.done ?? 0) > 0) parts.push(`${counts.done} done`);
	if ((counts.failed ?? 0) > 0) parts.push(`${counts.failed} failed`);
	if ((counts.pending ?? 0) > 0) parts.push(`${counts.pending} pending`);
	return parts.join(" · ");
}

/** 后台作业的折叠指标。 */
export function backgroundJob(id: string): string {
	return `background job ${id}`;
}

/**
 * 子代理的统计段：步数与耗时能拿到几个写几个。
 *
 * 历史回填拿不到步数但有时长，不能因为缺一项就整段丢掉。
 */
export function subagentMetric(steps: number | undefined, durationMs: number | undefined): string {
	const parts: string[] = [];
	if (steps !== undefined) parts.push(`${steps} ${steps === 1 ? "step" : "steps"}`);
	if (durationMs !== undefined) parts.push(formatDuration(durationMs));
	return parts.length === 0 ? "" : ` (${parts.join(" · ")})`;
}
