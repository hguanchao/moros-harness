import { actionLines, pageTitle } from "./chrome.ts";
import { displayWidth, sanitizeForDisplay, wrapText } from "../../term/index.ts";
import { THEME } from "../render/theme.ts";
import { ACTIONS, PAGE, PANEL } from "../copy/index.ts";
import type { ViewerContent } from "../runtime/types.ts";

/**
 * 长内容整屏查看页。
 *
 * 对话流里的工具输出、命令详情、思考与提示保持原有折叠/预览；这里只负责把同一份原文
 * 按当前宽度重排后完整铺开。页面沿用整屏页的滚动与 Esc 返回，不改变对话流本身。
 */

/** 底部动作条：一条分隔线加一行按键提示。 */
export const VIEWER_ACTION_HEIGHT = 2;

export function viewerPageLines(content: ViewerContent, width: number): readonly string[] {
	const columns = Math.max(0, width);
	const lines: string[] = [pageTitle(`${PAGE.viewerTitlePrefix}${content.title}`, columns), " ".repeat(columns)];

	const text = sanitizeForDisplay(content.text.replace(/\r\n?/g, "\n").replace(/\t/g, "    "));
	if (text.trim().length === 0) {
		lines.push(subtleLine(PANEL.noContent, columns));
		return lines;
	}

	// wrapText 会再做一次幂等的 sanitize 并按 \n 硬断行；空行保持纯 ""，其余行补齐到整宽
	for (const raw of wrapText(text, columns)) {
		if (raw.length === 0) {
			lines.push("");
			continue;
		}
		const padding = " ".repeat(Math.max(0, columns - displayWidth(raw)));
		lines.push(`${THEME.textSecondary}${raw}${THEME.reset}${padding}`);
	}
	return lines;
}

export function viewerActionLines(width: number): readonly string[] {
	return actionLines(width, [
		["Esc", ACTIONS.close, THEME.textSubtle],
		["↑/↓", ACTIONS.scroll, THEME.accent],
		["PgUp/PgDn", ACTIONS.page, THEME.accent],
	]);
}

function subtleLine(text: string, width: number): string {
	const visible = text.slice(0, Math.max(0, width));
	return `${THEME.textSubtle}${visible}${THEME.reset}${" ".repeat(Math.max(0, width - displayWidth(visible)))}`;
}
