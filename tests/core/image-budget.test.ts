import { describe, expect, it } from "vitest";

import { applyImageBudget, planImageRetention } from "#src/core/loop/image-budget.ts";
import type { CanonicalMessage, ImageMediaType } from "#src/core/llm/types.ts";

/** 生成解码后恰好 `bytes` 字节的 Base64 字符串，避免在测试里手算长度。 */
function image(
	bytes: number,
	mediaType: ImageMediaType = "image/png",
): { type: "image"; mediaType: ImageMediaType; data: string } {
	return { type: "image", mediaType, data: Buffer.alloc(bytes, 1).toString("base64") };
}

function userMessage(...parts: ReturnType<typeof image>[]): CanonicalMessage {
	return { role: "user", content: parts };
}

/** 消息里的占位文本，用于断言被裁掉的是哪几张图。 */
function placeholders(message: CanonicalMessage): string[] {
	if (message.role !== "user" || typeof message.content === "string") return [];
	return message.content.flatMap((part) =>
		part.type === "text" && part.text.startsWith("[image omitted") ? [part.text] : [],
	);
}

describe("applyImageBudget", () => {
	it("预算内不改动任何图片", () => {
		const messages = [userMessage(image(4)), userMessage(image(4))];
		const result = applyImageBudget(messages, { maxBytes: 100, maxImages: 8 });
		expect(placeholders(result[0]!)).toHaveLength(0);
		expect(placeholders(result[1]!)).toHaveLength(0);
	});

	it("超出字节预算时从最旧的开始替换成占位", () => {
		const messages = [userMessage(image(8)), userMessage(image(8)), userMessage(image(8))];
		const result = applyImageBudget(messages, { maxBytes: 20, maxImages: 8 });
		expect(placeholders(result[0]!)).toHaveLength(1);
		expect(placeholders(result[1]!)).toHaveLength(0);
		expect(placeholders(result[2]!)).toHaveLength(0);
	});

	it("超出张数上限时同样按最近优先保留", () => {
		const messages = [userMessage(image(1)), userMessage(image(1)), userMessage(image(1))];
		const result = applyImageBudget(messages, { maxBytes: 100, maxImages: 2 });
		expect(placeholders(result[0]!)).toHaveLength(1);
		expect(placeholders(result[1]!)).toHaveLength(0);
		expect(placeholders(result[2]!)).toHaveLength(0);
	});

	it("最新一张无论多大都保留，体积问题交给输入校验", () => {
		const messages = [userMessage(image(4)), userMessage(image(1000))];
		const result = applyImageBudget(messages, { maxBytes: 10, maxImages: 8 });
		expect(placeholders(result[0]!)).toHaveLength(1);
		expect(placeholders(result[1]!)).toHaveLength(0);
	});

	it("一旦放不下就整段截断，不让更旧的小图插队", () => {
		const messages = [userMessage(image(2)), userMessage(image(100)), userMessage(image(4))];
		const result = applyImageBudget(messages, { maxBytes: 10, maxImages: 8 });
		expect(placeholders(result[0]!)).toHaveLength(1);
		expect(placeholders(result[1]!)).toHaveLength(1);
		expect(placeholders(result[2]!)).toHaveLength(0);
	});

	it("同一条消息里多图按原顺序保留或替换", () => {
		const messages = [userMessage(image(8), image(8))];
		const result = applyImageBudget(messages, { maxBytes: 12, maxImages: 8 });
		const first = result[0]!;
		expect(first.role).toBe("user");
		if (first.role !== "user" || typeof first.content === "string")
			throw new Error("expected a multimodal user message");
		expect(first.content[0]).toMatchObject({ type: "text" });
		expect(first.content[1]).toMatchObject({ type: "image" });
	});

	it("纯文本消息保持原样", () => {
		const messages: CanonicalMessage[] = [
			{ role: "system", content: "sys" },
			{ role: "user", content: "hello" },
			{ role: "assistant", content: "ok" },
		];
		expect(applyImageBudget(messages, { maxBytes: 0, maxImages: 0 })).toEqual(messages);
	});
});

describe("planImageRetention", () => {
	it("按预算从新到旧保留，最新一张恒为 true", () => {
		expect(planImageRetention([8, 8, 8], { maxBytes: 20 })).toEqual([false, true, true]);
	});

	it("张数上限生效", () => {
		expect(planImageRetention([1, 1, 1], { maxImages: 2 })).toEqual([false, true, true]);
	});

	it("中间放不下时，更旧的图不再补位", () => {
		expect(planImageRetention([2, 100, 4], { maxBytes: 10 })).toEqual([false, false, true]);
	});

	it("空输入返回空标记", () => {
		expect(planImageRetention([])).toEqual([]);
	});
});
