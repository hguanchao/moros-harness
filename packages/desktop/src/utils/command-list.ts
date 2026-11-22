/**
 * 桌面端斜杠命令清单（静态数据 + 中文描述）。
 *
 * 覆盖终端 11 条内置命令中桌面有对应 IPC 能力的核心命令；
 * `/skills` `/mcps` `/help` 依赖 TUI 专属页面，桌面首批不提供。
 */

export interface DesktopCommand {
	readonly name: string;
	readonly description: string;
	/** 无参时是否需要打开二级选择器（model/effort/approval/session）。 */
	readonly opensPicker: boolean;
}

/** 命令清单；顺序即补全列表默认顺序。 */
export const DESKTOP_COMMANDS: readonly DesktopCommand[] = [
	{ name: "model", description: "选择本会话模型", opensPicker: true },
	{ name: "effort", description: "选择推理强度", opensPicker: true },
	{ name: "approval", description: "切换审批档位（ask / auto / yolo）", opensPicker: true },
	{ name: "plan", description: "进入计划模式", opensPicker: false },
	{ name: "compact", description: "立即压缩上下文", opensPicker: false },
	{ name: "undo", description: "回滚最近一步文件改动", opensPicker: false },
	{ name: "review", description: "审查本轮改动", opensPicker: false },
	{ name: "export", description: "导出当前会话", opensPicker: false },
	{ name: "session", description: "切换会话 / fork 当前会话", opensPicker: true },
];

/** 按命令名查找（大小写不敏感）。 */
export function findDesktopCommand(name: string): DesktopCommand | undefined {
	const needle = name.toLowerCase();
	return DESKTOP_COMMANDS.find((command) => command.name === needle);
}
