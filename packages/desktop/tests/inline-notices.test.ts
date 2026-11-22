import { describe, expect, it } from "vitest";

import { initialState, reducer } from "../src/store/state.tsx";

describe("会话内联提示", () => {
	it("warning 推送写入对应会话，其他会话不受影响", () => {
		const next = reducer(initialState, {
			type: "push",
			message: {
				type: "inline-notice",
				sessionId: "s1",
				tone: "warn",
				text: "Session title generation failed: fetch failed",
			},
		});
		expect(next.inlineNotices["s1"]).toEqual([{ tone: "warn", text: "Session title generation failed: fetch failed" }]);
		expect(next.inlineNotices["s2"]).toBeUndefined();
	});

	it("run 错误写入对应会话的内联提示", () => {
		const next = reducer(initialState, {
			type: "push",
			message: { type: "run", sessionId: "s1", runId: "r1", state: "error", error: "boom" },
		});
		expect(next.inlineNotices["s1"]).toEqual([{ tone: "error", text: "boom" }]);
		expect(next.runStates["s1"]).toBe("error");
	});

	it("同一会话的多条提示按顺序追加，超过上限时只保留最近 20 条", () => {
		let state = initialState;
		for (let i = 0; i < 25; i += 1) {
			state = reducer(state, {
				type: "push",
				message: { type: "inline-notice", sessionId: "s1", tone: "warn", text: `warn-${i}` },
			});
		}
		const notices = state.inlineNotices["s1"] ?? [];
		expect(notices).toHaveLength(20);
		expect(notices[0]?.text).toBe("warn-5");
		expect(notices.at(-1)?.text).toBe("warn-24");
	});
});
