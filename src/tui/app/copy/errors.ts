/**
 * 错误提示与命令参数文案
 *
 * 界面文案按用途拆分，`copy.ts` 是唯一的对外入口；这里只放本段自己的词与句。
 */

// ── 错误与命令参数 ────────────────────────────────────────────────────────

/** 未知命令。 */
export function unknownCommand(name: string): string {
	return `Unknown command: ${name}`;
}

/** 未知模型：给出可用入口，别让人去翻文档。 */
export function unknownModel(target: string): string {
	return `Error: unknown model: ${target} · run /model to choose from the list`;
}

/** 未知思考等级：顺带列出可选值。 */
export function unknownEffort(target: string, levels: readonly string[]): string {
	return `Error: unknown effort: ${target} · available: ${levels.join(", ")}`;
}

/** 没有可用模型：说明缺什么、去哪补。 */
export const NO_MODELS = "No models configured · add one to providers.json";

/** 失败一律以 `Error:` 开头，后面用 `·` 接一句人话说明失败的动作。 */
export function failure(action: string, error: string): string {
	return `Error: ${action} failed · ${error}`;
}

/** 配置不可用时的对话流错误行；reason 是启动阶段静默记下的具体原因。 */
export function configurationUnavailable(reason: string): string {
	return `Configuration unavailable · ${reason}`;
}

/** 一串失败句式里的动作名，集中在这里，避免同一个动作有三种拼法。 */
export const FAILURE_ACTIONS = {
	undo: "undo",
	trust: "trust",
	modelSwitch: "model switch",
	effortSet: "effort change",
	planSwitch: "plan mode switch",
	sessionFork: "session fork",
	approvalSwitch: "approval switch",
	listFiles: "file listing",
	sessionSwitch: "session switch",
	sessionsList: "session listing",
	mcpReconnect: "MCP reconnect",
	mcpHealthCheck: "MCP health check",
	export: "export",
	review: "review",
} as const;
