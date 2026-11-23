import { describe, expect, it } from "vitest";

import { segmentInput, type ChipRef } from "../src/utils/input-chips.ts";

const quote: ChipRef = { id: "q1", kind: "quote", display: "引用：b.txt 增加几" };
const file: ChipRef = { id: "m1", kind: "file", display: "@a.txt" };
const skill: ChipRef = { id: "s1", kind: "skill", display: "$skill" };

describe("segmentInput 同排胶囊切段", () => {
	it("无 chip 时原样返回一段", () => {
		expect(segmentInput("帮我分析", [])).toEqual([{ text: "帮我分析" }]);
	});

	it("单个胶囊切三段", () => {
		expect(segmentInput("前缀 引用：b.txt 增加几 后缀", [quote])).toEqual([
			{ text: "前缀 " },
			{ text: "引用：b.txt 增加几", chip: quote },
			{ text: " 后缀" },
		]);
	});

	it("多个胶囊与文字混排", () => {
		expect(segmentInput("看 @a.txt 用 $skill 引用：b.txt 增加几", [file, skill, quote])).toEqual([
			{ text: "看 " },
			{ text: "@a.txt", chip: file },
			{ text: " 用 " },
			{ text: "$skill", chip: skill },
			{ text: " " },
			{ text: "引用：b.txt 增加几", chip: quote },
		]);
	});

	it("display 被用户删掉则不再切段（以文字为准）", () => {
		expect(segmentInput("只剩普通文字", [quote])).toEqual([{ text: "只剩普通文字" }]);
	});

	it("重叠片段只取靠前的", () => {
		const overlap: ChipRef = { id: "q2", kind: "quote", display: "b.txt 增加几" };
		const result = segmentInput("引用：b.txt 增加几", [quote, overlap]);
		expect(result).toHaveLength(1);
		expect(result[0]?.chip?.id).toBe("q1");
	});

	it("空文本返回空数组", () => {
		expect(segmentInput("", [quote])).toEqual([]);
	});
});
