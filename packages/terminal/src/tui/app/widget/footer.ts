import {
	inputMetrics,
	inputRowSpans as kitInputRowSpans,
	statusBarLine,
	type InputRowSpan,
	type StatusBarProps,
} from "../../kit/index.ts";
import type { ApprovalMode } from "../contract/config.ts";
import { formatCompactTokens, formatDuration } from "../contract/format.ts";
import { highlightImageMarkers } from "../image.ts";
import { queueMore } from "../copy/index.ts";
import { highlightPasteMarkers } from "../paste.ts";
import { characterWidth, displayWidth, graphemes, truncateToWidth } from "../../term/index.ts";
import { THEME } from "../render/theme.ts";

/**
 * 页脚输入框。
 *
 * 默认六行：空白间隔、运行时状态、上边框、输入行、下边框、常驻信息行；边框铺满整个终端宽度。
 * 模型面板打开时改用紧凑四行，去掉空白与状态行，让面板直接接在输入框上方。空白间隔把对话流
 * 和运行时状态行分开，正文滚到底时不会贴在一起。运行时状态在有任务时显示加载符号与状态文字，
 * 空闲时留空；常驻信息行左侧显示项目、分支、模型、思考强度、上下文与缓存命中率，行尾固定显示
 * 审批方式徽标（Shift+Tab 切换）。光标交给终端自己画，下方输入区只算出实际显示哪一段以及光标
 * 应落在第几列。边框与提示符随焦点切换颜色，正文保持默认颜色。
 */

interface InputLine {
	readonly prefix: string;
	readonly text: string;
	/** text 开头属于命令的字符数；0 表示这一行没有命令 */
	readonly commandEnd?: number;
}

interface InputView {
	/** 可见的提示符；窗口太窄时会被截断 */
	readonly prefix: string;
	/** 光标所在输入行的可见文字 */
	readonly text: string;
	/** 光标所在列，从 1 起算 */
	readonly column: number;
	/** 可见的输入行：显式换行与软换行都会增加行数 */
	readonly lines: readonly InputLine[];
	/** 光标在 lines 里的下标 */
	readonly row: number;
}

/** 输入框下方那一行常驻信息。 */
export interface FooterInfo {
	readonly project: string;
	/** 不是 git 仓库时为空，这一项整段不显示 */
	readonly branch: string | undefined;
	readonly model: string;
	readonly effort: string;
	/** 当前上下文的 token 数 */
	readonly contextUsed: number;
	/** 上下文上限；未声明时只显示已用量 */
	readonly contextWindow: number | undefined;
	/** 缓存读取占输入侧 token 的比例，0 到 1 */
	readonly cacheHitRate: number;
	/**
	 * 当前审批方式；在行尾固定显示 ASK/AUTO/YOLO 徽标。
	 *
	 * 省略时不画徽标——配置读不出来时没有可信的审批方式，显示任何一档都会误导。
	 */
	readonly approval?: ApprovalMode;
	/** 是否处于 Plan 模式；为 true 时在审批徽标左侧再画一个 PLAN */
	readonly planMode?: boolean;
}

/** 运行时状态：加载符号、状态文字、阶段计时、总计时与本轮 token 已用。 */
/**
 * 每帧重算的状态行数据。
 *
 * 可选字段一律带 `| undefined`：渲染端每次都会把「这一帧没有值」显式写成 undefined，
 * 而不是省掉字段。缺字段与显式空值在这里是同一件事，用 `?` 反而失真。
 */
interface RuntimeStatus {
	readonly symbol: string;
	readonly text: string;
	readonly phaseMs?: number | undefined;
	readonly elapsedMs?: number | undefined;
	/** 本轮请求累计消耗的 token 数；压缩请求不计入 */
	readonly tokens?: number | undefined;
	/** token 位置要显示的文字；有值时优先于 tokens，用于复制成功这类瞬时提示 */
	readonly tokenLabel?: string | undefined;
	/** 扫光位置，0 到 1；省略时静态显示。 */
	readonly sweep?: number | undefined;
	/**
	 * 色调。默认是「正在进行」的强调色 + 扫光；warning 表示遇挫但还在继续（重试），
	 * error 表示这一轮已经失败，notice 表示配置缺失这类阻断或提示——后两者都是静止状态。
	 */
	readonly tone?: "warning" | "error" | "notice" | undefined;
}

/**
 * 排队预览占几行。
 *
 * 行数只由这里决定：绘制、页脚高度与光标定位必须用同一个数，否则输入框会整体错位。
 * 空队列不占行。
 */
export function queueHeight(count: number): number {
	if (count <= 0) return 0;
	return Math.min(count, QUEUE_MAX_VISIBLE) + (count > QUEUE_MAX_VISIBLE ? 1 : 0);
}

/** 页脚布局开关；默认是完整的六行。 */
interface FooterLayout {
	/** 状态行上方是否留一行与对话流分隔；菜单面板已经承担分隔时可以关掉 */
	readonly leadingGap?: boolean;
	/** 是否显示运行时状态行 */
	readonly showStatus?: boolean;
	/** 输入光标位置；省略时停在末尾 */
	readonly cursor?: number;
	/** 输入开头命中的命令占多少字符（含斜杠）；0 或不给表示没有命中 */
	readonly commandLength?: number;
	/** 排队中的消息，按发送顺序；只在完整页脚里显示 */
	readonly queued?: readonly string[];
}

/** 输入框下方常驻信息行的颜色。 */
const INFO_COLOR = THEME.textSecondary;

/** 排队消息的缩进与标记，列宽与输入提示符一致，两处文字对齐。 */
const QUEUE_PREFIX = " ↳ ";
/** 排队预览最多显示几条；更多的收成一行计数。 */
export const QUEUE_MAX_VISIBLE = 3;
/** 排队消息比正文弱一档：它还没发生，不该跟正在进行的对话抢注意力。 */
const QUEUE_COLOR = THEME.textSubtle;
/** 获得焦点时边框与提示符使用强调色。 */
const FOCUS_COLOR = THEME.accent;
/** 失去焦点时边框与提示符使用边框色。 */
const BLUR_COLOR = THEME.border;
const RESET = THEME.reset;

/** 常驻信息行每一项前的图标。 */
const PROJECT_ICON = "📁";
const BRANCH_ICON = "🌿";
const MODEL_ICON = "🤖";
const EFFORT_ICON = "🧠";
const CONTEXT_ICON = "📊";
const CACHE_ICON = "⚡";

/**
 * 输入行的可见部分与光标列。
 *
 * 支持两种换行：显式换行（Alt+Enter、多行粘贴）按 \n 分行；单个逻辑行超过可用宽度时按
 * 显示宽度软换行，字素簇（宽字符、组合序列、emoji）不会被切到两行。最多同时显示
 * MAX_VISIBLE_INPUT_LINES 行，围绕光标滚动，光标始终落在可见区内。
 */
export function inputView(input: string, width: number, cursor = input.length, commandLength = 0): InputView {
	// 折行与光标列由组件库算：同一套规则还负责上下键的可视行，两处各写一遍迟早对不上
	const metrics = inputMetrics(input, cursor, width, { commandLength });
	return {
		prefix: metrics.prefix,
		text: metrics.text,
		column: metrics.column,
		lines: metrics.lines.map((line) => ({ prefix: line.prefix, text: line.text, commandEnd: line.commandEnd })),
		row: metrics.row,
	};
}

/**
 * 把输入拆成可视行。
 *
 * 与 `inputView` 共用同一套折行规则，但返回整段输入——上下键移动要知道全局行号，
 * 不能只看光标周围那几行。
 */
export function inputRowSpans(input: string, width: number): readonly InputRowSpan[] {
	return kitInputRowSpans(input, width);
}

/**
 * 上下键沿可视行移动光标。
 *
 * 软换行也算一行：长段落能一行一行地走，不会跳过整段、也不会被当成「单行」去翻历史。
 * 目标列落在宽字符中间时停在它前面——宁可左一列，也不要为了对齐跳过整个字。
 * 已经在首行/末行时返回 undefined，由调用方决定是否退回翻历史。
 */
export function moveInputRow(input: string, cursor: number, delta: -1 | 1, width: number): number | undefined {
	const rows = inputRowSpans(input, width);
	// 光标正好落在软换行边界时归下一行：与 inputView 的 segmentAt 一致，
	// 屏幕上它画在下一行行首，上下键也要从那一行算起
	let index = 0;
	for (let row = 0; row < rows.length; row += 1) {
		if ((rows[row] as InputRowSpan).start <= cursor) index = row;
		else break;
	}
	const target = index + delta;
	if (target < 0 || target >= rows.length) return undefined;

	const current = rows[index] as InputRowSpan;
	const column = displayWidth(input.slice(current.start, cursor));
	const row = rows[target] as InputRowSpan;
	let offset = row.start;
	let used = 0;
	for (const grapheme of graphemes(input.slice(row.start, row.end))) {
		const widthOf = characterWidth(grapheme);
		if (used + widthOf > column) break;
		used += widthOf;
		offset += grapheme.length;
	}
	// 软换行的行尾与下一行行首是同一个偏移，渲染会把光标画到下一行：直接停在行尾，
	// 上移看起来就只是「左移了一格」。退一个字，光标才真正落在目标行里。
	const next = rows[target + 1];
	if (offset === row.end && offset > row.start && next !== undefined && next.start === row.end) {
		const last = graphemes(input.slice(row.start, row.end)).at(-1);
		if (last !== undefined) offset -= last.length;
	}
	return Math.min(offset, row.end);
}

export function renderFooter(
	width: number,
	input: string,
	focused: boolean,
	status?: RuntimeStatus,
	info?: FooterInfo,
	layout?: FooterLayout,
): readonly string[] {
	const columns = Math.max(0, width);
	const view = inputView(input, columns, layout?.cursor, layout?.commandLength ?? 0);
	const lines: string[] = [];
	const frame = frameColor(focused, info?.approval);
	if (layout?.leadingGap !== false) lines.push("");
	if (layout?.showStatus !== false) {
		lines.push(statusLine(columns, status));
		// 排队预览与状态行描述的是同一件事：正在跑的回合之外还等着什么。紧凑页脚把这块
		// 面积让给菜单面板，两者一起收起。
		lines.push(...queueLines(columns, layout?.queued ?? []));
	}
	lines.push(colored(horizontal(columns), frame));
	for (const line of view.lines) {
		lines.push(colored(line.prefix, frame) + commandText(line, frame));
	}
	lines.push(colored(horizontal(columns), frame), infoLine(columns, info));
	return lines;
}

/**
 * 排队消息的预览行。
 *
 * 每条只占一行：排队的是「稍后要说什么」，看个开头就够；整条铺开会把正在跑的回复挤出视野。
 * 超出上限的部分收成一行计数，让人知道还有几条在后面。
 */
function queueLines(width: number, queued: readonly string[]): readonly string[] {
	if (queued.length === 0) return [];

	const prefixWidth = displayWidth(QUEUE_PREFIX);
	const textWidth = Math.max(1, width - prefixWidth - 1);
	const lines = queued
		.slice(0, QUEUE_MAX_VISIBLE)
		.map((text) => `${QUEUE_COLOR}${QUEUE_PREFIX}${truncateToWidth(oneLine(text), textWidth)}${RESET}`);
	const hidden = queued.length - QUEUE_MAX_VISIBLE;
	if (hidden > 0) {
		lines.push(`${QUEUE_COLOR}${" ".repeat(prefixWidth)}${queueMore(hidden)}${RESET}`);
	}
	return lines;
}

/** 换行与制表符会把一条消息撑成多行，预览里一律压成单行。 */
function oneLine(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

/**
 * 输入行正文：命中的命令用强调色，参数与其它文字保持正文色。
 *
 * 只换颜色不改宽度，光标列与横向滚动的计算不受影响。
 */
function commandText(line: InputLine, color: string): string {
	const end = line.commandEnd ?? 0;
	if (end <= 0) return decorated(line.text);
	const chars = graphemes(line.text);
	if (end >= chars.length) return `${color}${line.text}${RESET}`;
	const rest = chars.slice(end).join("");
	return `${color}${chars.slice(0, end).join("")}${RESET}${decorated(rest)}`;
}

/** 输入行里的两类标记各自上色：图片用引用蓝，折叠粘贴用强调色，都只换色不改宽度。 */
function decorated(text: string): string {
	return highlightPasteMarkers(highlightImageMarkers(text, THEME.image, RESET), THEME.accent, RESET);
}

/** 审批徽标的配色按风险分级：逐次询问是安全默认，自动审查是「谨慎放行」，完全放行最刺眼。 */
const APPROVAL_BADGE_COLORS: Readonly<Record<ApprovalMode, string>> = {
	ask: THEME.accent,
	auto: THEME.warning,
	yolo: THEME.error,
};
/** Plan 是工作方式而不是权限档位，用路径蓝与审批徽标分开。 */
const PLAN_BADGE_COLOR = THEME.path;
/** 两个徽标之间的距离；与正文到徽标的间隔一致。 */
const BADGE_INNER_GAP = 2;

/** 信息行右端的呼吸空间：状态行与对话流都避开最右两列（一列间距加一列滚动条），徽标右缘对齐同一条竖线。 */
const INFO_RIGHT_MARGIN = 2;
/** 正文与徽标之间至少留出的间隔列数。 */
const BADGE_GAP = 2;

/**
 * 常驻信息行。
 *
 * 按「项目·分支 | 模型·思考强度 | 上下文 | 缓存命中率」分组；分支不存在时整段省略，
 * 上下文上限未声明时只写已用量。整行统一用暗色，避免和对话流正文抢注意力；审批徽标按模式
 * 着色，固定钉在行尾，一眼可辨当前放行到哪一档（Shift+Tab 切换）。Plan 模式在审批徽标
 * 左侧多一个 PLAN，两者正交：PLAN 管能不能改，审批管改的时候问不问。
 *
 * 终端变窄时按优先级整项舍弃正文，而不是从右侧硬截：先丢项目位置，再丢模型，再丢缓存，
 * 最后只保留上下文并截断。上下文是判断何时该压缩的依据，缓存命中率反映本回合的 token
 * 复用，这两项比位置与模型更值得留在窄屏上。徽标占的列从正文可用宽度里先扣掉，正文
 * 放不下时整段让位给徽标；Plan 模式下窄到放不下两个徽标时先舍审批徽标，PLAN 是当前
 * 工作方式的唯一提示，不能先消失。
 */
function infoLine(width: number, info: FooterInfo | undefined): string {
	if (info === undefined) return "";

	const badges: { readonly text: string; readonly color: string }[] = [];
	if (info.planMode === true) badges.push({ text: "PLAN", color: PLAN_BADGE_COLOR });
	if (info.approval !== undefined) {
		badges.push({ text: info.approval.toUpperCase(), color: APPROVAL_BADGE_COLORS[info.approval] });
	}

	// 窄屏先舍审批徽标，再舍 PLAN；两个都放不下时整段让位给正文
	let shown = badges;
	let badgeWidth = badgesWidth(shown);
	if (badgeWidth > 0 && width - INFO_RIGHT_MARGIN - badgeWidth < 1 && shown.length > 1) {
		shown = shown.filter((badge) => badge.text === "PLAN");
		badgeWidth = badgesWidth(shown);
	}
	const showBadges = shown.length > 0 && width - INFO_RIGHT_MARGIN - badgeWidth >= 1;
	if (!showBadges) {
		shown = [];
		badgeWidth = 0;
	}
	const badgeColumn = width - INFO_RIGHT_MARGIN - badgeWidth;
	const available = Math.max(0, width - INFO_RIGHT_MARGIN - (showBadges ? badgeWidth + BADGE_GAP : 0));

	const location =
		info.branch === undefined
			? `${PROJECT_ICON} ${info.project}`
			: `${PROJECT_ICON} ${info.project} · ${BRANCH_ICON} ${info.branch}`;
	const model = `${MODEL_ICON} ${info.model} · ${EFFORT_ICON} ${info.effort}`;
	const context = `${CONTEXT_ICON} ${formatContext(info.contextUsed, info.contextWindow)}`;
	const cache = `${CACHE_ICON} ${Math.round(info.cacheHitRate * 100)}%`;

	let text = "";
	for (const group of [[location, model, context, cache], [model, context, cache], [context, cache], [context]]) {
		const candidate = group.join(" | ");
		if (displayWidth(candidate) <= available) {
			text = candidate;
			break;
		}
	}
	if (text === "" && available > 0) text = truncateToWidth(context, available).trimEnd();

	const body = text === "" ? "" : `${INFO_COLOR}${text}${RESET}`;
	if (!showBadges) return body;

	const gap = Math.max(1, badgeColumn - displayWidth(text));
	const styled = shown.map((badge) => `${badge.color}${badge.text}${RESET}`).join(" ".repeat(BADGE_INNER_GAP));
	return `${body}${" ".repeat(gap)}${styled}`;
}

/** 徽标组的总显示宽度，含组内间隔。 */
function badgesWidth(badges: readonly { readonly text: string }[]): number {
	return (
		badges.reduce((sum, badge) => sum + displayWidth(badge.text), 0) + Math.max(0, badges.length - 1) * BADGE_INNER_GAP
	);
}

/**
 * 运行时状态行。
 *
 * 时间与用量的格式属于本产品的口径，先在这里格式化好再交给组件：组件只负责摆位与配色，
 * 不猜「1.2k 还是 1200」。
 */
function statusLine(width: number, status: RuntimeStatus | undefined): string {
	if (status === undefined) return "";
	// 先取一次：meteringOf 连调两次时第二次不再被收窄，会把 string | undefined 塞进 tokens
	const tokens = meteringOf(status);
	const props: StatusBarProps = {
		text: status.text,
		...(status.symbol === undefined ? {} : { symbol: status.symbol }),
		...(status.phaseMs === undefined ? {} : { phase: formatDuration(status.phaseMs) }),
		...(status.elapsedMs === undefined ? {} : { elapsed: formatDuration(status.elapsedMs) }),
		...(tokens === undefined ? {} : { tokens }),
		...(status.tone === undefined ? {} : { tone: status.tone }),
		...(status.sweep === undefined ? {} : { sweep: status.sweep }),
	};
	return statusBarLine(props, width, THEME);
}

/** 行尾的用量文字：复制提示优先于本轮 token 数。 */
function meteringOf(status: RuntimeStatus): string | undefined {
	if (status.tokenLabel !== undefined) return status.tokenLabel;
	return status.tokens === undefined ? undefined : `⇣${formatCompactTokens(status.tokens)}`;
}

function formatContext(used: number, total: number | undefined): string {
	const current = formatCompactTokens(used);
	return total === undefined ? current : `${current} / ${formatCompactTokens(total)}`;
}

/** 按显示宽度截断，宽字符与 emoji 不会被切成半个。 */
function colored(text: string, color: string): string {
	return `${color}${text}${RESET}`;
}

/**
 * 输入框边框与命令名颜色：聚焦时随审批模式变化。
 *
 * ask 用强调青、auto 用琥珀、yolo 用红色：输入框本身就能提示当前放行到哪一档，
 * 不必只盯着右下角的徽标。失焦时统一用边框色，不参与风险提示。
 */
function frameColor(focused: boolean, approval: ApprovalMode | undefined): string {
	if (!focused) return BLUR_COLOR;
	if (approval === "auto") return THEME.warning;
	if (approval === "yolo") return THEME.error;
	return FOCUS_COLOR;
}

function horizontal(width: number): string {
	return "─".repeat(width);
}
