import type { Theme } from "../term/index.ts";

/**
 * 视口几何。
 *
 * 只算几何：滑块多高、停在哪、拖动落在哪一行。吸顶提示、跟随底部、未读计数属于应用策略，
 * 不在这里——同一份几何被绘制与拖动共用，两边各算一遍时滑块永远不会停在光标下。
 */

/** 滑块字符与轨道字符。 */
const THUMB = "█";
const TRACK = " ";

/**
 * 滑块的高度与可移动范围。
 *
 * @param height 视口行数
 * @param total 内容总行数
 * @returns 滑块行数与最大起始行；内容不超视口时滑块占满视口、没有可移动范围
 */
export function scrollbarThumb(height: number, total: number): { readonly height: number; readonly maxTop: number } {
	if (total <= height) return { height: Math.max(0, height), maxTop: 0 };
	const size = Math.min(height, Math.max(1, Math.floor((height * height) / Math.max(1, total))));
	return { height: size, maxTop: Math.max(0, height - size) };
}

/**
 * 滚动条那一列。
 *
 * 调用方把它单独按坐标写到最右列，而不是拼在每行末尾：一行是否被终端换行取决于终端怎么
 * 算字符宽度，跟着内容走的那一列会被带到别处。
 *
 * @param theme 取 `scrollbar` 作为滑块颜色
 * @param height 视口行数
 * @param total 内容总行数
 * @param top 当前滚动位置
 * @returns 每行一个字符串，可直接作为定位单元写入
 */
export function scrollbarColumn(theme: Theme, height: number, total: number, top: number): readonly string[] {
	const blank = Array.from({ length: Math.max(0, height) }, () => " ");
	// 内容没有超出视口时没有可滚动的东西，整列留空，不画轨道和滑块
	if (total <= height) return blank;
	const thumb = scrollbarThumb(height, total);
	const maxScroll = Math.max(1, total - height);
	const thumbTop = Math.round((Math.min(Math.max(0, top), maxScroll) / maxScroll) * thumb.maxTop);
	return blank.map((_, row) =>
		row >= thumbTop && row < thumbTop + thumb.height
			? `${theme.scrollbar}${THUMB}${theme.reset}`
			: `${theme.scrollbar}${TRACK}${theme.reset}`,
	);
}

/**
 * 拖动滚动条：让滑块中心落在光标那一行，再换算成滚动量。
 *
 * 先按滑块自己的行坐标求它该停在哪，最后才换算成滚动量——直接拿整列高度线性换算的话，
 * 滑块只占其中一段、也只能移动一段，拖到哪都对不上光标。
 *
 * @param row 光标所在行（1 基）
 * @param height 视口行数
 * @param maxScroll 最大滚动量
 */
export function scrollTopForRow(row: number, height: number, maxScroll: number): number {
	if (maxScroll <= 0 || height <= 1) return 0;
	const thumb = scrollbarThumb(height, maxScroll + height);
	if (thumb.maxTop === 0) return 0;
	const top = Math.min(Math.max(0, row - 1 - Math.floor(thumb.height / 2)), thumb.maxTop);
	return Math.round((top / thumb.maxTop) * maxScroll);
}
