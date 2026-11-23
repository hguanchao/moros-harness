/**
 * 设置页 MCP 表单的纯解析：把多行文本转成 server 草稿字段。
 * 零 UI/IO 依赖，便于单测；错误用中文描述，可直接显示在表单里。
 */

/** 解析逐行参数（每行一个参数，忽略空行与 # 注释行）。 */
export function parseArgumentLines(text: string): readonly string[] {
	return text
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line.length > 0 && !line.startsWith("#"));
}

/**
 * 解析 KEY=VALUE 行（环境变量 / 请求头）。
 * 值里允许出现 `=`，按第一个等号切分；空行与 # 注释行忽略。
 */
export function parseKeyValueLines(
	text: string,
):
	| { readonly ok: true; readonly value: Readonly<Record<string, string>> }
	| { readonly ok: false; readonly error: string } {
	const result: Record<string, string> = {};
	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (line.length === 0 || line.startsWith("#")) continue;
		const separator = line.indexOf("=");
		if (separator <= 0) return { ok: false, error: `无效行（应为 KEY=VALUE）：${line}` };
		const key = line.slice(0, separator).trim();
		const value = line.slice(separator + 1).trim();
		if (key.length === 0) return { ok: false, error: `键不能为空：${line}` };
		if (Object.prototype.hasOwnProperty.call(result, key)) return { ok: false, error: `重复的键：${key}` };
		result[key] = value;
	}
	return { ok: true, value: result };
}

/** 把键值对象还原成表单里的 KEY=VALUE 多行文本（构造时原样回填）。 */
export function formatKeyValueLines(pairs: Readonly<Record<string, string>> | undefined): string {
	if (pairs === undefined) return "";
	return Object.entries(pairs)
		.map(([key, value]) => `${key}=${value}`)
		.join("\n");
}
