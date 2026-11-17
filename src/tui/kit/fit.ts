import { stripVTControlCharacters } from "node:util";

import { displayWidth, truncateToWidth } from "#src/tui/term/index.ts";
import { visibleWidth } from "#src/tui/kit/layout.ts";

/**
 * 行宽归一。
 *
 * 每个节点画出来的行必须正好等于自己的宽度，父容器才能按坐标拼接。溢出时裁掉，不足时补
 * 空格——这两件事只在这里做一次，别在各个组件里各写一遍。
 */

/** 补到指定行数与列宽，多出的部分裁掉。 */
export function fit(lines: readonly string[], width: number, height: number): readonly string[] {
	const safeWidth = Math.max(0, width);
	const rows = lines.map((line) => fitLine(line, safeWidth));
	while (rows.length < height) rows.push(" ".repeat(safeWidth));
	return rows.slice(0, Math.max(0, height));
}

/** 单行补白或裁剪到给定列宽。 */
export function fitLine(line: string, width: number): string {
	const safeWidth = Math.max(0, width);
	const visible = visibleWidth(line);
	if (visible > safeWidth) return clip(line, safeWidth);
	return line + " ".repeat(safeWidth - visible);
}

/**
 * 裁到指定可见宽度。
 *
 * 溢出时退化成「先剥转义序列再截断」：保留前缀的颜色需要按字素追踪 SGR 状态，代价远大于
 * 收益——带色的行约定是各行不超过分配宽度，这里是兜底而不是常规路径。
 */
export function clip(line: string, width: number): string {
	if (width <= 0) return "";
	const plain = stripVTControlCharacters(line);
	if (displayWidth(plain) <= width) return line;
	return truncateToWidth(plain, width);
}
