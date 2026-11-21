import type { JSX } from "react";

/**
 * 骨架屏占位条：加载期间模拟文本/列表行，流光动画暗示内容正在填充。
 * 只负责视觉占位、不参与无障碍语义，调用方包裹时可加 aria-hidden。
 */
export function SkeletonLine({
	width = "100%",
	height = 12,
}: {
	/** CSS 宽度，用于模拟不同长度的文本。 */
	readonly width?: string;
	/** 占位条高度（px）。 */
	readonly height?: number;
}): JSX.Element {
	return <span className="skeleton-line" aria-hidden="true" style={{ width, height }} />;
}
