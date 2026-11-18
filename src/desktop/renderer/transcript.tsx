import { useEffect, useState, type JSX } from "react";

import type { EventRecord } from "#src/core/events/schema.ts";
import type { LiveState } from "#src/desktop/shared/contract.ts";
import { displayPath, firstLine, formatDuration } from "#src/desktop/renderer/format.ts";
import {
	AlertIcon,
	CheckIcon,
	ChevronDownIcon,
	ChevronRightIcon,
	ClockIcon,
	FileIcon,
	FolderOpenIcon,
	MetaIcon,
	SparklesIcon,
	TerminalIcon,
} from "#src/desktop/renderer/icons.tsx";
import { Markdown } from "#src/desktop/renderer/markdown.tsx";
import type { SubagentProgressView } from "#src/desktop/renderer/state.tsx";

export interface ToolBlock {
	kind: "tool";
	callId: string;
	name: string;
	args: unknown;
	result?: string;
	isError?: boolean;
	durationMs?: number;
	output?: string;
	subagent?: {
		task: string;
		status: "running" | "done" | "failed";
		steps?: number;
		totalTokens?: number;
	};
}

export interface AssistantBlock {
	readonly kind: "assistant";
	readonly text: string;
}

export interface LiveBlock {
	readonly kind: "live";
	readonly text: string;
	readonly reasoning: string;
}

export interface NoticeBlock {
	readonly kind: "notice";
	readonly tone: "info" | "warn" | "error";
	readonly text: string;
}

export interface PlanBlock {
	readonly kind: "plan";
	readonly text: string;
}

export interface FileBlock {
	readonly kind: "file";
	readonly path: string;
	readonly op: "create" | "modify" | "delete";
	readonly seq: number;
}

export type Block = AssistantBlock | LiveBlock | ToolBlock | NoticeBlock | PlanBlock | FileBlock;

export interface TurnView {
	readonly key: string;
	readonly prompt: string;
	readonly images: number;
	readonly blocks: readonly Block[];
}

/**
 * 会话事件 -> 对话框投影。
 *
 * 只保留用户能读懂的内容：正文、工具调用、计划、文件变更与错误；审批/回放细节在轨迹页。
 * 流式增量和工具实时输出不落盘，只能从 live 状态拼接在当前回合末尾。
 */
export function buildTimeline(
	events: readonly EventRecord[],
	live: LiveState,
	subagents: Readonly<Record<string, SubagentProgressView>>,
): readonly TurnView[] {
	const turns: MutableTurn[] = [];
	let current: MutableTurn | undefined;
	const tools = new Map<string, ToolBlock>();
	const planCalls = new Set<string>();
	const ensureCurrent = (): MutableTurn => {
		if (current !== undefined) return current;
		current = { key: `turn-orphan-${turns.length + 1}`, prompt: "", images: 0, blocks: [] };
		turns.push(current);
		return current;
	};

	for (const event of events) {
		switch (event.type) {
			case "user.input": {
				current = {
					key: `turn-${event.seq}`,
					prompt: event.payload.text,
					images: event.payload.images?.length ?? 0,
					blocks: [],
				};
				turns.push(current);
				tools.clear();
				break;
			}
			case "llm.response": {
				if (event.payload.text.length > 0) {
					ensureCurrent().blocks.push({ kind: "assistant", text: event.payload.text });
				}
				break;
			}
			case "tool.call": {
				const args = asRecord(event.payload.args);
				const plan = stringField(args, "plan");
				if (event.payload.tool === "present_plan" && plan !== undefined) {
					planCalls.add(event.payload.toolCallId);
					ensureCurrent().blocks.push({ kind: "plan", text: plan });
					break;
				}
				const block: ToolBlock = {
					kind: "tool",
					callId: event.payload.toolCallId,
					name: event.payload.tool,
					args: event.payload.args,
				};
				tools.set(block.callId, block);
				ensureCurrent().blocks.push(block);
				break;
			}
			case "tool.result": {
				if (planCalls.has(event.payload.toolCallId)) break;
				const existing = tools.get(event.payload.toolCallId);
				if (existing !== undefined) {
					const next: ToolBlock = {
						...existing,
						result: event.payload.result,
						isError: event.payload.isError,
						...(event.payload.elapsedMs === undefined ? {} : { durationMs: event.payload.elapsedMs }),
					};
					tools.set(next.callId, next);
					replaceBlock(turns, existing, next);
				} else {
					const block: ToolBlock = {
						kind: "tool",
						callId: event.payload.toolCallId,
						name: event.payload.tool,
						args: {},
						result: event.payload.result,
						isError: event.payload.isError,
						...(event.payload.elapsedMs === undefined ? {} : { durationMs: event.payload.elapsedMs }),
					};
					tools.set(block.callId, block);
					ensureCurrent().blocks.push(block);
				}
				break;
			}
			case "subagent.started": {
				const orTurn = ensureCurrent();
				const existing = tools.get(event.payload.toolCallId);
				const block: ToolBlock = existing ?? {
					kind: "tool",
					callId: event.payload.toolCallId,
					name: "task",
					args: { task: event.payload.task },
					subagent: { task: event.payload.task, status: "running" },
				};
				const next: ToolBlock = { ...block, subagent: { task: event.payload.task, status: "running" } };
				if (existing === undefined) {
					tools.set(block.callId, next);
					orTurn.blocks.push(next);
				} else {
					tools.set(block.callId, next);
					replaceBlock(turns, existing, next);
				}
				break;
			}
			case "subagent.finished": {
				const existing = tools.get(event.payload.toolCallId);
				if (existing !== undefined) {
					const next: ToolBlock = {
						...existing,
						result: event.payload.preview,
						isError: !event.payload.ok,
						durationMs: event.payload.durationMs,
						subagent: {
							task: existing.subagent?.task ?? "task",
							status: event.payload.ok ? "done" : "failed",
							steps: event.payload.steps,
							totalTokens: event.payload.totalTokens,
						},
					};
					tools.set(existing.callId, next);
					replaceBlock(turns, existing, next);
				}
				break;
			}
			case "file.changed": {
				ensureCurrent().blocks.push({
					kind: "file",
					path: event.payload.path,
					op: event.payload.op,
					seq: event.seq,
				});
				break;
			}
			case "compaction.done": {
				ensureCurrent().blocks.push({
					kind: "notice",
					tone: "info",
					text: `上下文已压缩（事件 ${event.payload.fromSeq}–${event.payload.toSeq}）`,
				});
				break;
			}
			case "rollback.done": {
				ensureCurrent().blocks.push({
					kind: "notice",
					tone: "info",
					text: `已回滚 ${event.payload.scope === "step" ? "最近一步" : "整任务"}：${event.payload.files.map(displayPath).join(", ") || "无文件"}`,
				});
				break;
			}
			case "breakpoint.paused":
			case "breakpoint.resumed": {
				ensureCurrent().blocks.push({
					kind: "notice",
					tone: "info",
					text: event.type === "breakpoint.paused" ? "任务已暂停" : "任务已继续",
				});
				break;
			}
			case "limit.blocked": {
				ensureCurrent().blocks.push({
					kind: "notice",
					tone: "error",
					text: event.payload.message ?? event.payload.command ?? event.payload.kind ?? "请求被策略拦截",
				});
				break;
			}
			case "error": {
				ensureCurrent().blocks.push({
					kind: "notice",
					tone: "error",
					text: event.payload.message,
				});
				break;
			}
			case "approval.granted":
			case "approval.denied":
			case "approval.reviewed":
			case "session.created":
			case "session.renamed":
			case "session.archived":
			case "mode.switched":
			case "llm.request":
			case "approval.requested":
				break;
		}
	}

	for (const turn of turns) {
		for (const block of turn.blocks) {
			if (block.kind !== "tool" || block.result !== undefined) continue;
			const output = live.toolOutputs[block.callId];
			if (output !== undefined) block.output = output;
		}
	}

	if (live.text.length > 0 || live.reasoning.length > 0) {
		const last = turns.at(-1);
		const block: LiveBlock = { kind: "live", text: live.text, reasoning: live.reasoning };
		if (last === undefined) {
			turns.push({ key: "turn-live", prompt: "", images: 0, blocks: [block] });
		} else {
			last.blocks.push(block);
		}
	}

	for (const turn of turns) {
		for (const block of turn.blocks) {
			if (block.kind !== "tool") continue;
			const progress = subagents[block.callId];
			if (progress === undefined || block.subagent === undefined) continue;
			block.subagent = { ...block.subagent, steps: progress.steps, totalTokens: progress.totalTokens };
		}
	}

	return turns;
}

interface MutableTurn {
	readonly key: string;
	readonly prompt: string;
	readonly images: number;
	readonly blocks: Block[];
}

function replaceBlock(turns: readonly MutableTurn[], oldBlock: ToolBlock, next: ToolBlock): void {
	for (const turn of turns) {
		const index = turn.blocks.findIndex((block) => block === oldBlock);
		if (index !== -1) {
			turn.blocks[index] = next;
			return;
		}
	}
}

export interface TranscriptProps {
	readonly turns: readonly TurnView[];
	readonly planning: boolean;
	readonly running: boolean;
	readonly onApprovePlan: (plan: string) => void;
	readonly onRevisePlan: () => void;
}

export function Transcript({ turns, planning, running, onApprovePlan, onRevisePlan }: TranscriptProps): JSX.Element {
	if (turns.length === 0) {
		return (
			<div className="chat-empty">
				<div className="welcome-brand">
					<span className="welcome-brand-logo">
						<MetaIcon size={30} />
					</span>
					<h2 className="welcome-brand-name">Moros Harness</h2>
					<p className="welcome-brand-desc">轻量、本地优先的办公与编程双场景 Agent</p>
				</div>
			</div>
		);
	}
	return (
		<div className="turns">
			{turns.map((turn) => (
				<div className="turn" key={turn.key}>
					{turn.prompt.length > 0 || turn.images > 0 ? (
						<div className="user-message">
							<div className="bubble">
								{turn.images > 0 ? <span className="image-count">{turn.images} 张图片</span> : null}
								{turn.prompt}
							</div>
						</div>
					) : null}
					<div className="assistant-column">
						<BlockList
							blocks={turn.blocks}
							planning={planning}
							running={running}
							onApprovePlan={onApprovePlan}
							onRevisePlan={onRevisePlan}
						/>
					</div>
				</div>
			))}
		</div>
	);
}

function BlockList({
	blocks,
	planning,
	running,
	onApprovePlan,
	onRevisePlan,
}: {
	readonly blocks: readonly Block[];
	readonly planning: boolean;
	readonly running: boolean;
	readonly onApprovePlan: (plan: string) => void;
	readonly onRevisePlan: () => void;
}): JSX.Element {
	const rendered: JSX.Element[] = [];
	let toolBuffer: ToolBlock[] = [];
	let key = 0;

	const flushTools = (): void => {
		if (toolBuffer.length === 0) return;
		rendered.push(<ToolGroup key={`tools-${key++}`} blocks={toolBuffer} />);
		toolBuffer = [];
	};

	for (const block of blocks) {
		if (block.kind === "tool") {
			toolBuffer.push(block);
			continue;
		}
		flushTools();
		switch (block.kind) {
			case "assistant":
				rendered.push(<Markdown key={`md-${key++}`} text={block.text} />);
				break;
			case "live":
				rendered.push(
					<div className="live-block" key={`live-${key++}`}>
						{block.reasoning.length > 0 ? (
							<details className="thinking">
								<summary>
									<SparklesIcon size={13} />
									<span>思考过程</span>
									<ChevronDownIcon size={13} />
								</summary>
								<div className="thinking-text">{block.reasoning}</div>
							</details>
						) : null}
						{block.text.length > 0 ? <Markdown text={block.text} className="is-streaming" /> : null}
					</div>,
				);
				break;
			case "notice":
				rendered.push(
					<div className={`inline-notice notice-${block.tone}`} key={`notice-${key++}`}>
						{block.tone === "error" ? <AlertIcon size={13} /> : <ClockIcon size={13} />}
						<span>{block.text}</span>
					</div>,
				);
				break;
			case "plan":
				rendered.push(
					<PlanCard
						key={`plan-${key++}`}
						plan={block.text}
						planning={planning}
						running={running}
						onApprove={onApprovePlan}
						onRevise={onRevisePlan}
					/>,
				);
				break;
			case "file":
				rendered.push(
					<div className="file-row" key={`file-${key++}`}>
						<FileIcon size={14} />
						<span className={`file-op op-${block.op}`}>{opLabel(block.op)}</span>
						<span className="file-path">{displayPath(block.path)}</span>
					</div>,
				);
				break;
		}
	}
	flushTools();
	return <>{rendered}</>;
}

function ToolGroup({ blocks }: { readonly blocks: readonly ToolBlock[] }): JSX.Element {
	const hasRunning = blocks.some((block) => block.result === undefined);
	const hasError = blocks.some((block) => block.isError === true);
	const [open, setOpen] = useState(hasRunning);
	useEffect(() => {
		if (hasRunning) setOpen(true);
	}, [hasRunning]);
	const label = hasRunning ? `正在调用 ${blocks.length} 个工具` : `已调用 ${blocks.length} 个工具`;
	return (
		<div className="tool-group">
			<button className={`tool-group-head ${hasError ? "has-error" : ""}`} onClick={() => setOpen(!open)}>
				{hasRunning ? <span className="spinner small" /> : <CheckIcon size={13} />}
				<span>{label}</span>
				{hasError ? <span className="tool-error-count">有失败</span> : null}
				{open ? <ChevronDownIcon size={13} /> : <ChevronRightIcon size={13} />}
			</button>
			{open ? (
				<div className="tool-rows">
					{blocks.map((block) => (
						<ToolRow key={block.callId} block={block} />
					))}
				</div>
			) : null}
		</div>
	);
}

function ToolRow({ block }: { readonly block: ToolBlock }): JSX.Element {
	const [open, setOpen] = useState(false);
	const status = block.result === undefined ? "running" : block.isError === true ? "error" : "ok";
	const detail = describeTool(block);
	const result = block.output ?? block.result;
	return (
		<div className={`tool-row status-${status}`}>
			<button className="tool-row-main" onClick={() => setOpen(!open)}>
				<span className="tool-icon">{iconForTool(block.name)}</span>
				<span className="tool-name">{block.subagent === undefined ? block.name : "subagent"}</span>
				<span className="tool-detail">{detail}</span>
				{status === "running" ? <span className="spinner small" /> : null}
				{status === "error" ? <AlertIcon size={13} className="tool-status-error" /> : null}
				{block.durationMs !== undefined ? (
					<span className="tool-duration">{formatDuration(block.durationMs)}</span>
				) : null}
			</button>
			{block.subagent !== undefined ? (
				<div className="subagent-meta">
					<BranchMeta />
					<span>{block.subagent.task}</span>
					{block.subagent.steps !== undefined ? (
						<small>
							{block.subagent.steps} 步 · {block.subagent.totalTokens ?? 0} tokens
						</small>
					) : null}
				</div>
			) : null}
			{open ? (
				<div className="tool-detail-panel">
					<div className="detail-label">参数</div>
					<pre>{formatArgs(block.args)}</pre>
					{result !== undefined ? (
						<>
							<div className="detail-label">{block.isError === true ? "错误" : "结果"}</div>
							<pre className={block.isError === true ? "is-error" : ""}>{truncateText(result, 6_000)}</pre>
						</>
					) : null}
				</div>
			) : null}
		</div>
	);
}

function PlanCard({
	plan,
	planning,
	running,
	onApprove,
	onRevise,
}: {
	readonly plan: string;
	readonly planning: boolean;
	readonly running: boolean;
	readonly onApprove: (plan: string) => void;
	readonly onRevise: () => void;
}): JSX.Element {
	return (
		<div className="plan-card">
			<div className="plan-head">
				<SparklesIcon size={15} />
				<span>实施计划</span>
				{planning ? <span className="pill">计划模式</span> : null}
			</div>
			<Markdown text={plan} />
			{planning ? (
				<div className="plan-actions">
					<button className="primary-button" disabled={running} onClick={() => onApprove(plan)}>
						批准并实施
					</button>
					<button className="ghost-button" onClick={onRevise}>
						继续修改
					</button>
				</div>
			) : null}
		</div>
	);
}

function BranchMeta(): JSX.Element {
	return <span className="branch-meta">子代理</span>;
}

function iconForTool(name: string): JSX.Element {
	if (name === "bash" || name === "powershell") return <TerminalIcon size={14} />;
	if (name === "read" || name === "write" || name === "edit" || name === "glob" || name === "grep") {
		return <FileIcon size={14} />;
	}
	if (name === "task") return <SparklesIcon size={14} />;
	return <FolderOpenIcon size={14} />;
}

function describeTool(block: ToolBlock): string {
	const args = asRecord(block.args);
	if (block.subagent !== undefined) return firstLine(block.subagent.task, 100);
	const path = stringField(args, "path") ?? stringField(args, "file_path");
	const command = stringField(args, "command");
	const pattern = stringField(args, "pattern");
	const task = stringField(args, "task");
	if (block.name === "present_plan") return "提交计划";
	if (command !== undefined) return firstLine(command, 120);
	if (path !== undefined) return path;
	if (pattern !== undefined) return pattern;
	if (task !== undefined) return firstLine(task, 100);
	const json = formatArgs(args).replaceAll(/\s+/g, " ");
	return firstLine(json, 100);
}

function opLabel(op: "create" | "modify" | "delete"): string {
	if (op === "create") return "新建";
	if (op === "delete") return "删除";
	return "修改";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function stringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
	const value = record?.[key];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function truncateText(text: string, limit: number): string {
	return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

function formatArgs(value: unknown): string {
	if (value === undefined) return "";
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value, null, 2) ?? String(value);
	} catch {
		return String(value);
	}
}
