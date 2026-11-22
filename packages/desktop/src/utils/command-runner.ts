/**
 * 桌面端命令执行分派：把命令名映射到 Composer 提供的处理器。
 *
 * 真正的 IPC / picker / confirm 调用由 Composer 以回调形式提供，本模块只负责分派与
 * 参数解析，保持可测试；命令清单见 command-list.ts。
 */

import { findDesktopCommand } from "./command-list.ts";

/** 命令处理器集合；键为命令名。Composer 实现具体行为。 */
export interface CommandHandlers {
	readonly compact: (args: string) => void | Promise<void>;
	readonly review: (args: string) => void | Promise<void>;
}

/**
 * 执行命令；返回是否命中并执行。
 * 未知命令或清单中未提供的命令返回 false。
 */
export async function runDesktopCommand(name: string, args: string, handlers: CommandHandlers): Promise<boolean> {
	if (findDesktopCommand(name) === undefined) return false;
	const handler = (handlers as unknown as Record<string, ((args: string) => void | Promise<void>) | undefined>)[name];
	if (handler === undefined) return false;
	await handler(args);
	return true;
}

/** 把命令输入按首个空格拆成命令名与参数：`model deepseek/v4` → ["model", "deepseek/v4"]。 */
export function splitCommand(input: string): { name: string; args: string } {
	const trimmed = input.trim();
	const space = trimmed.search(/\s/);
	if (space < 0) return { name: trimmed, args: "" };
	return { name: trimmed.slice(0, space), args: trimmed.slice(space + 1).trim() };
}
