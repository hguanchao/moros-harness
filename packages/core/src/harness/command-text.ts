/**
 * Shell 命令文本的轻量解析：切段与分词。
 *
 * 只求稳定与保守，不求覆盖全部 shell 语法。风险分级与放行作用域都只需要回答
 * 「这条命令由哪几段动作组成、每段的动词是什么」；子 shell、变量展开、heredoc
 * 一律当作普通文本，拆不出来时由调用方退回整条命令处理。
 */

/** 按引号外的 `;`、`&`、`|`、换行切段；引号字符保留下来，交给 tokenizeCommandSegment 去壳。 */
export function splitCommandSegments(command: string): string[] {
	const segments: string[] = [];
	let current = "";
	let quote: '"' | "'" | undefined;
	for (const char of command) {
		if (quote !== undefined) {
			current += char;
			if (char === quote) quote = undefined;
			continue;
		}
		if (char === '"' || char === "'") {
			quote = char;
			current += char;
			continue;
		}
		if (char === ";" || char === "&" || char === "|" || char === "\n" || char === "\r") {
			segments.push(current);
			current = "";
			continue;
		}
		current += char;
	}
	segments.push(current);
	return segments;
}

/** 引号外按空白切 token；引号本身不进入 token。 */
export function tokenizeCommandSegment(segment: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let quote: '"' | "'" | undefined;
	for (const char of segment) {
		if (quote !== undefined) {
			if (char === quote) quote = undefined;
			else current += char;
			continue;
		}
		if (char === '"' || char === "'") {
			quote = char;
			continue;
		}
		if (/\s/.test(char)) {
			if (current.length > 0) tokens.push(current);
			current = "";
			continue;
		}
		current += char;
	}
	if (current.length > 0) tokens.push(current);
	return tokens;
}
