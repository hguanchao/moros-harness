/**
 * 消息操作栏的纯函数：引用文本生成与反馈状态还原。
 *
 * 反馈状态以会话事件流为唯一事实源——`message.feedback` 事件带 targetSeq 指向
 * 被评价的 llm.response 事件，按 seq 取最后一条即为当前评价；"none" 表示撤销。
 */

import type { EventRecord } from "@moros/core/events/schema.ts";

/** 点赞/点踩评价；none 表示撤销。 */
export type FeedbackRating = "up" | "down";

/**
 * 把消息正文格式化为 Markdown 引用块：每行加 `> ` 前缀，空行保留为 `>`。
 * 这样粘贴回输入框后仍是合法 Markdown，且便于在引用下继续输入。
 */
export function buildQuote(text: string): string {
	// 纯空白/空内容不生成引用，避免输入框出现一串空的 `>` 行。
	if (text.trim().length === 0) return "";
	const lines = text.replace(/\r\n/g, "\n").split("\n");
	const quoted = lines.map((line) => (line.length === 0 ? ">" : `> ${line}`));
	return `${quoted.join("\n")}\n\n`;
}

/**
 * 从事件流还原每条被评价消息的当前反馈。
 *
 * 同一 targetSeq 可能有多条 `message.feedback`（反复切换），按事件出现顺序取最后一条；
 * rating="none" 表示撤销，结果里不保留该 targetSeq。
 */
export function resolveFeedbacks(events: readonly EventRecord[]): Readonly<Record<number, FeedbackRating>> {
	const result: Record<number, FeedbackRating> = {};
	for (const event of events) {
		if (event.type !== "message.feedback") continue;
		const { targetSeq, rating } = event.payload;
		if (rating === "none") delete result[targetSeq];
		else result[targetSeq] = rating;
	}
	return result;
}
