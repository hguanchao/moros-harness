import { displayWidth, fitToWidth, truncateToWidth, wrapWords, type Theme } from "../term/index.ts";
import { fitLine } from "./fit.ts";

/**
 * 整屏页。
 *
 * 标题、若干分节、脚注，底部可带一条固定动作条。正文按可用高度滚动，动作条始终停在底部；
 * 高度分配只在这里算一次，各页不会各自偏移。
 *
 * 排版先产出「带色调的片段行」，再由主题染成字符串：测量只需要行数，不必为了算高度而先
 * 决定配色。
 */

/** 一条条目。 */
export interface PageEntry {
	/** 左列名称：命令名、技能名、server 名 */
	readonly name: string;
	readonly description: string;
	/** 另起一行的小字；用来放位置这类不该挤进说明列的信息 */
	readonly note?: string;
	/** 当前选中的条目；只有带操作的可选清单会设置 */
	readonly selected?: boolean;
}

/** 一个分节。 */
export interface PageSection {
	readonly title: string;
	readonly entries: readonly PageEntry[];
	/** 一条都没有时顶替条目显示的一句话 */
	readonly empty?: string;
	/**
	 * 条目排布。
	 *
	 * `table` 按名称列对齐，适合命令清单；`card` 让名称独占一行、说明缩进在下，适合名称长
	 * 且说明也长的清单——表格布局里名称一旦被截断就认不出来了。
	 */
	readonly layout?: "table" | "card";
}

/** 底部动作条的一项：按键与说明。 */
export type PageAction = readonly [key: string, label: string];

/** 页面内容。 */
export interface PageProps {
	readonly title: string;
	/** 标题下的一行提示，如 MCP 页的重连结果 */
	readonly status?: { readonly text: string; readonly tone?: "notice" | "warning" | "error" };
	readonly sections: readonly PageSection[];
	readonly footnotes?: readonly string[];
	readonly actions?: readonly PageAction[];
	/** 正文滚动位置；动作条固定，不随它移动 */
	readonly scrollTop?: number;
}

/** 片段色调；与主题取值的映射集中在一处。 */
type Tone = "title" | "section" | "name" | "selected" | "description" | "note" | "notice" | "error" | "warning";

/** 一段同样式的文字。 */
type Piece = readonly [text: string, tone: Tone | undefined];

/** 一行由若干片段拼成。 */
type Pieces = readonly Piece[];

/** 名称列最宽到这里为止，再长就截断，免得说明被挤得读不了。 */
const NAME_COLUMN_MAX = 14;
/** 名称右侧至少留这么多列给说明，否则说明另起一行。 */
const MIN_INLINE_DESCRIPTION = 8;
/** 名称列前缩进。 */
const ENTRY_INDENT = "  ";
/** 名称与说明之间留两列。 */
const ENTRY_GAP = "  ";
/** 卡片式：名称缩进、说明再深两列，层级一眼看得出来。 */
const CARD_INDENT = "  ";
const CARD_BODY_INDENT = "    ";
/** 卡片式名称与行尾来源之间至少留出的间隔列数。 */
const NOTE_GAP = 2;
/** 动作条固定两行：分隔线加按键提示。 */
const ACTION_HEIGHT = 2;

/** 页面的自然高度：正文行数加动作条。 */
export function pageHeight(props: PageProps, width: number): number {
	const content = pageContent(props, width).length;
	return content + (props.actions === undefined || props.actions.length === 0 ? 0 : ACTION_HEIGHT);
}

/**
 * 从容器 props 里取出页面内容。
 *
 * 形状不对的字段一律忽略而不是抛错：页面是展示层，缺一个 `description` 不该让整帧崩掉，
 * 只是那一行少几个字。
 */
export function pagePropsOf(props: Readonly<Record<string, unknown>>): PageProps {
	const title = typeof props["title"] === "string" ? props["title"] : "";
	const sections = sectionsOf(props["sections"]);
	const footnotes = stringArrayOf(props["footnotes"]);
	const actions = actionsOf(props["actions"]);
	const status = statusOf(props["status"]);
	const scrollTop = props["scrollTop"];
	return {
		title,
		sections,
		...(footnotes.length === 0 ? {} : { footnotes }),
		...(actions.length === 0 ? {} : { actions }),
		...(status === undefined ? {} : { status }),
		...(typeof scrollTop === "number" && Number.isFinite(scrollTop)
			? { scrollTop: Math.max(0, Math.floor(scrollTop)) }
			: {}),
	};
}

function sectionsOf(value: unknown): readonly PageSection[] {
	if (!Array.isArray(value)) return [];
	const sections: PageSection[] = [];
	for (const entry of value) {
		if (typeof entry !== "object" || entry === null) continue;
		const record = entry as Record<string, unknown>;
		const title = typeof record["title"] === "string" ? record["title"] : "";
		sections.push({
			title,
			entries: entriesOf(record["entries"]),
			...(typeof record["empty"] === "string" ? { empty: record["empty"] } : {}),
			...(record["layout"] === "card" ? { layout: "card" as const } : {}),
		});
	}
	return sections;
}

function entriesOf(value: unknown): readonly PageEntry[] {
	if (!Array.isArray(value)) return [];
	const entries: PageEntry[] = [];
	for (const item of value) {
		if (typeof item !== "object" || item === null) continue;
		const record = item as Record<string, unknown>;
		const name = record["name"];
		if (typeof name !== "string") continue;
		entries.push({
			name,
			description: typeof record["description"] === "string" ? record["description"] : "",
			...(typeof record["note"] === "string" ? { note: record["note"] } : {}),
			...(record["selected"] === true ? { selected: true } : {}),
		});
	}
	return entries;
}

function actionsOf(value: unknown): readonly PageAction[] {
	if (!Array.isArray(value)) return [];
	const actions: PageAction[] = [];
	for (const item of value) {
		if (!Array.isArray(item)) continue;
		const key = item[0];
		const label = item[1];
		if (typeof key !== "string" || typeof label !== "string") continue;
		actions.push([key, label]);
	}
	return actions;
}

function statusOf(value: unknown): PageProps["status"] {
	if (typeof value !== "object" || value === null) return undefined;
	const record = value as Record<string, unknown>;
	const text = record["text"];
	if (typeof text !== "string") return undefined;
	const tone = record["tone"];
	return {
		text,
		...(tone === "notice" || tone === "warning" || tone === "error" ? { tone } : {}),
	};
}

function stringArrayOf(value: unknown): readonly string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((item): item is string => typeof item === "string");
}

/**
 * 画一页。
 *
 * @param props 页面内容
 * @param width 可用列数
 * @param height 可用行数；正文超出时按 `scrollTop` 滚动，动作条固定在底部
 * @param theme 主题取值
 */
export function pageLines(props: PageProps, width: number, height: number, theme: Theme): readonly string[] {
	const columns = Math.max(0, width);
	const rows = Math.max(0, height);
	const content = pageContent(props, width);
	const actions = props.actions ?? [];
	const actionsHeight = actions.length === 0 ? 0 : ACTION_HEIGHT;
	const viewport = Math.max(0, rows - actionsHeight);
	const maxScroll = Math.max(0, content.length - viewport);
	const top = Math.min(Math.max(0, props.scrollTop ?? 0), maxScroll);

	const painted: string[] = [];
	for (let row = 0; row < viewport; row += 1) {
		const line = content[top + row];
		painted.push(fitLine(line === undefined ? "" : renderPieces(line, theme), columns));
	}
	if (actionsHeight > 0) {
		painted.push(`${theme.border}${"─".repeat(columns)}${theme.reset}`);
		painted.push(actionRow(actions, columns, theme));
	}
	while (painted.length < rows) painted.push(" ".repeat(columns));
	return painted.slice(0, rows);
}

/** 正文行（不含动作条）；测量与绘制共用。 */
export function pageContent(props: PageProps, width: number): readonly Pieces[] {
	const columns = Math.max(0, width);
	const lines: Pieces[] = [[[fitToWidth(props.title, columns), "title"]]];
	if (props.status !== undefined) {
		lines.push([[fitToWidth(props.status.text, columns), props.status.tone ?? "description"]]);
	}
	for (const section of props.sections) lines.push(...sectionLines(section, columns));
	if (props.footnotes !== undefined && props.footnotes.length > 0) {
		lines.push([]);
		for (const footnote of props.footnotes) {
			for (const line of wrapWords(footnote, columns)) lines.push([[line, "description"]]);
		}
	}
	return lines;
}

/**
 * 正文行，已染色但未补白。
 *
 * 给「自己管理视口」的调用方用：它们只需要一段可滚动的行，由自己决定露出哪几行、要不要
 * 动作条。`pageLines` 则连视口与动作条一起接管。
 */
export function pageContentLines(props: PageProps, width: number, theme: Theme): readonly string[] {
	return pageContent(props, width).map((line) => renderPieces(line, theme));
}

function sectionLines(section: PageSection, width: number): readonly Pieces[] {
	// 分节前空一行：标题与上一节之间要有呼吸，否则整页连成一片
	const lines: Pieces[] = [[], [[fitToWidth(section.title, width), "section"]]];
	if (section.entries.length === 0) {
		if (section.empty !== undefined) {
			for (const line of wrapWords(section.empty, width)) lines.push([[line, "description"]]);
		}
		return lines;
	}

	const widest = Math.max(1, ...section.entries.map((entry) => displayWidth(entry.name)));
	const nameWidth = Math.min(
		NAME_COLUMN_MAX,
		widest,
		// 名称列连同两侧间距必须留在终端宽度内，否则整行会被撑出去
		Math.max(1, width - displayWidth(ENTRY_INDENT) - displayWidth(ENTRY_GAP)),
	);
	if (section.layout === "card") {
		// 每条占三四行，不隔一行就会连成一片，看不出上一条到哪结束
		section.entries.forEach((entry, index) => {
			if (index > 0) lines.push([]);
			lines.push(...cardLines(entry, width));
		});
		return lines;
	}
	for (const entry of section.entries) lines.push(...entryLines(entry, nameWidth, width));
	return lines;
}

/**
 * 卡片式条目：名称独占一行，说明缩进在下。
 *
 * 名称不设列宽上限，只在放不下时按可用宽度截断——它是标识符，能完整显示就别动它。来源
 * （note）右对齐钉在名称行行尾；窄到放不下「名称 + 间隔 + 来源」时整段折到说明缩进里。
 * 说明的第一句用名称色：一句话说清「这是什么」，后续的触发条件之类的长文退到说明色，
 * 扫读时先看到每个条目是什么。
 */
function cardLines(entry: PageEntry, width: number): readonly Pieces[] {
	const selected = entry.selected === true;
	const indent = (selected ? "› " : CARD_INDENT).slice(0, width);
	const bodyIndent = CARD_BODY_INDENT.slice(0, width);
	const bodyWidth = Math.max(1, width - displayWidth(bodyIndent));
	const nameWidth = Math.max(1, width - displayWidth(indent));
	const nameTone: Tone = selected ? "selected" : "name";

	const note = entry.note ?? "";
	const inlineNote = note.length > 0 && displayWidth(entry.name) + NOTE_GAP + displayWidth(note) <= nameWidth;
	const lines: Pieces[] = [];
	if (note.length === 0) {
		lines.push([
			[indent, undefined],
			[fitToWidth(entry.name, nameWidth), nameTone],
		]);
	} else if (inlineNote) {
		const gap = Math.max(1, nameWidth - displayWidth(entry.name) - displayWidth(note));
		lines.push([
			[indent, undefined],
			[fitToWidth(entry.name, nameWidth - displayWidth(note) - NOTE_GAP), nameTone],
			[" ".repeat(gap), undefined],
			[fitToWidth(note, nameWidth), "note"],
		]);
	} else {
		lines.push([
			[indent, undefined],
			[fitToWidth(entry.name, nameWidth), nameTone],
		]);
		for (const line of wrapWords(note, bodyWidth))
			lines.push([
				[bodyIndent, undefined],
				[line, "note"],
			]);
	}

	if (entry.description.length > 0) {
		const [lead, ...rest] = splitFirstSentence(entry.description);
		for (const line of wrapWords(lead, bodyWidth))
			lines.push([
				[bodyIndent, undefined],
				[line, nameTone],
			]);
		const remainder = rest.join(" ");
		if (remainder.length > 0) {
			for (const line of wrapWords(remainder, bodyWidth))
				lines.push([
					[bodyIndent, undefined],
					[line, "description"],
				]);
		}
	}
	return lines;
}

/** 把第一句与其余部分分开：以 `. `（或行尾的 `.`）为界；中文句号后没有空格，同样断句。 */
function splitFirstSentence(text: string): readonly [string, string[]] {
	const match = /^([^.!？?。]*[.!？?。])(.*)$/.exec(text);
	if (match === null) return [text, []];
	const lead = match[1] ?? text;
	const rest = (match[2] ?? "").trim();
	return [lead, rest.length === 0 ? [] : [rest]];
}

/**
 * 一条条目：名称占固定列宽，说明在右侧折行，续行与说明起点对齐。
 *
 * 超长名称不按列宽截断——名称是标识符，截成 `my-company-int…` 就认不出来了。让它溢出列宽、
 * 说明另起一行，只在连整行都放不下时才截断。
 */
function entryLines(entry: PageEntry, nameWidth: number, width: number): readonly Pieces[] {
	const available = Math.max(1, width - displayWidth(ENTRY_INDENT) - displayWidth(ENTRY_GAP));
	const label =
		displayWidth(entry.name) > nameWidth ? fitToWidth(entry.name, available) : padEnd(entry.name, nameWidth);
	const selected = entry.selected === true;
	const indentText = selected ? "› " : ENTRY_INDENT;
	const tone: Tone = selected ? "selected" : "name";
	const head = `${indentText}${label}${ENTRY_GAP}`;
	const headWidth = displayWidth(head);

	const noteLines: Pieces[] = [];
	if (entry.note !== undefined) {
		for (const line of wrapWords(entry.note, Math.max(1, width - displayWidth(ENTRY_INDENT)))) {
			noteLines.push([
				[ENTRY_INDENT, undefined],
				[line, "note"],
			]);
		}
	}

	if (width - headWidth < MIN_INLINE_DESCRIPTION) {
		return [
			[[head, tone]],
			...wrapWords(entry.description, Math.max(1, width - displayWidth(ENTRY_INDENT))).map((line): Pieces => [
				[ENTRY_INDENT, undefined],
				[line, "description"],
			]),
			...noteLines,
		];
	}

	const indent = " ".repeat(headWidth);
	return [
		...wrapWords(entry.description, width - headWidth).map((line, index): Pieces =>
			index === 0
				? [
						[head, tone],
						[line, "description"],
					]
				: [
						[indent, undefined],
						[line, "description"],
					],
		),
		...noteLines,
	];
}

/** 底部动作条：一条分隔线加一行「按键 说明」。 */
function actionRow(actions: readonly PageAction[], width: number, theme: Theme): string {
	const plain = actions.map(([key, label]) => `${key} ${label}`).join("  ");
	// 放不下时退回纯文本截断：带色的版本每段都有转义序列，宽度只能另算一遍
	if (displayWidth(plain) > width) return fitLine(truncateToWidth(plain, width), width);
	const styled = actions
		.map(([key, label]) => `${theme.textSubtle}${key}${theme.reset} ${theme.textSecondary}${label}${theme.reset}`)
		.join("  ");
	return fitLine(styled, width);
}

/** 按色调把片段染成字符串。 */
function renderPieces(pieces: Pieces, theme: Theme): string {
	let out = "";
	for (const [text, tone] of pieces) {
		if (text.length === 0) continue;
		out += tone === undefined ? text : `${colorOf(tone, theme)}${text}${theme.reset}`;
	}
	return out;
}

function colorOf(tone: Tone, theme: Theme): string {
	switch (tone) {
		case "title":
		case "selected":
			return theme.accent;
		case "section":
		case "note":
			return theme.textSubtle;
		case "name":
			return theme.textPrimary;
		case "description":
		case "notice":
			return theme.textSecondary;
		case "error":
			return theme.error;
		case "warning":
			return theme.warning;
	}
}

/** 按显示宽度补空格；超出时截断。 */
function padEnd(text: string, width: number): string {
	const visible = truncateToWidth(text, width);
	return visible + " ".repeat(Math.max(0, width - displayWidth(visible)));
}
