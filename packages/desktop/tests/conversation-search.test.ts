import { describe, expect, it } from "vitest";

import type { EventRecord } from "@moros/core/events/schema.ts";
import { searchEvents } from "../src/components/ConversationSearch.tsx";

function userInput(seq: number, text: string): EventRecord {
	return { seq, ts: "2026-11-21T16:10:00.000Z", type: "user.input", payload: { text } };
}

function response(seq: number, text: string, reasoning?: string): EventRecord {
	return {
		seq,
		ts: "2026-11-21T16:10:01.000Z",
		type: "llm.response",
		payload: {
			text,
			...(reasoning === undefined ? {} : { reasoning }),
			toolCalls: [],
			usage: { inputTokens: 0, outputTokens: 0 },
			stopReason: "done",
		},
	};
}

const events: EventRecord[] = [
	userInput(1, "帮我写一个排序函数"),
	response(2, "好的，这是快速排序的实现"),
	userInput(3, "改成归并排序"),
	response(4, "已改为归并排序", "用户想要 merge sort"),
];

describe("searchEvents 会话内搜索", () => {
	it("空查询返回空结果", () => {
		expect(searchEvents(events, "")).toEqual([]);
		expect(searchEvents(events, "   ")).toEqual([]);
	});

	it("大小写不敏感地匹配用户与助手文本", () => {
		const hits = searchEvents(events, "排序");
		expect(hits.length).toBe(4);
		expect(hits.every((hit) => hit.snippet.includes("排序"))).toBe(true);
	});

	it("命中助手正文时 turnKey 指向所在回合的 user.input seq", () => {
		const hits = searchEvents(events, "归并");
		expect(hits.length).toBeGreaterThan(0);
		// 第 3、4 条事件属于 turn-3
		expect(hits.every((hit) => hit.turnKey === "turn-3" || hit.turnKey === "turn-1")).toBe(true);
		expect(hits.some((hit) => hit.turnKey === "turn-3")).toBe(true);
	});

	it("能搜索推理链文本", () => {
		const hits = searchEvents(events, "merge sort");
		expect(hits.some((hit) => hit.seq === 4)).toBe(true);
	});

	it("记录匹配片段在摘要中的位置用于高亮", () => {
		const hits = searchEvents(events, "排序");
		const first = hits[0]!;
		expect(first.matchStart).toBeGreaterThanOrEqual(0);
		expect(first.matchEnd).toBeGreaterThan(first.matchStart);
		expect(first.snippet.slice(first.matchStart, first.matchEnd)).toBe("排序");
	});

	it("无匹配返回空数组", () => {
		expect(searchEvents(events, "完全不存在的词")).toEqual([]);
	});
});
