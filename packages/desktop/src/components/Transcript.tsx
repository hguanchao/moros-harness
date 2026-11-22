import { useEffect, useRef, useState, type JSX, type ReactNode } from "react";

import type { EventRecord } from "@moros/core/events/schema.ts";
import type { LiveState } from "../shared/contract.ts";
import { displayPath, firstLine, formatDuration } from "../utils/format.ts";
import { describeToolGroup, toolVerb } from "../utils/tool-labels.ts";
import {
	AlertIcon,
	CheckIcon,
	ChevronDownIcon,
	ChevronRightIcon,
	ClockIcon,
	FileIcon,
	FolderOpenIcon,
	InfoIcon,
	ListTreeIcon,
	SparklesIcon,
	TerminalIcon,
} from "./Icons.tsx";
import { EmptyBrand } from "./EmptyBrand.tsx";
import { Markdown } from "./Markdown.tsx";
import type { InlineNotice, SubagentProgressView } from "../store/state.tsx";

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
	/** 落盘的模型推理链；缺省（旧事件/供应商未回传）时不渲染推理块。 */
	readonly reasoning?: string;
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

/** 对话中的居中分隔提示，如模型切换。 */
export interface DividerBlock {
	readonly kind: "divider";
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

export type Block = AssistantBlock | LiveBlock | ToolBlock | NoticeBlock | DividerBlock | PlanBlock | FileBlock;

export interface TurnView {
	readonly key: string;
	readonly prompt: string;
	readonly images: number;
	readonly blocks: readonly Block[];
	/** 本回合从用户输入到结束的时长（毫秒）；用于完成态的「已工作 X」摘要。 */
	readonly durationMs?: number;
}

/** 推理内容是否含实质文本：排除供应商在结束时回传的纯空白占位（如单个空格）。 */
function hasReasoningText(value: string | undefined): boolean {
	return value !== undefined && value.trim().length > 0;
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
	/** 运行中切换模型时，分隔线延后到下一轮开头显示；连续切换只保留最后一条。 */
	let pendingModelDivider: DividerBlock | undefined;
	/** 同一位置覆盖：连续的分隔块合并为一条，避免堆叠。 */
	const pushDivider = (turn: MutableTurn, divider: DividerBlock): void => {
		const last = turn.blocks.at(-1);
		if (last?.kind === "divider") turn.blocks[turn.blocks.length - 1] = divider;
		else turn.blocks.push(divider);
	};
	const ensureCurrent = (): MutableTurn => {
		if (current !== undefined) return current;
		current = { key: `turn-orphan-${turns.length + 1}`, prompt: "", images: 0, blocks: [] };
		turns.push(current);
		return current;
	};

	for (const event of events) {
		// 记录回合首末时间戳；首事件即 user.input，后续事件持续刷新 endedTs
		if (event.type !== "user.input" && current !== undefined) current.endedTs = event.ts;
		switch (event.type) {
			case "user.input": {
				current = {
					key: `turn-${event.seq}`,
					prompt: event.payload.text,
					images: event.payload.images?.length ?? 0,
					blocks: [],
					startedTs: event.ts,
					endedTs: event.ts,
				};
				// 运行中切换的模型在下一轮发送后才显示分隔线。
				if (pendingModelDivider !== undefined) {
					current.blocks.push(pendingModelDivider);
					pendingModelDivider = undefined;
				}
				turns.push(current);
				tools.clear();
				break;
			}
			case "llm.response": {
				const reasoning = hasReasoningText(event.payload.reasoning) ? event.payload.reasoning : undefined;
				if (event.payload.text.length > 0 || reasoning !== undefined) {
					ensureCurrent().blocks.push({
						kind: "assistant",
						text: event.payload.text,
						...(reasoning === undefined ? {} : { reasoning }),
					});
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
			case "model.changed": {
				const divider: DividerBlock = {
					kind: "divider",
					text: `模型已从 ${event.payload.from} 更改为 ${event.payload.to}`,
				};
				if (event.payload.appliesNextTurn) {
					// 运行中切换：延后到下一轮，连续切换只保留最后一条。
					pendingModelDivider = divider;
				} else {
					pushDivider(ensureCurrent(), divider);
				}
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

	if (live.text.length > 0 || hasReasoningText(live.reasoning)) {
		const last = turns.at(-1);
		const reasoning = hasReasoningText(live.reasoning) ? live.reasoning : "";
		const block: LiveBlock = { kind: "live", text: live.text, reasoning };
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

	for (const turn of turns) {
		if (turn.startedTs === undefined || turn.endedTs === undefined) continue;
		const elapsed = Date.parse(turn.endedTs) - Date.parse(turn.startedTs);
		if (Number.isFinite(elapsed) && elapsed >= 0) turn.durationMs = elapsed;
	}

	return turns;
}

interface MutableTurn {
	readonly key: string;
	readonly prompt: string;
	readonly images: number;
	readonly blocks: Block[];
	/** 事件时间戳字符串，末事件减首事件得到回合时长。 */
	startedTs?: string;
	endedTs?: string;
	durationMs?: number;
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
	/** 会话级警告/错误，直接显示在对话流顶部。 */
	readonly inlineNotices: readonly InlineNotice[];
	readonly planning: boolean;
	readonly running: boolean;
	readonly onApprovePlan: (plan: string) => void;
	readonly onRevisePlan: () => void;
}

export function Transcript({
	turns,
	inlineNotices,
	planning,
	running,
	onApprovePlan,
	onRevisePlan,
}: TranscriptProps): JSX.Element {
	const noticeBlocks =
		inlineNotices.length === 0 ? null : (
			<div className="inline-notices">
				{inlineNotices.map((notice, index) => (
					<div className={`inline-notice notice-${notice.tone}`} key={`inline-${index}`}>
						<AlertIcon size={13} />
						<span>{notice.text}</span>
					</div>
				))}
			</div>
		);
	if (turns.length === 0) {
		return (
			<div className="chat-empty">
				{noticeBlocks}
				<EmptyBrand />
			</div>
		);
	}
	return (
		<div className="turns">
			{noticeBlocks}
			{turns.map((turn, index) => (
				<div className="turn" id={turn.key} key={turn.key}>
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
							{...(turn.durationMs === undefined ? {} : { durationMs: turn.durationMs })}
							planning={planning}
							running={running}
							isActive={running && index === turns.length - 1}
							runningHint={running && index === turns.length - 1}
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
	durationMs,
	planning,
	running,
	isActive = false,
	runningHint = false,
	onApprovePlan,
	onRevisePlan,
}: {
	readonly blocks: readonly Block[];
	readonly durationMs?: number;
	readonly planning: boolean;
	readonly running: boolean;
	/** 活跃回合（最后一个且会话运行中）：过程全程平铺，完成后才折叠。 */
	readonly isActive?: boolean;
	/** 仅最后一个回合显示：运行中且尚无流式输出时给出「正在推理」占位。 */
	readonly runningHint?: boolean;
	readonly onApprovePlan: (plan: string) => void;
	readonly onRevisePlan: () => void;
}): JSX.Element {
	const rendered: JSX.Element[] = [];
	/** 最终答案之前的过程（含中间正文、推理、工具、文件）压进摘要。 */
	const trail: JSX.Element[] = [];
	let toolBuffer: ToolBlock[] = [];
	let key = 0;
	let hasLive = false;
	// 活跃回合推理保持展开（图1的过程平铺）；回合完成后正文出现才自动折叠。
	// 用户手动展开后由 onToggle 记录，不被后续增量重渲染强行改回。
	const liveHasText = blocks.some((block) => block.kind === "live" && block.text.length > 0);
	const shouldCollapseLive = liveHasText && !isActive;
	const [liveCollapsed, setLiveCollapsed] = useState(shouldCollapseLive);
	const liveManuallyToggled = useRef(false);
	useEffect(() => {
		if (!liveManuallyToggled.current && shouldCollapseLive) setLiveCollapsed(true);
	}, [shouldCollapseLive]);

	// 最终答案 = 最后一块含正文的 assistant/live。它之前的所有内容（包括中间正文）都收进过程摘要。
	let lastAnswerIndex = -1;
	for (let i = blocks.length - 1; i >= 0; i -= 1) {
		const block = blocks[i];
		if (block === undefined) continue;
		if ((block.kind === "assistant" || block.kind === "live") && block.text.length > 0) {
			lastAnswerIndex = i;
			break;
		}
	}

	const flushTools = (): void => {
		if (toolBuffer.length === 0) return;
		const group = toolBuffer;
		trail.push(<ToolGroup key={`tools-${key++}`} blocks={group} />);
		toolBuffer = [];
	};

	const pushTrail = (element: JSX.Element): void => {
		flushTools();
		trail.push(element);
	};

	for (let index = 0; index < blocks.length; index += 1) {
		const block = blocks[index];
		if (block === undefined) continue;
		// 最终答案之前的所有块都进过程摘要；计划卡片始终单独展开（需交互批准）
		const isProcess = index < lastAnswerIndex && block.kind !== "plan";
		if (block.kind === "tool") {
			toolBuffer.push(block);
			continue;
		}
		switch (block.kind) {
			case "assistant": {
				if (hasReasoningText(block.reasoning)) {
					pushTrail(
						<details className="thinking" key={`think-${key++}`}>
							<summary>
								<SparklesIcon size={13} />
								<span>推理过程</span>
								<ChevronDownIcon size={13} />
							</summary>
							<div className="thinking-text">{block.reasoning}</div>
						</details>,
					);
				}
				flushTools();
				if (block.text.length > 0) {
					const markdown = <Markdown key={`md-${key++}`} text={block.text} />;
					if (isProcess) trail.push(markdown);
					else rendered.push(markdown);
				}
				break;
			}
			case "live":
				hasLive = true;
				// live 是当前回合的流式答案，始终展开在摘要之后
				flushTools();
				rendered.push(
					<div className="live-block" key={`live-${key++}`}>
						{hasReasoningText(block.reasoning) ? (
							<details
								className="thinking"
								open={!liveCollapsed}
								onToggle={(event) => {
									liveManuallyToggled.current = true;
									setLiveCollapsed(!(event.currentTarget as HTMLDetailsElement).open);
								}}
							>
								<summary>
									<SparklesIcon size={13} className="thinking-live-icon" />
									<span className="thinking-live-label">推理过程</span>
									<ChevronDownIcon size={13} />
								</summary>
								<div className="thinking-text">{block.reasoning}</div>
							</details>
						) : null}
						{block.text.length > 0 ? <Markdown text={block.text} className="is-streaming" /> : null}
					</div>,
				);
				break;
			case "notice": {
				const notice = (
					<div className={`inline-notice notice-${block.tone}`} key={`notice-${key++}`}>
						{block.tone === "error" ? <AlertIcon size={13} /> : <ClockIcon size={13} />}
						<span>{block.text}</span>
					</div>
				);
				// 警告/错误始终可见，不折叠进「已工作 X」过程摘要。
				if (block.tone === "warn" || block.tone === "error") {
					flushTools();
					rendered.push(notice);
				} else {
					pushTrail(notice);
				}
				break;
			}
			case "divider":
				// 模型切换分隔线始终可见，不折叠进过程摘要
				flushTools();
				rendered.push(
					<div className="inline-divider" key={`divider-${key++}`}>
						<InfoIcon size={13} />
						<span>{block.text}</span>
					</div>,
				);
				break;
			case "plan":
				// 计划卡片需要用户批准，属于交互内容，不折叠进过程摘要
				flushTools();
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
				pushTrail(
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
	// 运行中但还没有任何可见输出（首 token 延迟、工具结果后的下一次生成间隙）：
	// 最后一块不是仍在执行的工具时，给出轻量的推理占位，避免界面看起来像没反应。
	const lastBlock = blocks.at(-1);
	const toolRunning = lastBlock?.kind === "tool" && lastBlock.result === undefined;
	if (runningHint && !hasLive && !toolRunning) {
		rendered.push(
			<div className="turn-hint" key="running-hint">
				<span className="spinner small" />
				<span>正在推理…</span>
			</div>,
		);
	}

	const trailContent = trail.length > 0;
	const toolsForSummary = blocks.filter((block): block is ToolBlock => block.kind === "tool");
	return (
		<>
			{/* 活跃回合过程全程平铺；回合完成后才压成「已工作 X」摘要 */}
			{isActive ? (
				trail
			) : trailContent ? (
				<TurnTrail tools={toolsForSummary} {...(durationMs === undefined ? {} : { durationMs })}>
					{trail}
				</TurnTrail>
			) : null}
			{rendered}
		</>
	);
}

/** 中文时长：1m 59s -> "1分59秒"，不足 1 分钟显示秒。 */
function formatWorkDuration(ms: number | undefined): string {
	if (ms === undefined || ms < 1_000) return "刚刚";
	const seconds = Math.round(ms / 1_000);
	if (seconds < 60) return `${seconds}秒`;
	return `${Math.floor(seconds / 60)}分${seconds % 60}秒`;
}

/**
 * 回合过程摘要：把最终答案之前的正文、推理、工具压成一行「已工作 X」，
 * 点击展开看明细（参考 Codex/Claude Code 的折叠视图）。
 * 仅用于已完成回合；活跃回合由调用方直接平铺，不套这层摘要。
 */
function TurnTrail({
	tools,
	durationMs,
	children,
}: {
	readonly tools: readonly ToolBlock[];
	readonly durationMs?: number;
	readonly children: ReactNode;
}): JSX.Element {
	const [open, setOpen] = useState(false);
	const expanded = open;
	const names = tools.map((tool) => tool.name);
	const toolsSummary = describeToolGroup(names, false);
	const label = toolsSummary
		? `已工作 ${formatWorkDuration(durationMs)} · ${toolsSummary}`
		: `已工作 ${formatWorkDuration(durationMs)}`;
	return (
		<div className={`turn-trail ${expanded ? "is-open" : ""}`}>
			<button className="turn-trail-head" onClick={() => setOpen(!open)}>
				<span className="turn-trail-icon">
					<ListTreeIcon size={13} />
				</span>
				<span className="turn-trail-label">{label}</span>
				{expanded ? <ChevronDownIcon size={13} /> : <ChevronRightIcon size={13} />}
			</button>
			{expanded ? <div className="turn-trail-body">{children}</div> : null}
		</div>
	);
}

function ToolGroup({ blocks }: { readonly blocks: readonly ToolBlock[] }): JSX.Element {
	const hasRunning = blocks.some((block) => block.result === undefined);
	const hasError = blocks.some((block) => block.isError === true);
	const [open, setOpen] = useState(hasRunning);
	useEffect(() => {
		if (hasRunning) setOpen(true);
	}, [hasRunning]);
	const label = describeToolGroup(
		blocks.map((block) => block.name),
		hasRunning,
	);
	return (
		<div className={`tool-group ${hasRunning ? "is-running" : ""}`}>
			<button className={`tool-group-head ${hasError ? "has-error" : ""}`} onClick={() => setOpen(!open)}>
				<span className="tool-state">
					<CheckIcon size={13} className="state-done" />
					{hasRunning ? <span className="spinner small state-running" /> : null}
				</span>
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
	const resultRef = useRef<HTMLPreElement | null>(null);
	const status = block.result === undefined ? "running" : block.isError === true ? "error" : "ok";
	const detail = describeTool(block);
	const result = block.output ?? block.result;
	const streaming = status === "running" && result !== undefined;

	// 结果框滚动策略：流式期间跟随输出尾部（仅当视口已在底部附近，不打扰向上翻阅）；
	// 结果落定后回到顶部，从开头阅读完整输出，避免停在半截看起来像被截断。
	useEffect(() => {
		const pre = resultRef.current;
		if (pre === null) return;
		if (streaming) {
			const nearBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 24;
			if (nearBottom) pre.scrollTop = pre.scrollHeight;
			return;
		}
		pre.scrollTop = 0;
	}, [streaming, result, open]);
	return (
		<div className={`tool-row status-${status}`}>
			<button className="tool-row-main" onClick={() => setOpen(!open)}>
				<span className="tool-icon">{iconForTool(block.name)}</span>
				<span className="tool-name">{block.subagent === undefined ? toolVerb(block.name) : "子任务"}</span>
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
			{/* 面板常驻挂载，grid-rows 折叠过渡展开/收起；视觉样式放内层，折叠层保持零尺寸 */}
			<div className={`tool-detail-wrap ${open ? "is-open" : ""}`}>
				<div className="tool-detail-panel">
					<div className="tool-detail-panel-inner">
						<div className="detail-label">参数</div>
						<pre>{formatArgs(block.args)}</pre>
						{result !== undefined ? (
							<>
								<div className="detail-label">{block.isError === true ? "错误" : "结果"}</div>
								<pre ref={resultRef} className={block.isError === true ? "is-error" : ""}>
									{truncateText(result, 6_000)}
								</pre>
							</>
						) : null}
					</div>
				</div>
			</div>
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
