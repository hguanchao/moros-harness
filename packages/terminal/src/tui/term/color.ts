import type { Rgb } from "./theme.ts";

/**
 * 颜色运算。
 *
 * 只有插值一种：动画的每一种效果（扫光、渐变）都是「基色与高亮色之间取一个位置」，
 * 与其让调用方各写一遍浮点运算，不如把唯一的算法留在这里。
 */

/**
 * 在两个 24 位色之间线性插值。
 *
 * @param base 起始色，`intensity` 为 0 时的结果
 * @param highlight 目标色，`intensity` 为 1 时的结果
 * @param intensity 插值位置，超出 0–1 时按端点夹取
 * @returns 逐通道四舍五入后的颜色
 */
export function mixColor(base: Rgb, highlight: Rgb, intensity: number): Rgb {
	const weight = Math.min(1, Math.max(0, intensity));
	return {
		r: Math.round(base.r + (highlight.r - base.r) * weight),
		g: Math.round(base.g + (highlight.g - base.g) * weight),
		b: Math.round(base.b + (highlight.b - base.b) * weight),
	};
}
