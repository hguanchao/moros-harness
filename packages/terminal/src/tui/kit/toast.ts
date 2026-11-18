import { displayWidth, fitToWidth, type Theme } from "../term/index.ts";
import { el, type ComponentProps, type Node } from "./element.ts";

/**
 * 短提示（Toast）：一行、短暂、不占布局高度。
 *
 * 生命周期由调用方的计时器管，组件只负责配色、截断与对齐。它常贴在状态行右侧或浮在
 * 内容上方；两种位置由 `align` 决定，都不改变行宽。
 */

export type ToastTone = "info" | "success" | "warning" | "error";

export interface ToastProps {
	readonly text: string;
	readonly tone?: ToastTone;
	readonly align?: "left" | "right" | "center";
}

/** 提示文字的带色片段，不带补白。 */
export function toastText(props: ToastProps, theme: Theme): string {
	const color =
		props.tone === "success"
			? theme.success
			: props.tone === "warning"
				? theme.warning
				: props.tone === "error"
					? theme.error
					: theme.accent;
	return `${color}${props.text}${theme.reset}`;
}

/** 一整行提示：对齐后补满宽度，始终只有一个可见文字段。 */
export function toastLine(props: ToastProps, width: number, theme: Theme): string {
	const columns = Math.max(0, width);
	const text = fitToWidth(props.text, Math.max(0, columns - 2));
	const room = Math.max(0, columns - displayWidth(text));
	const align = props.align ?? "right";
	const left = align === "center" ? Math.floor(room / 2) : align === "left" ? 0 : room;
	return `${" ".repeat(left)}${toastText({ ...props, text }, theme)}${" ".repeat(room - left)}`;
}

/** 提示组件：产出一行文本。 */
export function Toast(props: ToastProps & ComponentProps): Node {
	const { theme } = props;
	return el("raw", {
		lines: [toastText({ text: props.text, ...(props.tone === undefined ? {} : { tone: props.tone }) }, theme)],
	});
}
