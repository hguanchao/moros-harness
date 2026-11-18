import type { TuiState } from "./types.ts";

/**
 * 启动警告与平台说明。
 *
 * 启动时就知道的事与运行期 Core 诊断合成一段交给对话流顶部；平台限制的沙箱说明
 * 与装载问题不是可修复的配置问题，模型切换后仍然保留。运行期诊断单独成段，状态行的
 * 自动清除不会把完整文本一起带走。
 */
export function noticeText(state: TuiState): string | undefined {
	const runtime = state.runtimeWarnings.length > 0 ? state.runtimeWarnings.join("\n") : undefined;
	const parts = [state.sandboxNotice, state.startupProblems, state.activeWarning, runtime].filter(
		(part): part is string => part !== undefined && part.length > 0,
	);
	return parts.length === 0 ? undefined : parts.join("\n\n");
}
