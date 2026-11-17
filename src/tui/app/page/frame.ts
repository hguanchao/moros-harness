import { pageContentLines, type PageProps } from "#src/tui/kit/index.ts";
import { ACTIONS, KEY_HINTS, PAGE, scanningDirectory } from "#src/tui/app/copy/index.ts";
import type { CommandMenuItem } from "#src/tui/app/panel/command-menu.ts";
import { THEME } from "#src/tui/app/render/theme.ts";
import { actionLines } from "#src/tui/app/page/chrome.ts";

/**
 * 整屏页的排版。
 *
 * 标题、分节、条目与脚注的排法在 `src/tui/kit` 的 `page` 里（表格与卡片两种条目布局、
 * 说明折行、首句强调）。这里只负责把本应用的文案与数据装成页面，以及把动作条钉在底部。
 *
 * 页面内容按宽度排好版交给调用方，滚动与视口裁切由 renderPage 负责——调用方不必知道内容有
 * 多长，只管把视口高度给它。
 */

/** 一条条目。 */
export interface PageEntry {
	/** 左列的名称 */
	readonly name: string;
	readonly description: string;
	/** 另起一行的小字；用来放位置这类不该挤进说明列的信息 */
	readonly note?: string;
	/** 当前选中的条目；只有带操作的可选清单会设置 */
	readonly selected?: boolean;
}

/** 技能页的条目：多一个来源，用来分节。 */
export interface SkillPageEntry extends PageEntry {
	readonly scope: "user" | "project";
}

/** 命令之外的固定内容：键位与说明都来自文案模块，帮助页不再手写一份。 */
const KEY_ENTRIES: readonly PageEntry[] = KEY_HINTS.map((hint) => ({
	name: hint.keys,
	description: hint.description,
}));

/** 命令清单由调用方传进来，与补全面板共用同一份，新增命令时不会漏。 */
export function helpPageLines(width: number, commands: readonly CommandMenuItem[]): readonly string[] {
	return render(
		{
			title: PAGE.helpTitle,
			sections: [
				{
					title: PAGE.commandsSection,
					entries: commands.map((command) => ({ name: `/${command.name}`, description: command.description })),
				},
				{ title: PAGE.keysSection, entries: KEY_ENTRIES },
			],
			footnotes: [PAGE.helpFootnote],
		},
		width,
	);
}

/** 技能清单；目录由调用方给出，脚注要照着它说清楚都扫了哪里。 */
export function skillsPageLines(
	width: number,
	skills: readonly SkillPageEntry[],
	directories: readonly string[],
): readonly string[] {
	const user = skills.filter((skill) => skill.scope === "user");
	const project = skills.filter((skill) => skill.scope === "project");
	const sections: PageProps["sections"] =
		skills.length === 0
			? [{ title: PAGE.skillsSection, entries: [], empty: PAGE.noSkills }]
			: [
					...(user.length === 0 ? [] : [{ title: PAGE.userSkillsSection, entries: user, layout: "card" as const }]),
					...(project.length === 0
						? []
						: [{ title: PAGE.projectSkillsSection, entries: project, layout: "card" as const }]),
				];
	return render(
		{
			title: PAGE.skillsTitle,
			sections,
			footnotes: [...directories.map((directory) => scanningDirectory(directory)), PAGE.skillsEffectNote],
		},
		width,
	);
}

/** MCP 连接清单；连不上的要把原因带出来，否则使用者只知道「没连上」。 */
export function mcpsPageLines(
	width: number,
	servers: readonly PageEntry[],
	cursor = 0,
	status?: string,
	tone?: "notice" | "warning" | "error",
): readonly string[] {
	const entries = servers.map((entry, index) => ({ ...entry, selected: index === cursor }));
	return render(
		{
			title: PAGE.mcpsTitle,
			...(status === undefined || status.length === 0
				? {}
				: { status: { text: status, ...(tone === undefined ? {} : { tone }) } }),
			sections: [{ title: PAGE.serversSection, entries, empty: PAGE.noMcpServers }],
			footnotes: [PAGE.mcpConfigNote],
		},
		width,
	);
}

/** MCP 页底部的操作条：选中一个 server 后重连，或检查全部连接。 */
export const MCP_ACTION_HEIGHT = 2;

export function mcpsActionLines(width: number): readonly string[] {
	return actionLines(width, [
		["↑↓", ACTIONS.select, THEME.textSubtle],
		["r", ACTIONS.reconnect, THEME.textSubtle],
		["h", ACTIONS.healthCheck, THEME.textSubtle],
		["Esc", ACTIONS.close, THEME.textSubtle],
	]);
}

/** 把页面装成行；配色由本应用注入。 */
function render(props: PageProps, width: number): readonly string[] {
	return pageContentLines(props, width, THEME);
}

/**
 * 取视口内的行。
 *
 * 返回的行数恰好等于 height，内容不足时补空行；scrollTop 超出范围时收敛到两端，因此内容
 * 整体放得下时它恒为 0。
 */
export function renderPage(lines: readonly string[], height: number, scrollTop: number): readonly string[] {
	const rows = Math.max(0, height);
	if (rows === 0) return [];

	const top = Math.min(Math.max(0, scrollTop), Math.max(0, lines.length - rows));
	return Array.from({ length: rows }, (_, index) => lines[top + index] ?? "");
}

/**
 * 带固定动作条的整屏页：正文按剩余高度滚动，动作条始终停在底部。
 *
 * 计划、检查点、作业与沙箱页共用同一套几何。高度分配只在这里算一次，动作条变化时
 * 各页不会各自偏移。
 */
export function framedPage(
	content: readonly string[],
	actions: readonly string[],
	height: number,
	scrollTop: number,
): readonly string[] {
	const rows = Math.max(0, height);
	const contentHeight = Math.max(0, rows - actions.length);
	return [...renderPage(content, contentHeight, scrollTop), ...actions].slice(0, rows);
}
