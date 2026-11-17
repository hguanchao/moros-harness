import { PASTE_END, PASTE_START } from "#src/tui/term/index.ts";
import type { ApprovalAnswer } from "#src/tui/app/contract/approval.ts";
import { MENU_MAX_VISIBLE, keepVisible } from "#src/tui/app/panel/menu-panel.ts";
import { sanitizePasteText } from "#src/tui/app/paste.ts";

/**
 * 应用层的按键语义与输入编辑器。
 *
 * 字节级解码（转义序列、鼠标事件、粘贴区间）在 `src/tui/term`；这里只放三层东西：把按键
 * 映射成本应用的动作（审批结论）、菜单命中（依赖面板滚动窗口）、以及输入框的编辑规则。
 * 编辑器是纯函数：输入进来、结果出去，界面状态机只决定何时调用它。
 */

type ApprovalKey = ApprovalAnswer | "left" | "right" | "enter" | "escape";

/**
 * 审批按键：左右移动、回车确认；y/a/n 仍可直接执行，Esc 拒绝。
 *
 * 只认精确的单键：审批卡是异步弹出的，使用者很可能正在打字，一整段文字里只要
 * 含 y/a/n 就放行，等于让「继续输入」替自己批准了工具调用。多键块一律忽略，
 * 宁可让使用者再按一次，也不能凭猜测做出不可逆的结论。
 *
 * 返回的是本应用的审批结论，因此不随解码层下沉到 `src/tui/term`。
 */
export function approvalKey(text: string, canAlways: boolean): ApprovalKey | undefined {
	if (text === "\x1b[D" || text === "\x1bOD") return "left";
	if (text === "\x1b[C" || text === "\x1bOC") return "right";
	if (text === "\r" || text === "\n") return "enter";
	if (text === "\x1b") return "escape";

	const lower = text.toLowerCase();
	if (lower === "y") return "once";
	if (canAlways && lower === "a") return "always";
	if (lower === "n") return "deny";
	return undefined;
}

/** 一个菜单面板交给公共鼠标处理器的交互面。 */
export interface MenuMouseTarget {
	/** 终端行号命中的条目下标;命中不了(点到面板外或边框上)返回 undefined */
	readonly hitItem: (row: number) => number | undefined;
	/** 这一行是否落在面板范围内（含边框与提示行） */
	readonly contains: (row: number) => boolean;
	readonly cursor: () => number;
	readonly select: (index: number) => void;
	/** 滚轮移动选中项：不循环，到头即停 */
	readonly scroll: (delta: number) => void;
	/** 左键点击条目后把该项补进输入框;只回显不执行 */
	readonly complete: () => void;
	readonly pressed: () => number | undefined;
	readonly setPressed: (index: number | undefined) => void;
	readonly hover: () => number | undefined;
	readonly setHover: (index: number | undefined) => void;
}

/**
 * 菜单面板的屏幕行对应哪个条目。
 *
 * row 是终端上报的 1 基行号；panelTop 是面板上边框所在的 1 基行号。条目从上边框下一行
 * 开始，所以偏移量是 row - panelTop - 1。
 *
 * 依赖面板的滚动窗口，属于命中图而不是输入解码，因此留在应用层。
 */
export function menuIndexAtRow(
	row: number,
	panelTop: number,
	itemCount: number,
	scrollTop: number,
	cursor: number,
	maxVisible = MENU_MAX_VISIBLE,
): number | undefined {
	const visible = Math.min(Math.max(0, itemCount), maxVisible);
	if (visible === 0) return undefined;
	const offset = row - panelTop - 1;
	if (offset < 0 || offset >= visible) return undefined;
	const index = keepVisible(scrollTop, cursor, itemCount, maxVisible) + offset;
	return index < itemCount ? index : undefined;
}

interface InputEdit {
	readonly text: string;
	readonly cursor: number;
	readonly submit: boolean;
	readonly pasting: boolean;
	readonly handled: boolean;
}

/** 一次粘贴要写进输入框的内容，以及光标前需要先删掉的字符数。 */
export interface PasteInsertion {
	readonly insert: string;
	readonly removeBefore: number;
}

/** 粘贴的落点决定：原样插入，或折叠成标记；调用方持有原文，编辑器只拿结果。 */
type PastePort = (text: string, before: string) => PasteInsertion;

/**
 * 把终端读到的一段字符并进输入框。
 *
 * 支持光标移动、行内 Home/End、删除、bracketed paste 多行粘贴；历史上下键由调用方处理。
 * 转义序列通常在一次读取里完整到达，未识别的序列整段丢弃，不能当成文字填进去。
 *
 * 粘贴原文要不要折叠由 paste 端口决定：编辑器不关心折叠阈值与原文存在哪，只按它给的结果
 * 插入。默认不折叠，测试与其它调用方可以省略。
 */
export function editInput(
	current: string,
	currentCursor: number,
	chunk: string,
	pasting: boolean,
	paste?: PastePort,
): InputEdit {
	let text = current;
	let cursor = Math.min(Math.max(0, currentCursor), current.length);
	let submit = false;
	let isPasting = pasting;
	let handled = false;

	const insert = (value: string): void => {
		if (value.length === 0) return;
		text = text.slice(0, cursor) + value + text.slice(cursor);
		cursor += value.length;
		handled = true;
	};
	const insertPaste = (value: string): void => {
		const cleaned = sanitizePasteText(value);
		const insertion = paste?.(cleaned, text.slice(0, cursor));
		if (insertion !== undefined && insertion.removeBefore > 0) {
			// 同一段内容贴在已有标记后面：把那行标记换回正文，这也是折叠唯一的展开手势
			const start = Math.max(0, cursor - insertion.removeBefore);
			text = text.slice(0, start) + text.slice(cursor);
			cursor = start;
		}
		insert(insertion?.insert ?? cleaned);
	};

	const applyKey = (sequence: string): void => {
		if (sequence === "\x1b[D" || sequence === "\x1bOD") {
			cursor = previousIndex(text, cursor);
		} else if (sequence === "\x1b[C" || sequence === "\x1bOC") {
			cursor = nextIndex(text, cursor);
		} else if (sequence === "\x1b[H" || sequence === "\x1bOH" || sequence === "\x1b[1~" || sequence === "\x1b[7~") {
			cursor = text.lastIndexOf("\n", Math.max(0, cursor - 1)) + 1;
		} else if (sequence === "\x1b[F" || sequence === "\x1bOF" || sequence === "\x1b[4~" || sequence === "\x1b[8~") {
			const end = text.indexOf("\n", cursor);
			cursor = end < 0 ? text.length : end;
		} else if (sequence === "\x1b[3~") {
			const end = nextIndex(text, cursor);
			if (end > cursor) text = text.slice(0, cursor) + text.slice(end);
			handled = true;
		} else if (sequence === "\x1b[13;2u" || sequence === "\x1b[27;2;13~") {
			// Shift+Enter：kitty CSI-u 与 xterm modifyOtherKeys 两种说法
			insert("\n");
		} else {
			return;
		}
		handled = true;
	};

	const normal = (value: string): void => {
		for (let index = 0; index < value.length; index += 1) {
			const char = value[index] ?? "";
			if (char === "\x1b") {
				const rest = value.slice(index);
				// Alt+Enter 已不再作为换行键：吞掉这一对，避免它退化成一次误提交
				if (rest.startsWith("\x1b\r") || rest.startsWith("\x1b\n")) {
					index += 1;
					continue;
				}
				const match = /^\x1b(?:\[[0-9;?]*[A-Za-z~]|O[A-Za-z])/.exec(rest);
				if (match !== null) {
					applyKey(match[0]);
					index += match[0].length - 1;
				}
				continue;
			}
			if (char === "\r" || char === "\n") {
				submit = true;
				return;
			}
			if (char === "\x7f" || char === "\b") {
				if (cursor > 0) {
					const start = previousIndex(text, cursor);
					text = text.slice(0, start) + text.slice(cursor);
					cursor = start;
					handled = true;
				}
				continue;
			}
			if (char >= " ") {
				insert(char);
			}
		}
	};

	let index = 0;
	while (index < chunk.length && !submit) {
		if (isPasting) {
			const end = chunk.indexOf(PASTE_END, index);
			if (end < 0) {
				insertPaste(chunk.slice(index));
				index = chunk.length;
				break;
			}
			insertPaste(chunk.slice(index, end));
			isPasting = false;
			index = end + PASTE_END.length;
			continue;
		}

		const start = chunk.indexOf(PASTE_START, index);
		const stop = start < 0 ? chunk.length : start;
		normal(chunk.slice(index, stop));
		if (submit || start < 0) break;

		const end = chunk.indexOf(PASTE_END, start + PASTE_START.length);
		if (end < 0) {
			insertPaste(chunk.slice(start + PASTE_START.length));
			isPasting = true;
			index = chunk.length;
			break;
		}
		insertPaste(chunk.slice(start + PASTE_START.length, end));
		index = end + PASTE_END.length;
	}

	return { text, cursor, submit, pasting: isPasting, handled };
}

function previousIndex(text: string, index: number): number {
	if (index <= 0) return 0;
	const code = text.charCodeAt(index - 1);
	if (code >= 0xdc00 && code <= 0xdfff) {
		const high = text.charCodeAt(index - 2);
		if (high >= 0xd800 && high <= 0xdbff) return index - 2;
	}
	return index - 1;
}

function nextIndex(text: string, index: number): number {
	if (index >= text.length) return text.length;
	const code = text.charCodeAt(index);
	if (code >= 0xd800 && code <= 0xdbff) {
		const low = text.charCodeAt(index + 1);
		if (low >= 0xdc00 && low <= 0xdfff) return index + 2;
	}
	return index + 1;
}
