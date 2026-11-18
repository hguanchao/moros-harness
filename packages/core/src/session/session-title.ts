/**
 * 会话显示标题的派生规则。
 *
 * 标题不单独落盘，唯一来源是 `stream.jsonl`：`session.created.title` 只是默认值或显式
 * 命名，显示标题按优先级从事件流派生——显式命名 → 首条用户输入首行 → 未命名兜底。
 */

/** `SessionManager.create()` 未显式传 title 时写入的历史默认值，等价于「未命名」。 */
export const DEFAULT_SESSION_TITLE = "New session";
/** 没有任何可用文本时的兜底；与 TUI 的 UNTITLED_SESSION 文案保持一致。 */
const UNTITLED_SESSION_TITLE = "Untitled session";
/** 标题取首行并截到这个码位数，中文与 emoji 不会被从中间劈开。 */
export const SESSION_TITLE_LIMIT = 60;

/** 控制字符会弄乱 TUI 面板，统一换成空格并去掉首尾空白。 */
export function sanitizeSessionTitle(text: string): string {
	return text.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
}

/** 取第一行并截到上限，超出补省略号；按码位而不是 UTF-16 单元计算。 */
export function firstLine(text: string, limit = SESSION_TITLE_LIMIT): string {
	const line = text.split("\n", 1)[0] ?? "";
	const chars = Array.from(line);
	return chars.length > limit ? `${chars.slice(0, limit).join("")}…` : line;
}

/**
 * 从若干 JSONL 行里找首条 `user.input` 的文本。
 *
 * 列表视图只读头部窗口，这里刻意只 `JSON.parse` 并挑必要字段，不跑完整 EventSchema
 * 校验——损坏或截断的行跳过即可，不让一条坏行拖垮整个会话列表。
 */
export function firstUserTextFromLines(lines: readonly string[]): string | undefined {
	for (const line of lines) {
		if (line.length === 0) continue;
		try {
			const raw: unknown = JSON.parse(line);
			if (typeof raw !== "object" || raw === null) continue;
			const record = raw as { readonly type?: unknown; readonly payload?: unknown };
			if (record.type !== "user.input") continue;
			const payload = record.payload;
			if (typeof payload !== "object" || payload === null) continue;
			const text = (payload as { readonly text?: unknown }).text;
			if (typeof text === "string") return text;
		} catch {
			// 头部窗口可能正好切断一行，跳过继续找下一条 user.input
		}
	}
	return undefined;
}

/**
 * 派生显示标题：
 *
 * 1. `createdTitle` 非默认哨兵时视为显式命名（审查会话、fork、未来的 `--name`），优先保留；
 * 2. 否则取首条用户输入的首行（60 码位）；
 * 3. 都没有时回退 `Untitled session`。
 *
 * 手动改名已经实现（`session.renamed` 事件，优先级最高）；LLM 生成标题仍留待后续。
 * UI 只读 `meta.title`，不直接解析事件。
 */
export function resolveSessionTitle(createdTitle: string, firstUserText: string | undefined): string {
	const explicit = sanitizeSessionTitle(createdTitle);
	if (explicit.length > 0 && explicit !== DEFAULT_SESSION_TITLE) return explicit;
	if (firstUserText !== undefined) {
		const derived = sanitizeSessionTitle(firstLine(firstUserText));
		if (derived.length > 0) return derived;
	}
	return UNTITLED_SESSION_TITLE;
}
