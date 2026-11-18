import type { OutputLike, SizeLike } from "./output.ts";

/**
 * 终端控制序列与环境默认值。
 *
 * 全部集中在这里：进入/离开备用屏、光标、焦点、鼠标、粘贴、同步输出与擦除。调用方只引用
 * 有语义的名字，不在业务代码里拼转义序列。
 */

export const ENTER_ALTERNATE_SCREEN = "\x1b[?1049h";
export const LEAVE_ALTERNATE_SCREEN = "\x1b[?1049l";
export const HIDE_CURSOR = "\x1b[?25l";
export const SHOW_CURSOR = "\x1b[?25h";
/** 终端光标形状：5 是闪烁竖线，0 是恢复终端默认。 */
export const CURSOR_BLINKING_BAR = "\x1b[5 q";
export const CURSOR_DEFAULT = "\x1b[0 q";
/** 打开/关闭终端的焦点上报；关闭后终端不会再往输入里塞焦点事件。 */
export const ENABLE_FOCUS_REPORTING = "\x1b[?1004h";
export const DISABLE_FOCUS_REPORTING = "\x1b[?1004l";
export const FOCUS_IN = "\x1b[I";
export const FOCUS_OUT = "\x1b[O";
/**
 * 按钮事件上报加 SGR 坐标。
 *
 * 1002 只上报按住键的拖动，1003 连指针的空移动也上报——悬停高亮靠的是后者。两个都开：不认
 * 1003 的终端退回只有拖动上报，点击与拖动照常可用，只是没有悬停。代价是鼠标每动一下都有
 * 数据进来，所以悬停只在状态真的变化时才重绘。
 */
export const ENABLE_MOUSE = "\x1b[?1002h\x1b[?1003h\x1b[?1006h";
export const DISABLE_MOUSE = "\x1b[?1006l\x1b[?1003l\x1b[?1002l";
/** 粘贴多行内容时不把换行当成提交。 */
export const ENABLE_BRACKETED_PASTE = "\x1b[?2004h";
export const DISABLE_BRACKETED_PASTE = "\x1b[?2004l";
/**
 * kitty 键盘协议（disambiguate 档）：Shift+Enter 等带修饰键的按键才会以独立序列到达。
 *
 * 用压栈/出栈而不是直接设值：栈由终端按主屏/备用屏分别维护，退出时出栈就能还原，不影响
 * 使用者原来的键盘模式。不支持的终端会忽略这两个序列。
 */
export const ENABLE_KEYBOARD_PROTOCOL = "\x1b[>1u";
export const DISABLE_KEYBOARD_PROTOCOL = "\x1b[<u";
/**
 * DEC 2026 同步输出：整帧写完才一次性呈现。
 *
 * 每帧重绘整屏，如果终端边解析边刷新，滚动和转圈时就会看到半帧旧内容、半帧新内容。
 * 不支持的终端会忽略这两个序列，行为与现在一致。
 */
export const BEGIN_SYNCHRONIZED_UPDATE = "\x1b[?2026h";
export const END_SYNCHRONIZED_UPDATE = "\x1b[?2026l";
export const RESET = "\x1b[0m";
/** 擦掉光标所在行；逐行覆盖前先擦，页脚这类不补满宽度的行才不会留下上一帧的尾巴。 */
export const ERASE_LINE = "\x1b[K";
export const ERASE_BELOW = "\x1b[J";
/**
 * OSC 0 清空窗口/标签标题。退出 TUI 时用：OSC 只能写、不能读回原标题，清空后由终端
 * 自己回到默认标题。
 */
export const CLEAR_TERMINAL_TITLE = "\x1b]0;\x07";
/** C0 与 C1 控制字符；标题来自会话内容，BEL 或 ESC 会提前结束 OSC 序列并注入转义序列。 */
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]+/g;
export const DEFAULT_COLUMNS = 80;
const DEFAULT_ROWS = 24;
/** Ctrl+C 在原始模式下以控制字符到达，不会触发 SIGINT，必须自己识别。 */
export const CTRL_C = "\x03";

/** 光标定位序列 CUP：行列都从 1 开始，与 ANSI 一致（不是数组下标）。 */
export function moveCursor(row: number, column: number): string {
	return `\x1b[${row};${column}H`;
}

/**
 * OSC 0 设置窗口标题。
 *
 * 只写序列，不决定标题内容：标题由调用方派生（通常是会话标题），这里只负责把它安全地
 * 编码进 OSC。标题取自外部文本，过滤控制字符是必须的——否则一个 `\x07` 就能把后半段
 * 变成任意转义序列。
 */
export function setTitle(output: OutputLike, title: string): void {
	output.write(`\x1b]0;${title.replace(CONTROL_CHARACTERS, " ")}\x07`);
}

/** 清空窗口标题：OSC 只能写、读不回原标题，清空后由终端自己回到默认标题。 */
export function clearTitle(output: OutputLike): void {
	output.write(CLEAR_TERMINAL_TITLE);
}

/** 终端可视行数；拿不到尺寸时按 24 兜底，最少 1 行——0 行会让后续布局除零。 */
export function terminalHeight(size: SizeLike): number {
	return Math.max(1, size.rows ?? DEFAULT_ROWS);
}
