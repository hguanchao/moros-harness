/**
 * 桌面端斜杠命令清单（静态数据 + 中文描述）。
 *
 * 只保留桌面端没有专门 UI 入口的命令：context 压缩与改动审查。
 * 其余操作（模型/审批切换、撤销、导出、会话切换等）在桌面端都有对应控件或页面。
 */

export interface DesktopCommand {
	readonly name: string;
	readonly description: string;
}

/** 命令清单；顺序即补全列表默认顺序。 */
export const DESKTOP_COMMANDS: readonly DesktopCommand[] = [
	{ name: "compact", description: "立即压缩上下文" },
	{ name: "review", description: "审查本轮改动" },
];

/** 按命令名查找（大小写不敏感）。 */
export function findDesktopCommand(name: string): DesktopCommand | undefined {
	const needle = name.toLowerCase();
	return DESKTOP_COMMANDS.find((command) => command.name === needle);
}
