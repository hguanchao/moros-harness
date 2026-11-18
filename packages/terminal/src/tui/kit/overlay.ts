import type { ScreenCell } from "../term/index.ts";

/**
 * 浮层：不占布局高度、按行列盖在整帧之上的那一层。
 *
 * 终端里没有真正的 z-order：做法是内容先整帧写好，再按绝对坐标重画一小块。因此浮层的
 * 输出不是行，而是 `ScreenCell[]`（交给 `Screen.paint({ cells })`）。这里只算坐标与命中，
 * 不认内容。
 */

export interface OverlayGeometry {
	/** 终端列数；最后一列留给滚动条，不参与居中 */
	readonly columns: number;
	readonly rows: number;
	/** 浮层内容的显示宽度 */
	readonly labelWidth: number;
	/** 命中区在左右各外扩几列；不传则与内容等宽 */
	readonly hitSlop?: number;
}

/** 浮层位置：行列都从 1 起算，`hit*` 是加宽后的可点区域。 */
export interface OverlayPlacement {
	readonly row: number;
	readonly column: number;
	readonly width: number;
	readonly hitColumn: number;
	readonly hitWidth: number;
}

/**
 * 「贴在最后一行的正文区中央」的浮层位置。
 *
 * 居中只按滚动条左侧的正文区算：整行居中会让浮层往右偏半列，紧贴滚动条反而看不出是浮层。
 * 屏幕放不下（宽或高不够）时返回 undefined，由调用方决定不画。
 */
export function placeBottomCenter(geometry: OverlayGeometry): OverlayPlacement | undefined {
	const columns = Math.max(0, Math.floor(geometry.columns));
	const rows = Math.max(0, Math.floor(geometry.rows));
	const width = Math.max(0, Math.floor(geometry.labelWidth));
	if (rows === 0 || columns < width + 2) return undefined;

	const contentWidth = columns - 1;
	const column = Math.floor((contentWidth - width) / 2) + 1;
	const slop = Math.max(0, Math.floor(geometry.hitSlop ?? 0));
	const hitColumn = Math.max(1, column - slop);
	// 右边界不能落到滚动条那一列，否则拖动滚动条会误触
	const hitEnd = Math.min(contentWidth, column + width - 1 + slop);
	return { row: rows, column, width, hitColumn, hitWidth: hitEnd - hitColumn + 1 };
}

/** 屏幕坐标是否落在浮层命中区；行列都从 1 起算，右边界不含。 */
export function overlayHit(placement: OverlayPlacement, row: number, column: number): boolean {
	return row === placement.row && column >= placement.hitColumn && column < placement.hitColumn + placement.hitWidth;
}

/**
 * 把一列/一块内容转成按坐标重画的单元。
 *
 * `row`/`column` 是浮层左上角（1 基）；每行文本原样带出，颜色转义由调用方自己拼好。
 * 这是浮层唯一正确的落屏方式：跟着内容一起写会让终端的自动折行把它带到别处。
 */
export function overlayCells(
	lines: readonly string[],
	placement: { readonly row: number; readonly column: number },
): readonly ScreenCell[] {
	return lines.map((text, index) => ({
		row: placement.row + index,
		column: placement.column,
		text,
	}));
}

/**
 * 纯文本帧上的浮层合成（测试与小工具用）。
 *
 * 假定 `base` 与浮层行都是无转义的等宽文本；带颜色的浮层必须走 `overlayCells`。
 */
export function overlayLines(
	base: readonly string[],
	lines: readonly string[],
	placement: { readonly row: number; readonly column: number },
	columns: number,
): readonly string[] {
	const result = base.map((line) => line.padEnd(Math.max(0, columns), " ").slice(0, columns));
	lines.forEach((text, index) => {
		const row = placement.row + index - 1;
		if (row < 0 || row >= result.length) return;
		const start = Math.max(0, placement.column - 1);
		const left = (result[row] ?? "").slice(0, start).padEnd(start, " ");
		const right = (result[row] ?? "").slice(start + text.length);
		result[row] = `${left}${text}${right}`.slice(0, columns).padEnd(columns, " ");
	});
	return result;
}
