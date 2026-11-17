/**
 * 斜杠命令清单与不可用说明。
 *
 * 命令描述是模型可见文本，一律英文；两份私有常量只在本段使用。
 */

import { NO_MODELS } from "#src/tui/app/copy/errors.ts";
import { STATUS } from "#src/tui/app/copy/status.ts";

/** 某能力在当前会话里整体不可用。 */
const NOT_AVAILABLE = "Not available in this session";

// ── 命令清单 ──────────────────────────────────────────────────────────────

/** 命令说明：能用的说清做什么，不能用的说清缺什么。 */
export const COMMAND_COPY: Readonly<Record<string, { readonly description: string; readonly unavailable: string }>> = {
	model: { description: "Choose the model for this session", unavailable: NO_MODELS },
	effort: { description: "Choose the reasoning effort for this session", unavailable: NO_MODELS },
	compact: { description: "Compact the conversation into a summary now", unavailable: NO_MODELS },
	plan: {
		description: "Plan in read-only mode, then approve to implement",
		unavailable: STATUS.planUnavailable,
	},
	session: { description: "Switch to another session in this project", unavailable: STATUS.sessionStorageUnavailable },
	export: {
		description: "Export this session as JSON, Markdown, or HTML",
		unavailable: STATUS.exportUnavailable,
	},
	review: {
		description: "Review current changes in a read-only pass",
		unavailable: STATUS.reviewUnavailable,
	},
	help: { description: "Show the commands and keys", unavailable: NOT_AVAILABLE },
	undo: {
		description: "Undo file changes from the last turn",
		unavailable: STATUS.checkpointsUnavailable,
	},
	skills: { description: "List the skills found on disk", unavailable: NOT_AVAILABLE },
	mcps: {
		description: "List MCP server connections and their tools",
		unavailable: "MCP isn't connected in this session",
	},
};

/** 取命令说明；缺条目时退回命令名，避免整行空白。 */
export function commandDescription(name: string, enabled: boolean): string {
	const copy = COMMAND_COPY[name];
	if (copy === undefined) return name;
	return enabled ? copy.description : copy.unavailable;
}
