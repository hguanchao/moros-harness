import {
	BEGIN_SYNCHRONIZED_UPDATE,
	CURSOR_BLINKING_BAR,
	CURSOR_DEFAULT,
	DISABLE_BRACKETED_PASTE,
	DISABLE_FOCUS_REPORTING,
	DISABLE_KEYBOARD_PROTOCOL,
	DISABLE_MOUSE,
	ENABLE_BRACKETED_PASTE,
	ENABLE_FOCUS_REPORTING,
	ENABLE_KEYBOARD_PROTOCOL,
	ENABLE_MOUSE,
	END_SYNCHRONIZED_UPDATE,
	ENTER_ALTERNATE_SCREEN,
	ERASE_BELOW,
	ERASE_LINE,
	HIDE_CURSOR,
	LEAVE_ALTERNATE_SCREEN,
	RESET,
	SHOW_CURSOR,
	moveCursor,
} from "#src/tui/term/ansi.ts";
import type { OutputLike } from "#src/tui/term/output.ts";

/**
 * 全屏屏幕写入。
 *
 * 只做一件事：把一帧内容按坐标写进备用屏，并保证这一帧原子呈现。布局、差量、光标位置
 * 的语义全都不在这里——调用方算好「第几行第几列放什么」，Screen 只负责编码成序列。
 */

/** 覆盖在整帧之上的一个定位单元：滚动条、置底按钮这类不随折行移动的元素。 */
export interface ScreenCell {
	/** 1 基行号 */
	readonly row: number;
	/** 1 基列号 */
	readonly column: number;
	/** 已带颜色等转义序列的片段，按原样写入 */
	readonly text: string;
}

/** 一帧的完整描述。 */
export interface ScreenFrame {
	/** 终端列数；整帧按这个宽度写，超出部分由终端裁掉 */
	readonly columns: number;
	/** 终端行数；内容不足这个行数时从末尾擦到屏底 */
	readonly rows: number;
	/** 自上而下的每一行，行内不再含换行符 */
	readonly lines: readonly string[];
	/** 行内容写完之后，按坐标覆盖的定位单元，按数组顺序写入 */
	readonly cells?: readonly ScreenCell[] | undefined;
	/** 光标停在哪个坐标；省略时保持隐藏 */
	readonly cursor?: { readonly row: number; readonly column: number } | undefined;
}

/**
 * 备用屏上的整帧写入器。
 *
 * 每帧写满整个可见区域，不做行级差量：一旦有任何绕过本对象的输出（Node 警告、子进程、
 * 底部写入触发的终端滚动）改写了屏幕，行级缓存就会与真实画面失配，被污染的行会一直被
 * 跳过，旧帧永久留在屏幕上且不会自愈。整帧重写的字节量远小于流式输出本身，用这点带宽
 * 换「下一帧必定自愈」是值得的。
 */
export class Screen {
	readonly #out: OutputLike;

	constructor(out: OutputLike) {
		this.#out = out;
	}

	/**
	 * 进入备用屏并打开交互所需的终端模式。
	 *
	 * 顺序有意义：先切备用屏，再设置光标与各类上报。调用方应在写入任何一帧之前调用。
	 */
	enter(): void {
		this.#out.write(
			ENTER_ALTERNATE_SCREEN +
				CURSOR_BLINKING_BAR +
				HIDE_CURSOR +
				ENABLE_FOCUS_REPORTING +
				ENABLE_MOUSE +
				ENABLE_BRACKETED_PASTE +
				ENABLE_KEYBOARD_PROTOCOL,
		);
	}

	/**
	 * 关闭各类上报并回到主屏。
	 *
	 * 与 `enter` 对称，重复调用无害：退出路径可能被信号与异常同时走到，重复执行只是多写
	 * 一遍同样的序列。
	 */
	leave(): void {
		this.#out.write(
			DISABLE_KEYBOARD_PROTOCOL +
				DISABLE_BRACKETED_PASTE +
				DISABLE_MOUSE +
				DISABLE_FOCUS_REPORTING +
				CURSOR_DEFAULT +
				SHOW_CURSOR +
				LEAVE_ALTERNATE_SCREEN,
		);
	}

	/**
	 * 写入一帧。
	 *
	 * 同步输出（DEC 2026）把整帧包成一次呈现，避免滚动与转圈时看到半帧旧内容；不支持该
	 * 序列的终端会忽略它，行为与逐行写入相同。
	 *
	 * @param frame 一帧的完整内容与坐标
	 */
	paint(frame: ScreenFrame): void {
		let output = HIDE_CURSOR + BEGIN_SYNCHRONIZED_UPDATE;
		// 每行按自己的坐标写，而不是靠换行符顺推：一行的实际列宽取决于终端怎么算其中的
		// 字符（歧义宽度字符各终端算 1 列或 2 列），算得比我们宽时终端会替它换行，顺推
		// 下去后面的行就整体错位。按坐标写时溢出的尾巴会被下一行覆盖，只损失这一行末尾
		// 一两个字符。不整屏清空：先擦行再覆盖，旧内容不会在清屏与重绘之间闪一下。
		for (let row = 0; row < frame.lines.length; row += 1) {
			output += `${moveCursor(row + 1, 1)}${RESET}${ERASE_LINE}${frame.lines[row] ?? ""}`;
		}
		// 滚动条、整屏页滚动条与置底按钮都单独定位，按自己的行列坐标盖在整帧之上
		for (const cell of frame.cells ?? []) {
			output += `${moveCursor(cell.row, cell.column)}${cell.text}`;
		}
		// 终端变高后，这一帧没有覆盖到的底部行补一次擦除
		if (frame.lines.length < frame.rows) {
			output += `${moveCursor(frame.lines.length + 1, 1)}${RESET}${ERASE_BELOW}`;
		}
		if (frame.cursor !== undefined) {
			output += `${moveCursor(frame.cursor.row, frame.cursor.column)}${SHOW_CURSOR}`;
		}
		this.#out.write(output + END_SYNCHRONIZED_UPDATE);
	}
}
