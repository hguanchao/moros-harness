import type { CommandMenuItem } from "#src/tui/app/panel/command-menu.ts";
import type { TuiOptions } from "#src/tui/app/options.ts";
import { commandDescription } from "#src/tui/app/copy/index.ts";

/**
 * 一轮进行中也能执行的命令。
 *
 * 它们只影响界面或下一轮，不碰正在跑的那一轮；内置命令只保留帮助与模型选择。
 */
export const TURN_SAFE_COMMANDS: ReadonlySet<string> = new Set(["help", "model", "effort"]);

/**
 * 命令补全列表：模型、推理强度、会话、计划、审查、压缩、撤销、导出、技能、MCP 与帮助。
 * 数据源缺席的能力仍然显示，但标成不可执行；隐藏项只在完整输入时执行。
 */
export function createBuiltinCommands(options: TuiOptions): readonly CommandMenuItem[] {
	const entries: readonly { readonly name: string; readonly enabled: boolean; readonly hidden?: boolean }[] = [
		{ name: "model", enabled: options.modelMenu !== undefined },
		{ name: "effort", enabled: options.effortMenu !== undefined },
		{ name: "plan", enabled: options.planMode !== undefined },
		{ name: "session", enabled: options.sessionMenu !== undefined },
		{ name: "review", enabled: options.review !== undefined },
		{ name: "compact", enabled: options.agent?.compact !== undefined },
		{ name: "undo", enabled: options.checkpoints !== undefined },
		{ name: "export", enabled: options.exportSession !== undefined },
		{ name: "skills", enabled: options.skills !== undefined },
		{ name: "mcps", enabled: hasMcpServers(options) },
		{ name: "help", enabled: true },
	];
	return entries.map((entry) => ({
		name: entry.name,
		description: commandDescription(entry.name, entry.enabled),
		enabled: entry.enabled,
		...(entry.hidden === true ? { hidden: true } : {}),
	}));
}

/**
 * MCP 客户端尚未接入：adapter 注入的是恒空数据源。仅判断「数据源存在」会把 /mcps
 * 标成可用，点进去却只有空页；接入真实服务器列表后这里会自动恢复可用。
 */
function hasMcpServers(options: TuiOptions): boolean {
	const source = options.mcpServers;
	if (source === undefined) return false;
	try {
		return source().length > 0;
	} catch {
		return false;
	}
}

/** 内置命令 + 当前插件命令；同名时内置优先，插件不能顶掉 /model 这类入口。 */
export function mergeCommands(
	builtin: readonly CommandMenuItem[],
	plugin: readonly CommandMenuItem[],
): readonly CommandMenuItem[] {
	const names = new Set(builtin.map((command) => command.name));
	return [...builtin, ...plugin.filter((command) => !names.has(command.name))];
}

/** 输入开头的命令名；不是斜杠命令时为空串。 */
export function commandNameOf(message: string): string {
	return message.startsWith("/") ? (message.slice(1).split(/\s/, 1)[0] ?? "") : "";
}

/** 按命令名查找；命令名之后的文字是参数。 */
export function findCommand(message: string, commands: readonly CommandMenuItem[]): CommandMenuItem | undefined {
	if (!message.startsWith("/")) return undefined;
	return commands.find((item) => item.name === commandNameOf(message));
}

export function commandArgs(message: string, name: string): string {
	return message.slice(name.length + 1).trim();
}
