import { stripVTControlCharacters } from "node:util";

/**
 * 外部文本的单行清洗。
 *
 * Markdown 的输入来自模型与文件，可能带换行、制表符与转义序列。摘要只占一行：换行与制表
 * 折成空格，控制字符剥掉，否则会把排版和终端状态一起弄乱。
 */
export function sanitizeLine(value: string): string {
	return stripVTControlCharacters(value)
		.replace(/[\r\n\t]+/g, " ")
		.replace(/[\u0000-\u001f\u007f]/g, "");
}

/** 多行文本逐行清洗，换行保留。 */
export function sanitizeDetail(text: string): string {
	return text.split("\n").map(sanitizeLine).join("\n");
}
