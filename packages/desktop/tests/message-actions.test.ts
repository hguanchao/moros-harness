import { describe, expect, it } from "vitest";

import type { EventRecord } from "@moros/core/events/schema.ts";
import { buildQuote, resolveFeedbacks } from "../src/utils/message-actions.ts";

function feedback(seq: number, targetSeq: number, rating: "up" | "down" | "none"): EventRecord {
	return {
		type: "message.feedback",
		seq,
		ts: "2026-01-01T00:00:00.000Z",
		payload: { targetSeq, rating },
	};
}

describe("buildQuote 引用文本", () => {
	it("每行加 > 前缀，末尾留两个换行便于继续输入", () => {
		expect(buildQuote("第一行\n第二行")).toBe("> 第一行\n> 第二行\n\n");
	});

	it("空行保留为单个 >", () => {
		expect(buildQuote("a\n\nb")).toBe("> a\n>\n> b\n\n");
	});

	it("统一 CRLF 为 LF", () => {
		expect(buildQuote("a\r\nb")).toBe("> a\n> b\n\n");
	});

	it("纯空白内容不生成引用（避免空 > 行）", () => {
		expect(buildQuote("")).toBe("");
		expect(buildQuote("\n\n")).toBe("");
		expect(buildQuote("   \n  ")).toBe("");
	});
});

describe("resolveFeedbacks 反馈还原", () => {
	it("同一 targetSeq 取最后一条评价", () => {
		const events = [feedback(1, 10, "up"), feedback(2, 10, "down")];
		expect(resolveFeedbacks(events)).toEqual({ 10: "down" });
	});

	it("none 撤销此前评价", () => {
		const events = [feedback(1, 10, "up"), feedback(2, 10, "none")];
		expect(resolveFeedbacks(events)).toEqual({});
	});

	it("不同 targetSeq 互不干扰", () => {
		const events = [feedback(1, 10, "up"), feedback(2, 11, "down")];
		expect(resolveFeedbacks(events)).toEqual({ 10: "up", 11: "down" });
	});

	it("忽略非反馈事件", () => {
		const other = {
			type: "mode.switched",
			seq: 1,
			ts: "2026-01-01T00:00:00.000Z",
			payload: { from: "standard", to: "creator" },
		} as EventRecord;
		expect(resolveFeedbacks([other])).toEqual({});
	});
});
