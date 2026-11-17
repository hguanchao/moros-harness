import { displayWidth, graphemes, truncateToWidth, type Theme } from "#src/tui/term/index.ts";
import { swept } from "#src/tui/kit/sweep.ts";

/**
 * 状态行。
 *
 * 左边是「符号 + 正在做什么 + 阶段耗时」，右边靠行尾对齐总耗时与用量。数字先由调用方格式
 * 化成字符串再传进来：怎么显示时间与 token 属于产品口径，组件只负责摆位与配色。
 */

/** 状态色调。`running` 用强调色（可带扫光），其余为静止色。 */
export type StatusTone = "running" | "warning" | "error" | "notice";

/** 状态行内容；时间与用量都是已格式化好的字符串。 */
export interface StatusBarProps {
	/** 行首符号：转圈帧、`!` 或 `·` */
	readonly symbol?: string;
	/** 正在做什么 */
	readonly text: string;
	/** 当前阶段耗时，如 `0.8s` */
	readonly phase?: string;
	/** 本轮总耗时 */
	readonly elapsed?: string;
	/** 本轮用量，如 `⇣1.2k` */
	readonly tokens?: string;
	readonly tone?: StatusTone;
	/** 扫光相位 0–1；只在 `running` 时生效 */
	readonly sweep?: number;
}

/**
 * 画一行状态。
 *
 * @param props 状态内容
 * @param width 可用列数；内部再让出最右两列（一列间距加一列滚动条），与对话流对齐
 * @param theme 取强调色、警告、失败与弱化色
 */
export function statusBarLine(props: StatusBarProps, width: number, theme: Theme): string {
	const columns = Math.max(0, width);
	const statusWidth = Math.max(0, columns - 2);
	const activity = ` ${props.symbol ?? ""} ${props.text}`;
	const left = props.phase === undefined || props.phase.length === 0 ? activity : `${activity}  ${props.phase}`;

	const right = [props.elapsed, props.tokens]
		.filter((part): part is string => part !== undefined && part.length > 0)
		.join("  ");

	let line: string;
	if (right.length === 0) {
		line = truncateToWidth(left, statusWidth);
	} else if (displayWidth(left) + displayWidth(right) + 2 <= statusWidth) {
		line = left + " ".repeat(statusWidth - displayWidth(left) - displayWidth(right)) + right;
	} else {
		line = truncateToWidth(`${left}  ${right}`, statusWidth);
	}

	// 扫光只覆盖活动描述；阶段计时、总计时与用量保持静态弱化色
	const activityWidth = Math.min(displayWidth(activity), displayWidth(line));
	const head = cutByWidth(line, activityWidth);
	const rest = line.slice(head.length);
	const toneColor =
		props.tone === "error" ? theme.error : props.tone === "warning" ? theme.warning : theme.textSecondary;
	const headText =
		props.tone !== undefined && props.tone !== "running"
			? `${toneColor}${head}${theme.reset}`
			: props.sweep === undefined
				? `${theme.accent}${head}${theme.reset}`
				: swept(head, props.sweep, theme.accentDim, theme.sweepHighlight);
	const body = rest.length > 0 ? `${theme.textSubtle}${rest}${theme.reset}` : "";
	return `${headText}${body}${" ".repeat(Math.max(0, columns - displayWidth(line)))}`;
}

/** 按显示宽度切出前若干列；切点落在字素边界上。 */
function cutByWidth(text: string, width: number): string {
	let used = 0;
	let out = "";
	for (const grapheme of graphemes(text)) {
		const next = used + displayWidth(grapheme);
		if (next > width) break;
		out += grapheme;
		used = next;
	}
	return out;
}

/** 从容器 props 里取出状态内容；缺字段时按「没有」处理。 */
export function statusBarPropsOf(props: Readonly<Record<string, unknown>>): StatusBarProps {
	const text = typeof props["text"] === "string" ? props["text"] : "";
	const tone = props["tone"];
	const sweep = props["sweep"];
	return {
		text,
		...(typeof props["symbol"] === "string" ? { symbol: props["symbol"] } : {}),
		...(typeof props["phase"] === "string" ? { phase: props["phase"] } : {}),
		...(typeof props["elapsed"] === "string" ? { elapsed: props["elapsed"] } : {}),
		...(typeof props["tokens"] === "string" ? { tokens: props["tokens"] } : {}),
		...(tone === "running" || tone === "warning" || tone === "error" || tone === "notice" ? { tone } : {}),
		...(typeof sweep === "number" && Number.isFinite(sweep) ? { sweep } : {}),
	};
}
