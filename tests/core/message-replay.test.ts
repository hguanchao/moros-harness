import { describe, expect, it } from "vitest";

import type { EventRecord, UserInputImage } from "@moros/core/events/schema.ts";
import { replayMessages } from "@moros/core/loop/message-replay.ts";
import type { CanonicalMessage } from "@moros/core/llm/types.ts";

const MB = 1024 * 1024;

function inputEvent(
	seq: number,
	text: string,
	images: readonly Pick<UserInputImage, "attachmentId" | "bytes">[],
): EventRecord {
	const record: EventRecord = {
		seq,
		ts: "2026-01-01T00:00:00.000Z",
		type: "user.input",
		payload: {
			text,
			...(images.length > 0
				? {
						images: images.map((image) => ({
							attachmentId: image.attachmentId,
							mediaType: "image/png",
							width: 100,
							height: 100,
							bytes: image.bytes,
						})),
					}
				: {}),
		},
	};
	return record;
}

function partsOf(message: CanonicalMessage | undefined): Array<{ type: string; text?: string }> {
	if (message?.role !== "user" || typeof message.content === "string") return [];
	return message.content;
}

describe("replayMessages 图片预算", () => {
	it("只加载预算内的历史图片，更旧的图片不解码", async () => {
		const records = [
			inputEvent(1, "", [{ attachmentId: "a", bytes: 12 * MB }]),
			inputEvent(2, "", [{ attachmentId: "b", bytes: 12 * MB }]),
			inputEvent(3, "", [{ attachmentId: "c", bytes: 12 * MB }]),
		];
		const loaded: string[] = [];
		const replayed = await replayMessages(records, async (image) => {
			loaded.push(image.attachmentId);
			return "AAAA";
		});

		expect(loaded).toEqual(["c"]);
		expect(replayed.messages).toHaveLength(3);
		const first = partsOf(replayed.messages[0]);
		expect(first).toHaveLength(1);
		expect(first[0]).toMatchObject({ type: "text" });
		expect(first[0]?.text).toContain("image omitted");
	});

	it("预算内保留的图片仍按原顺序进入消息", async () => {
		const records = [
			inputEvent(1, "看这张", [{ attachmentId: "a", bytes: 20 * MB }]),
			inputEvent(2, "再看这两张", [
				{ attachmentId: "b", bytes: 8 * MB },
				{ attachmentId: "c", bytes: 8 * MB },
			]),
		];
		const loaded: string[] = [];
		const replayed = await replayMessages(records, async (image) => {
			loaded.push(image.attachmentId);
			return "AAAA";
		});

		expect(loaded).toEqual(["b", "c"]);
		const second = partsOf(replayed.messages[1]);
		expect(second.map((part) => part.type)).toEqual(["text", "image", "image"]);
		const first = partsOf(replayed.messages[0]);
		expect(first.map((part) => part.type)).toEqual(["text", "text"]);
	});

	it("纯文本会话不触碰图片读取器", async () => {
		const replayed = await replayMessages([inputEvent(1, "hello", [])], async () => {
			throw new Error("should not load");
		});
		expect(replayed.messages[0]).toMatchObject({ role: "user", content: "hello" });
	});
});
