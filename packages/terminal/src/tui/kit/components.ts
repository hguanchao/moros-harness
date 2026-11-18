import { el, type ComponentProps, type Node } from "./element.ts";
import type { ListItem } from "./list.ts";
import type { PageProps } from "./page.ts";
import type { StatusBarProps } from "./statusbar.ts";

/**
 * 内建组件。
 *
 * 都是内建原语之上的薄糖：只负责把属性名收敛成人读得懂的形状，不含布局逻辑。应用写页面
 * 时用这一层，不直接写 `el("box", …)`。
 */

/** 容器属性。 */
export interface BoxProps {
	/** 主轴方向；默认纵向 */
	readonly direction?: "row" | "column";
	/** 固定宽度（含边框与 padding，不含 margin） */
	readonly width?: number;
	/** 固定高度（含边框与 padding，不含 margin） */
	readonly height?: number;
	readonly padding?: number | { readonly x: number; readonly y: number };
	/** 四周外边距：在兄弟之间留白，等价于把盒子缩小一圈 */
	readonly margin?: number;
	/** 子节点间距 */
	readonly gap?: number;
	/** 单线边框 */
	readonly border?: boolean;
	/** 伸缩权重；容器有剩余空间时按权重分配 */
	readonly flexGrow?: number;
}

/**
 * 容器。
 *
 * 默认纵向排列、子节点横向拉满；`direction: "row"` 时改为横排、纵向拉满。
 */
export function Box(props: BoxProps & ComponentProps & { readonly children: readonly Node[] }): Node {
	const { theme: _theme, children, ...rest } = props;
	return el("box", rest, ...children);
}

/** 文本属性。 */
export interface TextProps {
	/** 前景色：一段已编码的 SGR 序列；省略时用终端默认色 */
	readonly color?: string;
	/** 在自己的矩形内水平对齐 */
	readonly align?: "left" | "center" | "right";
	/** 直接给定内容；与子节点同时存在时以它为准 */
	readonly text?: string;
}

/**
 * 文本。
 *
 * 只接受字符串子节点：需要混排多种样式时，把它们拆成并列的文本节点，而不是在文本里塞
 * 元素——那样宽度计算会失去依据。
 */
export function Text(props: TextProps & ComponentProps & { readonly children: readonly Node[] }): Node {
	const { theme: _theme, children, text, ...rest } = props;
	return el("text", text === undefined ? rest : { ...rest, text }, ...children);
}

/** 分隔线属性。 */
export interface DividerProps {
	/** 组成线条的字符；默认 `─` */
	readonly char?: string;
	/** 线条颜色 */
	readonly color?: string;
}

/** 整行分隔线；宽度由父容器决定。 */
export function Divider(props: DividerProps & ComponentProps): Node {
	const { theme: _theme, ...rest } = props;
	return el("divider", rest);
}

/** 占位；默认吃满容器剩余空间，用来把两侧内容撑开。 */
export function Spacer(props: { readonly flexGrow?: number } & ComponentProps): Node {
	const { theme: _theme, ...rest } = props;
	return el("spacer", rest);
}

/** 预先渲染好的行；每行宽度不得超过分配宽度，超出会被裁掉。 */
export function RawLines(props: { readonly lines: readonly string[] }): Node {
	return el("raw", { lines: props.lines });
}

/** 滚动视口属性。 */
export interface ScrollViewProps {
	/** 内容行；宽度不得超过视口宽度 */
	readonly lines: readonly string[];
	/** 从第几行开始显示 */
	readonly scrollTop?: number;
	/** 伸缩权重；放进纵向容器时用它吃满剩余高度 */
	readonly flexGrow?: number;
}

/**
 * 滚动视口。
 *
 * 只负责「露出哪一段」：吸顶、跟随底部、未读计数都是应用策略，由调用方决定 `scrollTop`。
 * 滚动条用 `scrollbarColumn()` 单独画在最右列，不混进内容行。
 */
export function ScrollView(props: ScrollViewProps & ComponentProps): Node {
	const { theme: _theme, scrollTop = 0, ...rest } = props;
	return el("scroll", { ...rest, scrollTop });
}

/** 列表面板属性。 */
export interface ListProps {
	readonly items: readonly (ListItem | string)[];
	/** 键盘选中的条目下标 */
	readonly cursor?: number;
	/** 可见窗口起点；省略时自动让它包含 cursor */
	readonly scrollTop?: number;
	/** 最多显示几行条目；省略时全部显示 */
	readonly visible?: number;
	/** 一条都没有时显示的一句话 */
	readonly empty?: string;
	/** 顶边右侧的标签；省略时按条目数自动生成 */
	readonly countLabel?: string;
	readonly flexGrow?: number;
}

/**
 * 列表面板。
 *
 * 上下两条整宽横线夹若干条目行；条目不折行，超出宽度截断。选中与悬停分开：指针停在哪
 * 不改变键盘选中项。
 */
export function List(props: ListProps & ComponentProps): Node {
	const { theme: _theme, ...rest } = props;
	return el("list", rest);
}

/** 输入框属性。 */
export interface InputProps {
	readonly value: string;
	/** 光标偏移；省略时停在末尾 */
	readonly cursor?: number;
	readonly focused?: boolean;
	/** 开头属于斜杠命令的字符数；这些字符用强调色 */
	readonly commandLength?: number;
	/** 最多同时显示几行；省略时用组件默认值 */
	readonly maxLines?: number;
}

/**
 * 输入框。
 *
 * 上下两条横线、中间是提示符与折行后的正文。光标位置由 `inputMetrics()` 给出——终端光标
 * 由应用按列坐标显示，组件本身只画文字。
 */
export function Input(props: InputProps & ComponentProps): Node {
	const { theme: _theme, ...rest } = props;
	return el("input", rest);
}

/**
 * 整屏页。
 *
 * 正文按可用高度滚动，底部动作条固定。宽度与高度都由容器给，`scrollTop` 由应用推进。
 */
export function Page(props: PageProps & ComponentProps): Node {
	const { theme: _theme, ...rest } = props;
	return el("page", rest);
}

/** 状态行；一行高，宽度由容器给。数字与时间由调用方先格式化好。 */
export function StatusBar(props: StatusBarProps & ComponentProps): Node {
	const { theme: _theme, ...rest } = props;
	return el("statusbar", rest);
}

/** 徽标色调。 */
export type BadgeTone = "accent" | "subtle" | "warning" | "error";

/**
 * 行内徽标：`ASK` / `AUTO` / `YOLO` / `PLAN` 这类短标记。
 *
 * 只着色不加边框——徽标在页脚行尾与输入框边框之间，加框会把这一行撑高。
 */
export function Badge(props: { readonly label: string; readonly tone?: BadgeTone } & ComponentProps): Node {
	const { theme, label, tone } = props;
	const color =
		tone === "warning"
			? theme.warning
			: tone === "error"
				? theme.error
				: tone === "subtle"
					? theme.textSubtle
					: theme.accent;
	return el("text", { text: label, color });
}

/** 转圈帧；一百毫秒一帧，由应用推进。 */
export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

/** 转圈：按帧取一个盲文字符；负帧号与超界帧号都夹回范围内。 */
export function Spinner(props: { readonly frame?: number } & ComponentProps): Node {
	const { theme: _theme, frame = 0 } = props;
	const count = SPINNER_FRAMES.length;
	const index = ((Math.trunc(frame) % count) + count) % count;
	return el("text", { text: SPINNER_FRAMES[index] ?? "" });
}
