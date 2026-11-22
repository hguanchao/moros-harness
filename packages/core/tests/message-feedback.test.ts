import { describe, expect, it } from "vitest";

import { EventSchema, EVENT_TYPES } from "@moros/core/events/schema.ts";

const base = { seq: 1, ts: "2026-01-01T00:00:00.000Z" };

describe("message.feedback 事件", () => {
	it("合法反馈事件通过 schema 校验", () => {
		const event = EventSchema.parse({
			...base,
			type: "message.feedback",
			payload: { targetSeq: 7, rating: "up" },
		});
		expect(event.type).toBe("message.feedback");
		expect(event).toMatchObject({ payload: { targetSeq: 7, rating: "up" } });
	});

	it("rating 只接受 up / down / none", () => {
		for (const rating of ["up", "down", "none"]) {
			expect(() =>
				EventSchema.parse({ ...base, type: "message.feedback", payload: { targetSeq: 1, rating } }),
			).not.toThrow();
		}
		expect(() =>
			EventSchema.parse({ ...base, type: "message.feedback", payload: { targetSeq: 1, rating: "love" } }),
		).toThrow();
	});

	it("targetSeq 必须为正整数", () => {
		expect(() =>
			EventSchema.parse({ ...base, type: "message.feedback", payload: { targetSeq: 0, rating: "up" } }),
		).toThrow();
	});

	it("EVENT_TYPES 包含 message.feedback", () => {
		expect(EVENT_TYPES).toContain("message.feedback");
	});
});
