/**
 * TUI 内置的 Moros Harness 斜杠命令。
 *
 * 环境诊断、配置回显、回滚、回放与审计分别由 CLI、Core 快捷键或 Core 接口承担；
 * 会话列表由内置 `/session` 面板提供，会话导出由内置 `/export` 提供。
 * 命令清单单独成模块，便于测试与补全共用。
 */
export const PLUGIN_COMMANDS: readonly (readonly [name: string, description: string])[] = [
	["new", "Create and switch to a new session"],
	["diff", "Preview a file change (/diff <seq>)"],
];
