import { useState, type JSX } from "react";

import { formatSubagentCounts, subagentGroupCounts, type SubagentGroup } from "../utils/task-view.ts";
import { BranchIcon, CheckIcon, ChevronDownIcon, ChevronRightIcon, CircleXIcon } from "./Icons.tsx";

/** 子代理分组：组头计数 + 可展开成员清单 + 失败原因展开。 */
export function SubagentGroupView({ group }: { readonly group: SubagentGroup }): JSX.Element {
	const [open, setOpen] = useState(false);
	const counts = subagentGroupCounts(group);
	const hasRunning = counts.running > 0;
	const tokenTotal = group.members.reduce((sum, member) => sum + (member.totalTokens ?? 0), 0);
	const duration = group.members
		.map((member) => member.durationMs)
		.filter((value): value is number => value !== undefined);
	const maxDuration = duration.length === 0 ? undefined : Math.max(...duration);

	return (
		<div className={`subagent-group ${hasRunning ? "is-running" : ""}`}>
			<button type="button" className="subagent-group-head" onClick={() => setOpen(!open)}>
				<BranchIcon size={13} />
				<span className="subagent-group-label">子任务</span>
				<span className="subagent-group-counts">{formatSubagentCounts(counts)}</span>
				{maxDuration === undefined ? null : <span className="subagent-group-duration">{formatMs(maxDuration)}</span>}
				{tokenTotal > 0 ? <span className="subagent-group-tokens">⇣ {tokenTotal}</span> : null}
				{open ? <ChevronDownIcon size={13} /> : <ChevronRightIcon size={13} />}
			</button>
			{open ? (
				<div className="subagent-members">
					{group.members.map((member) => (
						<SubagentMemberRow key={member.callId} member={member} />
					))}
				</div>
			) : null}
		</div>
	);
}

function SubagentMemberRow({ member }: { readonly member: SubagentGroup["members"][number] }): JSX.Element {
	const [showFailure, setShowFailure] = useState(false);
	const statusLabel = member.status === "running" ? "运行中" : member.status === "done" ? "已完成" : "失败";
	const statusIcon =
		member.status === "done" ? (
			<CheckIcon size={12} />
		) : member.status === "failed" ? (
			<CircleXIcon size={12} />
		) : (
			<span className="spinner small" />
		);
	const metric = [
		member.steps === undefined ? undefined : `${member.steps} 步`,
		member.totalTokens === undefined ? undefined : `${member.totalTokens} tokens`,
		member.durationMs === undefined ? undefined : formatMs(member.durationMs),
	]
		.filter((part): part is string => part !== undefined)
		.join(" · ");

	return (
		<div className={`subagent-member status-${member.status}`}>
			<div className="subagent-member-main">
				<span className="subagent-member-status">{statusIcon}</span>
				<span className="subagent-member-status-label">{statusLabel}</span>
				<span className="subagent-member-task" data-tooltip={member.task}>
					{member.task}
				</span>
				{metric.length === 0 ? null : <span className="subagent-member-metric">{metric}</span>}
				{member.failure === undefined ? null : (
					<button
						type="button"
						className="icon-button subagent-failure-toggle"
						data-tooltip="查看失败原因"
						aria-label="查看失败原因"
						onClick={() => setShowFailure(!showFailure)}
					>
						<CircleXIcon size={12} />
					</button>
				)}
			</div>
			{member.failure === undefined || !showFailure ? null : <div className="subagent-failure">{member.failure}</div>}
		</div>
	);
}

function formatMs(ms: number): string {
	if (ms < 1_000) return `${Math.round(ms)} ms`;
	const seconds = Math.round(ms / 1_000);
	if (seconds < 60) return `${seconds} 秒`;
	return `${Math.floor(seconds / 60)}分${seconds % 60}秒`;
}
