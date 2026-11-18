import { sanitizeDetail } from "./describe.ts";

export type ResultDetailKind = "text" | "file" | "diff";

/** 工具结果展开行里显示的内容。 */
export interface ResultDetail {
	readonly text: string;
	readonly kind: ResultDetailKind;
}

/**
 * Moros Harness 工具结果均为纯文本，这里按工具类型做最简折叠预览；
 * 结构化 details 当前未提供，因此不解析行号或 diff 元数据。
 */
export function resultDetail(
	tool: string,
	content: string | undefined,
	_details?: unknown,
	_fileName?: string,
): ResultDetail | undefined {
	if (content === undefined || content.length === 0) return undefined;
	if (tool === "read" || tool === "write" || tool === "edit") {
		return { text: sanitizeDetail(content), kind: tool === "edit" ? "diff" : "file" };
	}
	return undefined;
}
