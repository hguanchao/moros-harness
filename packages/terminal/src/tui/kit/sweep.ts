import { mixColor, graphemes, type Rgb } from "../term/index.ts";

/**
 * 扫光。
 *
 * 运行中的状态行用一道来回移动的光表示「还在动」。按字素簇逐个着色：emoji 的 ZWJ 序列
 * 与修饰符必须整体处理，拆开后终端会画成多个字形。
 */

/** 一帧动画的原料：转圈字符与扫光相位，由调用方按刷新帧推进。 */
export interface AnimationFrame {
	readonly spinner: string;
	readonly sweepPhase: number;
}

/** 扫光带的半径（字符数）：再大就会把整行一起提亮，失去「一道光」的观感。 */
const SWEEP_RADIUS = 6;

/**
 * 按相位给每个字符着色：以 `phase` 位置为中心，向两侧线性衰减到基色，中心到达高亮色。
 *
 * @param text 要着色的文字
 * @param phase 0–1 的相位；调用方按帧推进
 * @param base 暗部颜色
 * @param highlight 亮点颜色
 * @param radius 光带半径
 */
export function swept(text: string, phase: number, base: Rgb, highlight: Rgb, radius: number = SWEEP_RADIUS): string {
	const chars = graphemes(text);
	const center = -radius + phase * (chars.length + radius * 2);
	let output = "";
	for (let index = 0; index < chars.length; index += 1) {
		const color = mixColor(base, highlight, 1 - Math.abs(index - center) / radius);
		output += `\x1b[38;2;${color.r};${color.g};${color.b}m${chars[index]}`;
	}
	return `${output}\x1b[0m`;
}
