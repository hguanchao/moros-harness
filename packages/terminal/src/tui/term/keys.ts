/**
 * 终端输入的字节级解码。
 *
 * 只做一件事：把终端交来的原始字节块拆成可识别的按键序列、鼠标事件与粘贴区间。所有函数
 * 都是无状态的纯函数——输入进来、结果出去，界面状态机只决定何时调用它们。
 *
 * 这里不认业务语义：审批键位、菜单命中、文本编辑都不在本模块，它们属于应用或组件层。
 */

/** 粘贴区间的起止标记（bracketed paste）。 */
export const PASTE_START = "\x1b[200~";
export const PASTE_END = "\x1b[201~";

/** 按钮码的滚轮位:64–67 都是滚轮,带修饰键时这一位同样置位。 */
export const MOUSE_WHEEL_BIT = 64;
/** SGR 鼠标协议:滚轮向上与向下的按钮码。 */
export const MOUSE_WHEEL_UP = MOUSE_WHEEL_BIT;
export const MOUSE_WHEEL_DOWN = MOUSE_WHEEL_BIT + 1;
/** 按钮码的移动位:纯悬停与按住拖动都会带上它。 */
export const MOUSE_MOTION_BIT = 32;
/** 按钮码低两位是真实按键编号:0 是左键,掩出来为 0 才算点击。 */
export const MOUSE_BUTTON_MASK = 3;

/**
 * Shift+Tab 的转义序列。
 *
 * 终端有三种说法：`\x1b[Z`（xterm 一系，含 Windows Terminal）、带修饰键列的
 * `\x1b[1;2Z`、以及 kitty CSI-u 协议下的 `\x1b[9;2u`（9 是制表符码位，2 表示按下
 * Shift）。只认整段精确匹配：粘贴内容被括在成对的粘贴标记里，永远不会恰好等于一个
 * 裸序列；输入里零散的 `[Z` 之类文字也因此不会被当成切换。
 */
export function shiftTabKey(text: string): boolean {
	return text === "\x1b[Z" || text === "\x1b[1;2Z" || text === "\x1b[9;2u";
}

/** 菜单打开时只认这四个键；普通字符与鼠标事件一律忽略。 */
export function menuKey(text: string): "up" | "down" | "enter" | "tab" | "escape" | undefined {
	if (text.includes("\x1b[A") || text.includes("\x1bOA")) return "up";
	if (text.includes("\x1b[B") || text.includes("\x1bOB")) return "down";
	if (text.includes("\r") || text.includes("\n")) return "enter";
	// 只认单独的制表符：粘贴的内容里可能带 \t，不能把整块粘贴当成一次确认
	if (text === "\t") return "tab";
	if (text === "\x1b") return "escape";
	return undefined;
}

/** 输入历史只认完整的方向键序列，避免把粘贴内容里的序列当成翻历史。 */
export function historyKey(text: string): -1 | 1 | undefined {
	if (text === "\x1b[A" || text === "\x1bOA") return -1;
	if (text === "\x1b[B" || text === "\x1bOB") return 1;
	return undefined;
}

/**
 * 撤回或丢弃排队消息的按键：Alt+Up 取回队尾，Alt+Down 直接丢弃。
 *
 * 只认单独到达的序列：方向键本身要给输入历史和光标用，必须靠修饰键把它们分开。
 */
export function queuedEditKey(text: string): "recall" | "discard" | undefined {
	if (text === "\x1b[1;3A" || text === "\x1b[1;9A") return "recall";
	if (text === "\x1b[1;3B" || text === "\x1b[1;9B") return "discard";
	return undefined;
}

/** 对话流滚动键。 */
export function scrollKey(text: string): "pageUp" | "pageDown" | undefined {
	if (text === "\x1b[5~") return "pageUp";
	if (text === "\x1b[6~") return "pageDown";
	return undefined;
}

/** 去掉 SGR 鼠标事件，避免它们被当成普通输入。 */
export function stripMouseEvents(text: string): string {
	return text.replace(/\x1b\[<[0-9;]+[Mm]/g, "");
}

/** 去掉窗口焦点上报，避免它们被当成输入或触发输入焦点恢复。 */
export function stripFocusEvents(text: string): string {
	return text.replace(/\x1b\[[IO]/g, "");
}

/**
 * 去掉括起来的粘贴内容，只留下真实的按键。
 *
 * 模态界面（审批卡、菜单、整屏页）只认按键，不该读粘贴的正文：粘贴里随便一个换行就会被
 * 当成回车、一个字母 y 就会被当成「允许」，等于让剪贴板内容替使用者做决定。返回空串说明
 * 这一块全是粘贴内容，调用方应当整块忽略。
 */
export function stripPasteContent(text: string): string {
	return text.replace(/\x1b\[200~[\s\S]*?(?:\x1b\[201~|$)/g, "");
}

/**
 * 这一块输入处理完之后是否仍处在粘贴区间内。
 *
 * 终端把一次粘贴拆成多块时，只有第一块带起始标记、最后一块带结束标记。按标记出现的
 * 顺序翻转就能得到正确状态。状态必须由调用方记住并往下传：只剥当前块里的粘贴内容的话，
 * 后续块没有起始标记，会被原样当成按键——审批卡上的一次换行就等于替使用者点了同意。
 */
export function pastingAfter(text: string, pasting: boolean): boolean {
	let state = pasting;
	for (const match of text.matchAll(/\x1b\[(200|201)~/g)) {
		state = match[1] === "200";
	}
	return state;
}

/** CSI-u 按键：`CSI 码位[:shifted[:base]][;修饰键[:事件]]u`。 */
const KITTY_KEY = /\x1b\[(\d+)(?::\d+)*(?:;(\d+)(?::(\d+))?)?u/g;

/** kitty 修饰键位；CapsLock/NumLock 位只影响大小写状态，比较前要掩掉。 */
const KITTY_SHIFT = 1;
const KITTY_ALT = 2;
const KITTY_CTRL = 4;

/**
 * 把 kitty 键盘协议下的按键还原成传统编码。
 *
 * 开启 disambiguate 档位后，Esc、带 Ctrl/Alt 的按键、Shift+Enter/Tab/Backspace 以及小键盘
 * 会以 CSI-u 到达，其余按键仍是传统编码。这里只改写协议序列，没开启协议的终端原样通过。
 * 粘贴区间是正文而不是按键，里面的序列必须保持原样，所以按粘贴标记分段处理。
 */
export function decodeKittyKeys(text: string, pasting: boolean): string {
	if (!text.includes("\x1b[")) return text;

	let out = "";
	let index = 0;
	let inPaste = pasting;
	while (index < text.length) {
		if (inPaste) {
			const end = text.indexOf(PASTE_END, index);
			if (end < 0) {
				out += text.slice(index);
				break;
			}
			out += text.slice(index, end + PASTE_END.length);
			index = end + PASTE_END.length;
			inPaste = false;
			continue;
		}
		const start = text.indexOf(PASTE_START, index);
		const stop = start < 0 ? text.length : start;
		out += text.slice(index, stop).replace(KITTY_KEY, decodeKittyMatch);
		if (start < 0) break;
		out += PASTE_START;
		index = start + PASTE_START.length;
		inPaste = true;
	}
	return out;
}

function decodeKittyMatch(match: string, codeText: string, modifierText?: string, eventText?: string): string {
	// 3 是松开事件：没有开启事件上报就不会出现，真出现也不能再输入一次
	if (eventText === "3") return "";
	const code = Number(codeText);
	const modifiers = modifierText === undefined ? 1 : Number(modifierText);
	const legacy = kittyKeyToLegacy(code, (modifiers - 1) & 0b11111);
	return legacy === undefined ? match : legacy;
}

/** 返回传统编码；undefined 表示保持原序列（交给后续解析），空串表示丢弃。 */
function kittyKeyToLegacy(code: number, mods: number): string | undefined {
	const shift = (mods & KITTY_SHIFT) !== 0;
	const alt = (mods & KITTY_ALT) !== 0;
	const ctrl = (mods & KITTY_CTRL) !== 0;

	if (code === 13) {
		// Shift+Enter 留给编辑器当换行；其它修饰键组合不猜，吞掉以免误提交
		if (shift && !alt && !ctrl) return undefined;
		return ctrl || alt ? "" : "\r";
	}
	if (code === 9) {
		if (shift && !alt && !ctrl) return undefined;
		return alt ? "\x1b\t" : "\t";
	}
	if (code === 127) {
		if (alt) return "\x1b\x7f";
		return ctrl ? "\x08" : "\x7f";
	}
	if (code === 27) return "\x1b";

	// 小键盘按键在协议下也走 CSI-u：数字与符号要还原成正文，方向键还原成传统序列
	const keypad = keypadKey(code);
	if (keypad !== undefined) return keypad;

	if (code < 32 || code > 126) return undefined;

	if (ctrl) {
		const control = controlCharacter(code);
		if (control === undefined) return undefined;
		return alt ? `\x1b${control}` : control;
	}
	if (alt) {
		const char = String.fromCharCode(code);
		return `\x1b${shift ? char.toUpperCase() : char}`;
	}
	// 只有 Shift 的文本键在协议下仍直接发文本；这里兜底还原成字符
	const char = String.fromCharCode(code);
	return shift ? char.toUpperCase() : char;
}

/** Ctrl 与 ASCII 键的传统映射；没有对应控制字符时返回 undefined。 */
function controlCharacter(code: number): string | undefined {
	if (code === 32) return "\x00";
	if (code === 63) return "\x7f";
	if (code >= 64 && code <= 95) return String.fromCharCode(code & 0x1f);
	if (code >= 97 && code <= 122) return String.fromCharCode(code & 0x1f);
	return undefined;
}

/** 小键盘的固定码位；不是小键盘按键时返回 undefined。 */
function keypadKey(code: number): string | undefined {
	if (code >= 57399 && code <= 57408) return String.fromCharCode(48 + code - 57399);
	if (code === 57409) return ".";
	if (code === 57410) return "/";
	if (code === 57411) return "*";
	if (code === 57412) return "-";
	if (code === 57413) return "+";
	if (code === 57414) return "\r";
	if (code === 57415) return "=";
	if (code === 57416) return ",";
	if (code === 57417) return "\x1b[D";
	if (code === 57418) return "\x1b[C";
	if (code === 57419) return "\x1b[A";
	if (code === 57420) return "\x1b[B";
	if (code === 57421) return "\x1b[5~";
	if (code === 57422) return "\x1b[6~";
	if (code === 57423) return "\x1b[H";
	if (code === 57424) return "\x1b[F";
	if (code === 57425) return "\x1b[2~";
	if (code === 57426) return "\x1b[3~";
	return undefined;
}

/** 一次 SGR 鼠标事件。 */
export interface MouseInput {
	readonly button: number;
	readonly column: number;
	readonly row: number;
	/** SGR 的 M 表示按下，m 表示松开 */
	readonly press: boolean;
}

/**
 * 按住键拖动的移动事件。
 *
 * 1003 模式还会上报没按键的纯移动（低两位为 3），那只是指针在挪，不能当成拖动去改选中项。
 */
export function dragMotion(button: number): boolean {
	return button >= 32 && button < 64 && (button & MOUSE_BUTTON_MASK) !== 3;
}

/** 解析一块输入里的全部 SGR 鼠标事件，按出现顺序返回。 */
export function mouseEvents(text: string): readonly MouseInput[] {
	const events: MouseInput[] = [];
	for (const match of text.matchAll(/\x1b\[<(\d+);(\d+);(\d+)([Mm])/g)) {
		events.push({
			button: Number(match[1]),
			column: Number(match[2]),
			row: Number(match[3]),
			press: match[4] === "M",
		});
	}
	return events;
}
