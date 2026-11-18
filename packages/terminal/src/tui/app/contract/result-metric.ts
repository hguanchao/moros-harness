/**
 * 折叠指标：当前工具结果是文本而非结构化 details，
 * 只有 glob/grep 能从行数得到可信计数，其余返回 undefined 避免猜测。
 */
export function resultMetric(tool: string, _details: unknown, content: string): string | undefined {
	if (tool !== "glob" && tool !== "grep") return undefined;
	if (/^No (files|matches)/i.test(content)) return "0";
	// 截断/跳过提示行不是命中项；只认这两种固定形状，文件名本身可以以 `[` 开头
	const count = content
		.split("\n")
		.filter((line) => line.length > 0 && !/^\[(?:truncated at \d+|.+ skipped\])/.test(line)).length;
	return count > 0 ? `${count} ${tool === "glob" ? "files" : "matches"}` : undefined;
}
