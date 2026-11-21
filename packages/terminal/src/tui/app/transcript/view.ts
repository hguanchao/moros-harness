import { stripVTControlCharacters } from "node:util";

import { sanitizeLine } from "../contract/describe.ts";
import { TRANSCRIPT } from "../copy/index.ts";
import { formatDuration } from "../contract/format.ts";
import { highlightImageMarkers } from "../image.ts";
import { renderMarkdown } from "../render/markdown.ts";
import {
	characterWidth,
	coloredLine,
	displayWidth,
	graphemes,
	sanitizeForDisplay,
	truncateToWidth,
	wrapText,
	wrappedLines,
} from "../../term/index.ts";
import { THEME } from "../render/theme.ts";
import { todoCardLines } from "../widget/todo-card.ts";
import type { AnimationFrame } from "../render/sweep.ts";
import { lineIndexAtRow, scrollState, scrollableLines, scrollbarColumn, visibleIndexes } from "./scroll.ts";
import { highlightSelection, selectionRange, stripTerminalStyles, visibleTextWidth } from "./selection.ts";
import type { SelectionRegion } from "./selection.ts";
import {
	DETAIL_BAND_LEFT,
	DETAIL_RIGHT_PADDING,
	ERROR_COLOR,
	ERROR_MARKER,
	GUTTER_WIDTH,
	MESSAGE_TEXT_COLOR,
	MIN_DETAIL_CONTENT,
	NOTICE_COLOR,
	PLAN_CARD_HINT,
	PLAN_HINT_COLOR,
	PLAN_MARKER_COLOR,
	PLAN_TITLE_COLOR,
	PROMPT_BG,
	PROMPT_INDENT,
	PROMPT_MAX_LINES,
	PROMPT_PREFIX,
	RESET,
	RESPONSE_INDENT,
	THINKING_ACTIVE_COLOR,
	THINKING_BG,
	THINKING_COLOR,
	THINKING_EXPANDED_PREFIX,
	THINKING_PADDING,
	THINKING_PREFIX,
	THINKING_TAIL_LINES,
} from "./style.ts";
import { animatedSubagentLine, subagentGroupLines } from "./subagent.ts";
import { expandTabs, stripLineControls } from "./detail.ts";
import { hasExpandableDetail, toolGroupLines, toolLines, toolResultLines } from "./tool.ts";
import { PLAIN_LINE_META } from "./types.ts";
import type {
	LineMeta,
	LineMetaState,
	LiveSubagentLine,
	TranscriptLine,
	TranscriptMarkdown,
	TranscriptMetrics,
	TranscriptPlan,
	TranscriptThinking,
	TranscriptTool,
	TranscriptToolGroup,
	TranscriptTurn,
	TranscriptView,
} from "./types.ts";

/** 增量构建从干净状态开始时的元数据状态。 */
const EMPTY_LINE_META_STATE: LineMetaState = { contentStart: 0, inDetail: false, diffBand: false };
const STREAMING_WRAP_CACHE = new WeakMap<TranscriptMarkdown, StreamingWrapState>();

interface StreamingWrapState {
	readonly width: number;
	rawLength: number;
	pendingControl: string;
	pendingGrapheme: string;
	readonly rows: string[];
	readonly visibleRows: string[];
	visibleStableCount: number;
	line: string;
	used: number;
}

function createStreamingWrapState(width: number): StreamingWrapState {
	return {
		width,
		rawLength: 0,
		pendingControl: "",
		pendingGrapheme: "",
		rows: [],
		visibleRows: [],
		visibleStableCount: 0,
		line: "",
		used: 0,
	};
}

/** 流式文本按新增字素增量折行；仅保留最后一个字素，处理跨增量的组合字符。 */
function streamingMarkdownLines(block: TranscriptMarkdown, width: number): readonly string[] {
	const prefixWidth = displayWidth(RESPONSE_INDENT);
	const contentWidth = Math.max(0, width - prefixWidth);
	let cache = STREAMING_WRAP_CACHE.get(block);
	if (cache === undefined || cache.width !== contentWidth || cache.rawLength > block.text.length) {
		cache = createStreamingWrapState(contentWidth);
		STREAMING_WRAP_CACHE.set(block, cache);
	}

	const appended = block.text.slice(cache.rawLength);
	cache.rawLength = block.text.length;
	const raw = cache.pendingControl + appended;
	let safeLength = completeControlPrefixLength(raw);
	if (safeLength > 0 && raw[safeLength - 1] === "\r") safeLength -= 1;
	cache.pendingControl = raw.slice(safeLength);

	const cleaned = sanitizeForDisplay(raw.slice(0, safeLength));
	const combined = cache.pendingGrapheme + cleaned;
	const chars = graphemes(combined);
	const endsWithNewline = chars.at(-1) === "\n";
	const processCount = endsWithNewline ? chars.length : Math.max(0, chars.length - 1);
	for (let index = 0; index < processCount; index += 1) {
		appendStreamingCharacter(cache, chars[index] ?? "", width);
	}
	cache.pendingGrapheme = chars.slice(processCount).join("");

	cache.visibleRows.length = cache.visibleStableCount;
	for (let index = cache.visibleStableCount; index < cache.rows.length; index += 1) {
		cache.visibleRows.push(cache.rows[index] ?? "");
	}
	cache.visibleStableCount = cache.rows.length;
	let line = cache.line;
	let used = cache.used;
	for (const char of graphemes(cache.pendingGrapheme)) {
		const charWidth = characterWidth(char);
		if (contentWidth > 0 && used + charWidth > contentWidth && line.length > 0) {
			cache.visibleRows.push(streamingRow(line, width));
			line = "";
			used = 0;
		}
		if (contentWidth > 0) {
			line += char;
			used += charWidth;
		}
	}
	cache.visibleRows.push(streamingRow(line, width));
	return cache.visibleRows;
}

/** 结束流式 Markdown 后丢弃按宽度缓存的纯文本行，避免历史块重复占用内存。 */
export function forgetStreamingMarkdown(block: TranscriptMarkdown): void {
	STREAMING_WRAP_CACHE.delete(block);
}

function appendStreamingCharacter(cache: StreamingWrapState, char: string, width: number): void {
	const contentWidth = cache.width;
	if (char === "\n") {
		cache.rows.push(streamingRow(cache.line, width));
		cache.line = "";
		cache.used = 0;
		return;
	}
	if (contentWidth <= 0) return;
	const charWidth = characterWidth(char);
	if (cache.used + charWidth > contentWidth && cache.line.length > 0) {
		cache.rows.push(streamingRow(cache.line, width));
		cache.line = "";
		cache.used = 0;
	}
	cache.line += char;
	cache.used += charWidth;
}

function streamingRow(line: string, width: number): string {
	return coloredLine(`${RESPONSE_INDENT}${line}`, width, MESSAGE_TEXT_COLOR);
}

/** 返回完整终端控制序列之前的前缀，尾部未完成序列留到下次增量处理。 */
function completeControlPrefixLength(text: string): number {
	for (let index = 0; index < text.length;) {
		if (text.charCodeAt(index) !== 0x1b) {
			index += 1;
			continue;
		}
		const introducer = text[index + 1];
		if (introducer === undefined) return index;
		if (introducer === "[") {
			let end = index + 2;
			while (end < text.length && !/[\x40-\x7e]/.test(text[end] ?? "")) end += 1;
			if (end === text.length) return index;
			index = end + 1;
			continue;
		}
		if (introducer === "]") {
			let end = index + 2;
			while (end < text.length) {
				if (text.charCodeAt(end) === 0x07) break;
				if (text.charCodeAt(end) === 0x1b && text[end + 1] === "\\") break;
				end += 1;
			}
			if (end === text.length) return index;
			index = text.charCodeAt(end) === 0x1b ? end + 2 : end + 1;
			continue;
		}
		if (introducer === "P" || introducer === "_" || introducer === "^" || introducer === "X") {
			let end = index + 2;
			while (end + 1 < text.length && !(text.charCodeAt(end) === 0x1b && text[end + 1] === "\\")) end += 1;
			if (end + 1 >= text.length) return index;
			index = end + 2;
			continue;
		}
		let end = index + 1;
		while (end < text.length && text.charCodeAt(end) >= 0x20 && text.charCodeAt(end) <= 0x2f) end += 1;
		if (end === text.length) return index;
		const final = text.charCodeAt(end);
		if (final >= 0x30 && final <= 0x7e) index = end + 1;
		else index += 2;
	}
	return text.length;
}

export function transcriptMetrics(
	terminalWidth: number,
	height: number,
	turns: readonly TranscriptTurn[],
	notice?: string,
): TranscriptMetrics {
	return measureTranscriptView(buildTranscriptView(terminalWidth, turns, notice), height);
}

/**
 * 增量构建的起点。
 *
 * 已经写完的回合不会再变，把它们排好的行原样接在新内容前面，就不必每帧重新解析整份历史
 * 的 markdown。前缀最后一个回合有没有回复要单独给出：它决定下一个回合前是否留空行，
 * 而从行数组本身看不出来。
 */
export interface TranscriptBuildBase {
	readonly view: TranscriptView;
	readonly previousHadResponse: boolean;
	/** 前一帧完整视图；同一冻结前缀下复用可变数组，只重建活动回合的尾部。 */
	readonly reuse?: TranscriptView;
}

/** 按当前宽度构建一次；调用方可以缓存它，供测量、绘制和命中复用。 */
export function buildTranscriptView(
	terminalWidth: number,
	turns: readonly TranscriptTurn[],
	notice?: string,
	base?: TranscriptBuildBase,
): TranscriptView {
	return build(contentWidth(terminalWidth), turns, notice, base);
}

export function measureTranscriptView(view: TranscriptView, height: number): TranscriptMetrics {
	const lastPromptStart = view.prompts.at(-1)?.start ?? 0;
	const rows = Math.max(0, height);
	return {
		totalLines: view.lines.length,
		scrollLines: scrollableLines(view.lines.length, lastPromptStart, rows),
		lastPromptStart,
	};
}

/**
 * 渲染可视窗口。
 *
 * scrollTop 是从 transcript 顶部滚过的行数。提示块被滚出顶部时，把它和它的 1 行 gap
 * 固定在第一行，正文从当前滚动位置继续往下画。
 */
export function renderTranscriptView(
	view: TranscriptView,
	height: number,
	scrollTop: number,
	frame?: AnimationFrame,
	selection?: SelectionRegion,
): readonly string[] {
	const rows = Math.max(0, height);
	if (rows === 0) return [];
	if (view.lines.length === 0) return Array.from({ length: rows }, () => "");

	const { top } = scrollState(view, rows, scrollTop);
	const indexes = visibleIndexes(view, rows, top);
	const lineAt = (index: number): string => {
		// 运行中的子代理行按当前帧重建：动画只在可见行上花工夫，视图本身不重建
		if (frame !== undefined) {
			const live = view.liveLines.get(index);
			if (live !== undefined) return animatedSubagentLine(live, frame, view.width);
		}
		return view.lines[index] ?? " ".repeat(view.width);
	};
	const visible = indexes.map((index) => {
		const line = lineAt(index);
		if (selection === undefined) return line;
		const meta = view.lineMeta[index] ?? PLAIN_LINE_META;
		const range = selectionRange(index, selection, visibleTextWidth(line), meta.contentStart);
		return range === undefined ? line : highlightSelection(line, range);
	});

	const gutter = scrollbarColumn(rows, scrollableLines(view.lines.length, view.prompts.at(-1)?.start ?? 0, rows), top);
	return visible.map((line, index) => `${line} ${gutter[index]}`);
}

export function thinkingHeaderInView(
	view: TranscriptView,
	height: number,
	scrollTop: number,
	row: number,
): TranscriptThinking | undefined {
	const index = lineIndexAtRow(view, height, scrollTop, row);
	return index === undefined ? undefined : view.thinkingHeaders.find((header) => header.start === index)?.block;
}

/** 命中整个推理区块：标题与展开后的正文都算。 */
export function thinkingBlockInView(
	view: TranscriptView,
	height: number,
	scrollTop: number,
	row: number,
): TranscriptThinking | undefined {
	const index = lineIndexAtRow(view, height, scrollTop, row);
	return index === undefined
		? undefined
		: view.thinkingHeaders.find((entry) => index >= entry.start && index < entry.end)?.block;
}

export function toolGroupHeaderInView(
	view: TranscriptView,
	height: number,
	scrollTop: number,
	row: number,
): TranscriptToolGroup | undefined {
	const index = lineIndexAtRow(view, height, scrollTop, row);
	return index === undefined ? undefined : view.groupHeaders.find((header) => header.start === index)?.group;
}

export function toolHeaderInView(
	view: TranscriptView,
	height: number,
	scrollTop: number,
	row: number,
): TranscriptTool | undefined {
	const index = lineIndexAtRow(view, height, scrollTop, row);
	return index === undefined ? undefined : view.toolHeaders.find((header) => header.start === index)?.tool;
}

/** 命中整条工具：标题与展开后的详情/结果都算。 */
export function toolBlockInView(
	view: TranscriptView,
	height: number,
	scrollTop: number,
	row: number,
): TranscriptTool | undefined {
	const index = lineIndexAtRow(view, height, scrollTop, row);
	return index === undefined
		? undefined
		: view.toolHeaders.find((entry) => index >= entry.start && index < entry.end)?.tool;
}

/** 命中收尾任务卡的头行；双击在收起与展开之间切换。 */
export function todoHeaderInView(
	view: TranscriptView,
	height: number,
	scrollTop: number,
	row: number,
): TranscriptView["todoHeaders"][number]["card"] | undefined {
	const index = lineIndexAtRow(view, height, scrollTop, row);
	return index === undefined ? undefined : view.todoHeaders.find((header) => header.start === index)?.card;
}

/** 命中计划卡；双击打开完整计划。 */
export function planHeaderInView(
	view: TranscriptView,
	height: number,
	scrollTop: number,
	row: number,
): TranscriptPlan | undefined {
	const index = lineIndexAtRow(view, height, scrollTop, row);
	return index === undefined ? undefined : view.planHeaders.find((header) => header.start === index)?.plan;
}

/** 命中子代理组头；双击在收起与展开之间切换。 */
export function subagentGroupHeaderInView(
	view: TranscriptView,
	height: number,
	scrollTop: number,
	row: number,
): TranscriptView["subagentHeaders"][number]["group"] | undefined {
	const index = lineIndexAtRow(view, height, scrollTop, row);
	return index === undefined ? undefined : view.subagentHeaders.find((header) => header.start === index)?.group;
}

/** 命中失败的子代理清单行；双击展开/收起失败原因。 */
export function subagentFailureRowInView(
	view: TranscriptView,
	height: number,
	scrollTop: number,
	row: number,
): { readonly group: TranscriptView["subagentHeaders"][number]["group"]; readonly callId: string } | undefined {
	const index = lineIndexAtRow(view, height, scrollTop, row);
	return index === undefined
		? undefined
		: view.subagentFailureRows.find((entry) => index >= entry.start && index < entry.end);
}

function contentWidth(terminalWidth: number): number {
	return Math.max(0, Math.max(0, terminalWidth) - GUTTER_WIDTH);
}

/** 对话流里可以连成一块的内容类型：同类连续行紧凑排列，块与块之间留空行。 */
type ResponseBlockKind = "text" | "thinking" | "tools" | "todo" | "plan" | "notice";

function responseBlockKind(line: TranscriptLine): ResponseBlockKind {
	if (typeof line === "string") return "text";
	if (line.kind === "markdown") return "text";
	if (line.kind === "tool") return line.isError === true ? "notice" : "tools";
	if (line.kind === "toolGroup") return "tools";
	if (line.kind === "thinkingBlock") return "thinking";
	if (line.kind === "todo") return "todo";
	if (line.kind === "plan") return "plan";
	// 子代理组与普通工具块同类:它是这一轮调用的过程,不该像警告那样自成一块
	if (line.kind === "subagentGroup") return "tools";
	return "notice";
}

/**
 * 相邻两条内容之间是否需要空行。
 *
 * 推理摘要与它所解释的工具调用成对紧凑（推理在工具正上方）；一对结束之后，新一轮
 * 推理另起一块——长批次（叙述规则引入后常见十几行）不留呼吸会连成一堵墙（ADR-15
 * 真实使用反馈）。正文、失败、警告各自独立成块。工具调用的失败原因紧跟在调用行
 * 之后，是同一件事的两半，不能被空行拆开。
 */
function needsBlockGap(previous: TranscriptLine, current: TranscriptLine): boolean {
	if (isToolFailure(previous, current)) return false;
	// 展开的块摊开了多行内容，紧接下一批会粘成一片：下面留一行默认背景再走类型判断
	if (isExpandedBlock(previous)) return true;
	const previousKind = responseBlockKind(previous);
	const currentKind = responseBlockKind(current);
	if (previousKind !== currentKind) {
		// 推理→工具成对紧凑；工具→推理是新一轮单元的开始，留空行呼吸
		const pair = `${previousKind}/${currentKind}`;
		return pair !== "thinking/tools";
	}
	// 推理、任务卡、计划卡与失败、警告各自独立成块：即使前后同类也要分开
	return currentKind === "thinking" || currentKind === "todo" || currentKind === "plan" || currentKind === "notice";
}

/** 这一行是否已经展开：推理全文、工具详情/结果、展开的组都算。 */
function isExpandedBlock(line: TranscriptLine): boolean {
	if (typeof line === "string") return false;
	if (line.kind === "thinkingBlock") return line.expanded;
	if (line.kind === "toolGroup" || line.kind === "subagentGroup") return line.expanded;
	if (line.kind === "tool") return line.detailExpanded === true || line.resultExpanded === true;
	return false;
}

/** 失败行是否属于上一条工具调用。 */
function isToolFailure(previous: TranscriptLine, current: TranscriptLine): boolean {
	if (typeof current !== "object" || current === null) return false;
	if (current.kind !== "tool" || current.isError !== true) return false;
	return (
		typeof previous === "object" && previous !== null && (previous.kind === "tool" || previous.kind === "toolGroup")
	);
}

function build(
	width: number,
	turns: readonly TranscriptTurn[],
	notice: string | undefined,
	base?: TranscriptBuildBase,
): TranscriptView {
	// 所有登记项（提示块、各卡片头行、子代理活动行）记的都是绝对行号，因此接着前缀往下排
	// 不需要任何偏移换算：lines.length 已经包含了前缀的长度。
	const reuse = base?.reuse;
	const lines = reuse?.lines ?? (base === undefined ? [] : [...base.view.lines]);
	const prompts = reuse?.prompts ?? (base === undefined ? [] : [...base.view.prompts]);
	const thinkingHeaders = (reuse?.thinkingHeaders ?? (base === undefined ? [] : [...base.view.thinkingHeaders])) as {
		start: number;
		end: number;
		block: TranscriptThinking;
	}[];
	const groupHeaders = (reuse?.groupHeaders ?? (base === undefined ? [] : [...base.view.groupHeaders])) as {
		start: number;
		group: TranscriptToolGroup;
	}[];
	const toolHeaders = (reuse?.toolHeaders ?? (base === undefined ? [] : [...base.view.toolHeaders])) as {
		start: number;
		end: number;
		tool: TranscriptTool;
	}[];
	const liveLines =
		reuse === undefined
			? base === undefined
				? new Map<number, LiveSubagentLine>()
				: new Map(base.view.liveLines)
			: (reuse.liveLines as Map<number, LiveSubagentLine>);
	const todoHeaders = (reuse?.todoHeaders ?? (base === undefined ? [] : [...base.view.todoHeaders])) as {
		start: number;
		card: TranscriptView["todoHeaders"][number]["card"];
	}[];
	const planHeaders = (reuse?.planHeaders ?? (base === undefined ? [] : [...base.view.planHeaders])) as {
		start: number;
		plan: TranscriptPlan;
	}[];
	const subagentHeaders = (reuse?.subagentHeaders ?? (base === undefined ? [] : [...base.view.subagentHeaders])) as {
		start: number;
		group: TranscriptView["subagentHeaders"][number]["group"];
	}[];
	const subagentFailureRows = (reuse?.subagentFailureRows ??
		(base === undefined ? [] : [...base.view.subagentFailureRows])) as {
		start: number;
		end: number;
		group: TranscriptView["subagentHeaders"][number]["group"];
		callId: string;
	}[];
	if (reuse !== undefined && base !== undefined) {
		const prefix = base.view;
		lines.length = prefix.lines.length;
		prompts.length = prefix.prompts.length;
		thinkingHeaders.length = prefix.thinkingHeaders.length;
		groupHeaders.length = prefix.groupHeaders.length;
		toolHeaders.length = prefix.toolHeaders.length;
		todoHeaders.length = prefix.todoHeaders.length;
		planHeaders.length = prefix.planHeaders.length;
		subagentHeaders.length = prefix.subagentHeaders.length;
		subagentFailureRows.length = prefix.subagentFailureRows.length;
		liveLines.clear();
	}
	// 这些行有底色但没有行号列：复制时不能按详情色带的规则剥掉行首内容
	const plainRows = new Set<number>();
	let previousHadResponse = base?.previousHadResponse ?? false;

	// 警告只排在最前面一次：接着前缀往下排时它已经在里面了
	if (base === undefined && notice !== undefined && notice.length > 0) {
		lines.push(...noticeLines(notice, width));
		// 警告和第一轮对话之间留一行间距，避免系统消息贴住提示块
		if (turns.length > 0) lines.push(" ".repeat(width));
	}

	for (const turn of turns) {
		// 上一条回复和下一条提示之间留一行默认背景，避免提示块直接贴住回复
		if (previousHadResponse) lines.push(" ".repeat(width));

		const promptLines = promptBlock(turn.prompt, width);
		const start = lines.length;
		lines.push(...promptLines);
		for (let offset = 0; offset < promptLines.length; offset += 1) plainRows.add(start + offset);
		// 提示块自带的底部留白是提示底色，不是空行：回复紧贴上去会和输入框粘成一块。
		// 有回复时补一行默认背景，让提问与回答之间留出真正的间距。
		if (turn.response.length > 0) lines.push(" ".repeat(width));
		const responseStart = lines.length;
		let previousLine: TranscriptLine | undefined;
		for (const line of turn.response) {
			// 纯空白正文块整体跳过（ADR-15 真实会话）：模型在工具调用前常发 "\n\n" 垫片，
			// 渲染成空行会把批次间距打得忽宽忽窄。放在 previousLine 更新之前——跳过的块
			// 不参与相邻块的间距判定。
			if (typeof line !== "string" && line.kind === "markdown" && line.text.trim().length === 0) continue;
			if (previousLine !== undefined && needsBlockGap(previousLine, line)) {
				lines.push(" ".repeat(width));
			}
			previousLine = line;
			if (typeof line === "string") {
				lines.push(...wrappedLines(line, RESPONSE_INDENT, width, MESSAGE_TEXT_COLOR));
				continue;
			}
			if (line.kind === "markdown") {
				// 流式期间按纯文本折行：Markdown 解析与代码高亮的成本随文本长度增长，
				// 每个增量都重排整段会让长回复掉帧；块结束后只排一次
				lines.push(
					...(line.streaming === true ? streamingMarkdownLines(line, width) : renderMarkdown(line.text, width)),
				);
				continue;
			}
			if (line.kind === "thinkingBlock") {
				const blockStart = lines.length;
				const blockLines = thinkingBlockLines(line, width);
				lines.push(...blockLines);
				for (let offset = 0; offset < blockLines.length; offset += 1) plainRows.add(blockStart + offset);
				thinkingHeaders.push({ start: blockStart, end: lines.length, block: line });
				continue;
			}
			if (line.kind === "tool") {
				const toolStart = lines.length;
				lines.push(...toolLines(line, width));
				if (line.resultExpanded && line.result !== undefined) {
					const resultStart = lines.length;
					const resultLines = toolResultLines(line, width);
					lines.push(...resultLines);
					for (let offset = 0; offset < resultLines.length; offset += 1) {
						plainRows.add(resultStart + offset);
					}
				}
				// 有命令全文或有结果，就有可展开的东西；区间要等详情/结果行都排完再登记，
				// 展开后点正文里的任意一行都能收起
				if (hasExpandableDetail(line)) {
					toolHeaders.push({ start: toolStart, end: lines.length, tool: line });
				}
				continue;
			}
			if (line.kind === "toolGroup") {
				const groupStart = lines.length;
				const rendered = toolGroupLines(line, width);
				lines.push(...rendered.lines);
				// 单个成员直接按普通工具行渲染，没有组头可点
				if (line.members.length >= 2) groupHeaders.push({ start: groupStart, group: line });
				for (const member of rendered.memberSpans) {
					if (hasExpandableDetail(member.tool)) {
						toolHeaders.push({
							start: groupStart + member.start,
							end: groupStart + member.end,
							tool: member.tool,
						});
					}
				}
				continue;
			}
			if (line.kind === "todo") {
				const cardStart = lines.length;
				todoHeaders.push({ start: cardStart, card: line });
				lines.push(...todoCardLines(line, width));
				continue;
			}
			if (line.kind === "plan") {
				const cardStart = lines.length;
				planHeaders.push({ start: cardStart, plan: line });
				lines.push(planCardLine(line, width));
				continue;
			}
			if (line.kind === "subagentGroup") {
				const groupStart = lines.length;
				subagentHeaders.push({ start: groupStart, group: line });
				const rendered = subagentGroupLines(line, width, liveLines, groupStart);
				lines.push(...rendered.lines);
				// 失败行登记双击命中:展开/收起失败原因。failure.start 已经是绝对行号
				// （subagentGroupLines 内部用传入的 groupStart 算过），不能再加一次偏移。
				for (const failure of rendered.failureRows) {
					subagentFailureRows.push({
						start: failure.start,
						end: failure.end,
						group: line,
						callId: failure.callId,
					});
				}
				continue;
			}
			// 三种提示各有自己的标记与颜色：问题要显眼，中性说明只求看得见
			const marker = line.kind === "warning" ? "!" : line.kind === "info" ? "·" : ERROR_MARKER;
			const color = line.kind === "warning" ? NOTICE_COLOR : line.kind === "info" ? THINKING_COLOR : ERROR_COLOR;
			const text = line.kind === "warning" ? `${TRANSCRIPT.warningPrefix}${line.text}` : line.text;
			lines.push(...wrappedLines(text, `${RESPONSE_INDENT}${marker} `, width, color));
		}
		prompts.push({ start, height: promptLines.length, responseStart });
		previousHadResponse = turn.response.length > 0;
	}

	// 增量构建只处理新增行：历史行的元数据已经算过，每帧重扫整份历史会让长会话掉帧
	const baseLineCount = base?.view.lines.length ?? 0;
	const newLines = base === undefined ? lines : lines.slice(baseLineCount);
	const meta = buildLineMeta(newLines, plainRows, baseLineCount, base?.view.lineMetaState ?? EMPTY_LINE_META_STATE);
	const lineMeta =
		reuse === undefined
			? base === undefined
				? meta.meta
				: [...base.view.lineMeta, ...meta.meta]
			: (reuse.lineMeta as LineMeta[]);
	if (reuse !== undefined && base !== undefined) {
		lineMeta.length = baseLineCount;
		lineMeta.push(...meta.meta);
	}

	return {
		width,
		lines,
		lineMeta,
		lineMetaState: meta.state,
		prompts,
		thinkingHeaders,
		groupHeaders,
		toolHeaders,
		liveLines,
		todoHeaders,
		planHeaders,
		subagentHeaders,
		subagentFailureRows,
	};
}

/**
 * 从已排好的行里补出选区元数据。
 *
 * 工具详情的色带行带行号与缩进：行号是排版刻度，不算内容；同一逻辑行换行出来的续行在
 * 复制时也不该插换行。普通正文没有这些前缀，保持默认元数据。只认详情色带，避免把普通
 * 正文里的缩进当成行号。
 */
/**
 * 有底色但没有行号列的行（提示块、推理正文、工具结果预览）的内容起点。
 *
 * 提示块整行都是底色，正文固定缩进三列（` › ` 与 `   `）；推理正文与工具结果是
 * 「左侧留白 + 色带 + 一列内边距」，色带起点就是排版前缀的宽度。两种前缀都是排版，
 * 不属于内容，复制时跳过；行内真正的缩进（代码、列表）留在内容里。
 */
function plainRowContentStart(line: string): number {
	if (line.startsWith(PROMPT_BG)) return displayWidth(PROMPT_PREFIX);
	const band = bandStartColumn(line);
	return band === undefined ? bodyContentStart(line) : band + 1;
}

/**
 * 正文类行的内容起点：所有块都从正文缩进起排，再往里的空格属于内容。
 *
 * 推理标题、工具行、列表项、代码块都以两列缩进开头，那是排版；列表的第二层、
 * 代码自己的缩进则要保留，所以这里只剥掉公共的两列。
 */
function bodyContentStart(line: string): number {
	const plain = stripTerminalStyles(line);
	const lead = plain.length - plain.trimStart().length;
	return Math.min(lead, displayWidth(RESPONSE_INDENT));
}

/** 行首色带的起始显示列；整行从头就有底色、或前缀里夹着内容时返回 undefined。 */
function bandStartColumn(line: string): number | undefined {
	const at = line.indexOf(THEME.detailBg);
	if (at <= 0) return undefined;
	const lead = stripTerminalStyles(line.slice(0, at));
	// 前缀里只该有空格：出现别的字符说明这个底色不是行首色带
	if (lead.trim().length > 0) return undefined;
	return displayWidth(lead);
}

function buildLineMeta(
	lines: readonly string[],
	plainRows: ReadonlySet<number>,
	offset = 0,
	initial: LineMetaState = EMPTY_LINE_META_STATE,
): { readonly meta: LineMeta[]; readonly state: LineMetaState } {
	const meta: LineMeta[] = [];
	// 当前详情色带的内容起点；遇到非详情行、空行或新的行号时重置
	let contentStart = initial.contentStart;
	let inDetail = initial.inDetail;
	// diff 色带里带行号的上下文行与文件内容长得一样，靠前一条增删行/ hunk 头确认类型
	let diffBand = initial.diffBand;
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index] ?? "";
		// 提示块、推理正文与工具结果预览也用同一个底色，但它们没有行号列：
		// 一旦按「数字+两个空格」误判，复制时会把正文开头的数字吃掉并接错行
		if (plainRows.has(index + offset)) {
			meta.push({ contentStart: plainRowContentStart(line), softWrap: false });
			inDetail = false;
			contentStart = 0;
			diffBand = false;
			continue;
		}
		const detail =
			line.includes(THEME.detailBg) || line.includes(THEME.diffInsertBg) || line.includes(THEME.diffDeleteBg);
		if (!detail) {
			// 正文类行同样有排版缩进：高亮与复制都从两列之后开始，行首空白不该被选中
			meta.push({ contentStart: bodyContentStart(line), softWrap: false });
			inDetail = false;
			contentStart = 0;
			diffBand = false;
			continue;
		}
		const plain = stripTerminalStyles(line);
		if (plain.trim().length === 0) {
			// 色带上下留白与空行：不是一条可续行的内容
			meta.push(PLAIN_LINE_META);
			inDetail = false;
			contentStart = 0;
			diffBand = false;
			continue;
		}
		const trimmed = plain.trimStart();
		if (trimmed.startsWith("@@") || trimmed.startsWith("… (")) {
			// diff 的 hunk 头与省略行是独立行，不能接在上一条逻辑行后面
			contentStart = plain.length - trimmed.length;
			meta.push({ contentStart, softWrap: false });
			inDetail = false;
			diffBand = trimmed.startsWith("@@");
			continue;
		}
		const diff = /^(\s*\d+ )([-+] |  )/.exec(plain);
		if (diff !== null && (diffBand || line.includes(THEME.diffInsertBg) || line.includes(THEME.diffDeleteBg))) {
			contentStart = (diff[1] ?? "").length + 2;
			meta.push({ contentStart, softWrap: false });
			inDetail = true;
			diffBand = true;
			continue;
		}
		const file = /^(\s*\d+  )/.exec(plain);
		if (file !== null) {
			contentStart = (file[1] ?? "").length;
			meta.push({ contentStart, softWrap: false });
			inDetail = true;
			diffBand = false;
			continue;
		}
		if (inDetail) {
			// 详情色带里没有行号的行是上一条逻辑行的软换行续行
			meta.push({ contentStart, softWrap: true });
			continue;
		}
		meta.push(PLAIN_LINE_META);
	}
	return { meta, state: { contentStart, inDetail, diffBand } };
}

/**
 * 计划卡：只占一行，完整正文留给审批页。
 *
 * 标题取计划里第一个非空标题行；窄终端先丢掉右侧提示，再截断标题，标记本身始终保留。
 */
function planCardLine(plan: TranscriptPlan, width: number): string {
	const prefix = truncateToWidth(`${RESPONSE_INDENT}◇ Plan`, width);
	const title = planTitle(plan.text);
	const available = Math.max(0, width - displayWidth(prefix) - 2);
	const shownTitle = truncateToWidth(title, available);
	const hintFits = displayWidth(prefix) + 2 + displayWidth(shownTitle) + displayWidth(PLAN_CARD_HINT) <= width;

	let used = displayWidth(prefix);
	let line = `${PLAN_MARKER_COLOR}${prefix}${RESET}`;
	if (shownTitle.length > 0) {
		line += `${PLAN_TITLE_COLOR}  ${shownTitle}${RESET}`;
		used += 2 + displayWidth(shownTitle);
	}
	if (hintFits) {
		line += `${PLAN_HINT_COLOR}${PLAN_CARD_HINT}${RESET}`;
		used += displayWidth(PLAN_CARD_HINT);
	}
	return `${line}${" ".repeat(Math.max(0, width - used))}`;
}

/** 计划标题：第一个非空、非代码围栏的行，去掉 Markdown 标题记号。 */
function planTitle(text: string): string {
	for (const row of text.split("\n")) {
		const line = sanitizeLine(row).trim();
		if (line.length === 0 || line.startsWith("```")) continue;
		const heading = line.replace(/^#{1,6}\s+/, "").replace(/\s+#+$/, "");
		const chars = graphemes(heading);
		return chars.length > 72 ? `${chars.slice(0, 71).join("")}…` : heading;
	}
	return "";
}

/**
 * 推理区块的屏幕行。
 *
 * 标题带符号、不铺底色；正文上下各留一行色带，左侧与工具详情保持同样的留白。
 * 运行时收起只留最后五行屏幕行，结束后收起只留标题；Ctrl+E 或双击展开时给全文，
 * 展开状态在推理结束后保留。
 */
function thinkingBlockLines(block: TranscriptThinking, width: number): readonly string[] {
	const visible = block.expanded
		? [...block.body, ...(block.partial.length > 0 ? [block.partial] : [])].flatMap((text) =>
				thinkingBodyLines(text, width),
			)
		: block.running
			? thinkingTailLines(block, width)
			: [];
	const header = thinkingHeaderLines(block, width);
	if (visible.length === 0) return header;
	return [...header, thinkingBlankLine(width), ...visible, thinkingBlankLine(width)];
}

/** 收起的运行中推理只排版末尾附近的内容，避免每帧重排已经隐藏的长正文。 */
function thinkingTailLines(block: TranscriptThinking, width: number): readonly string[] {
	const remainingText = Math.max(64, width * (THINKING_TAIL_LINES + 2) * 4);
	let budget = remainingText;
	let remainingLines = THINKING_TAIL_LINES + 2;
	const tail: string[] = [];
	const takeTail = (text: string): void => {
		if (budget <= 0 || remainingLines <= 0) return;
		remainingLines -= 1;
		let start = Math.max(0, text.length - budget);
		if (start > 0 && /[\uDC00-\uDFFF]/u.test(text[start] ?? "")) start -= 1;
		tail.unshift(text.slice(start));
		budget -= text.length - start;
	};

	if (block.partial.length > 0) takeTail(block.partial);
	for (let index = block.body.length - 1; index >= 0 && budget > 0 && remainingLines > 0; index -= 1) {
		takeTail(block.body[index] ?? "");
	}
	return tail.flatMap((text) => thinkingBodyLines(text, width)).slice(-THINKING_TAIL_LINES);
}

/**
 * 推理区块的标题行。
 *
 * 收起时用 ✻；展开后用工具组头同款的 ◈，并提亮可点击的标签。耗时继续用弱化色。
 */
function thinkingHeaderLines(block: TranscriptThinking, width: number): readonly string[] {
	const header = thinkingHeaderText(block);
	if (!block.expanded) {
		return wrappedLines(header, THINKING_PREFIX, width, THINKING_COLOR);
	}

	const prefix = THINKING_EXPANDED_PREFIX;
	const label = header.startsWith("Thought for ") ? "Thought for " : header;
	const prefixWidth = displayWidth(prefix);
	const lines = wrapText(header, Math.max(0, width - prefixWidth));
	let offset = 0;

	return lines.map((line, index) => {
		const lead = index === 0 ? prefix : " ".repeat(prefixWidth);
		const activeWidth = Math.max(0, Math.min(line.length, label.length - offset));
		const active = line.slice(0, activeWidth);
		const rest = line.slice(activeWidth);
		offset += line.length;
		const visible = `${lead}${active}${rest}`;
		const padding = " ".repeat(Math.max(0, width - displayWidth(visible)));
		return `${THINKING_ACTIVE_COLOR}${lead}${active}${THINKING_COLOR}${rest}${RESET}${padding}`;
	});
}

/** 运行中的标题按起始时间现算；结束后的标题已经在关闭时定格。 */
function thinkingHeaderText(block: TranscriptThinking): string {
	if (!block.running || block.startedAt === undefined) return block.header;
	// 与工具行、子代理组头同一口径：0.1s 步进，不截断到整秒
	return `Thinking… ${formatDuration(Math.max(0, Date.now() - block.startedAt))}`;
}

/** 推理正文的一行：色带在标题符号右侧留出与工具详情相同的列数，带内留一列内边距。 */
function thinkingBodyLines(text: string, width: number): readonly string[] {
	const start = displayWidth(RESPONSE_INDENT) + DETAIL_BAND_LEFT;
	const lead = " ".repeat(start);
	const innerWidth = Math.max(0, width - start);
	// 窄终端上留白不能把正文挤没，宽度不够时让出来
	const insideWidth = innerWidth > MIN_DETAIL_CONTENT ? THINKING_PADDING : 0;
	const inside = " ".repeat(insideWidth);
	const contentWidth = Math.max(1, innerWidth - insideWidth - DETAIL_RIGHT_PADDING);

	// 模型输出可能带 CR 或 ANSI：终端执行回车/清屏后会把整条色带打乱；制表符先按
	// 可见列展开，不能和其余控制字符一起删掉，否则缩进整段丢失
	const cleaned = text
		.split("\n")
		.map((line) => stripLineControls(expandTabs(stripVTControlCharacters(line))))
		.join("\n");
	return wrapText(cleaned, contentWidth).map((line) => {
		const content = `${inside}${truncateToWidth(line, contentWidth)}`;
		const visible = truncateToWidth(content, innerWidth);
		const padding = " ".repeat(Math.max(0, innerWidth - displayWidth(visible)));
		return `${lead}${THINKING_BG}${THINKING_COLOR}${visible}${padding}${RESET}`;
	});
}

/** 推理正文的上下内边距：整条色带，不写内容。 */
function thinkingBlankLine(width: number): string {
	const start = displayWidth(RESPONSE_INDENT) + DETAIL_BAND_LEFT;
	return `${" ".repeat(start)}${THINKING_BG}${" ".repeat(Math.max(0, width - start))}${RESET}`;
}

/** 提示块上下各留一行背景，正文最多三行，放不下时在第三行末尾补省略号。 */
function promptBlock(prompt: string, width: number): readonly string[] {
	const prefixWidth = Math.min(PROMPT_PREFIX.length, width);
	const lines = wrapPrompt(prompt, Math.max(0, width - prefixWidth), PROMPT_MAX_LINES);
	const content = lines.map((line, index) => {
		const prefix = (index === 0 ? PROMPT_PREFIX : PROMPT_INDENT).slice(0, width);
		const usedPrefixWidth = displayWidth(prefix);
		const text = truncateToWidth(line, Math.max(0, width - usedPrefixWidth));
		const padding = " ".repeat(Math.max(0, width - usedPrefixWidth - displayWidth(text)));
		const styled = highlightImageMarkers(text, THEME.image, MESSAGE_TEXT_COLOR);
		return `${PROMPT_BG}${MESSAGE_TEXT_COLOR}${prefix}${styled}${padding}${RESET}`;
	});
	const empty = `${PROMPT_BG}${" ".repeat(width)}${RESET}`;
	return [empty, ...content, empty];
}

/**
 * 启动警告。
 *
 * 与模型回复共用正文缩进和颜色，第一行多一个 `!` 标记，续行与标记后的文字对齐；宽度不够时
 * 按字符换行，交给对话流统一滚动。
 */
function noticeLines(text: string, width: number): readonly string[] {
	return wrappedLines(text, `${RESPONSE_INDENT}! `, width, NOTICE_COLOR);
}

function wrapPrompt(text: string, limit: number, maxLines: number): readonly string[] {
	const lines = wrapText(text, limit);
	if (lines.length <= maxLines) return lines;

	const visible = lines.slice(0, maxLines);
	const ellipsis = "…";
	const last = graphemes(visible[maxLines - 1] ?? "");
	let used = displayWidth(last.join(""));

	while (last.length > 0 && used + 1 > limit) {
		const removed = last.pop();
		used -= characterWidth(removed ?? "");
	}
	visible[maxLines - 1] = last.join("") + ellipsis;
	return visible;
}
