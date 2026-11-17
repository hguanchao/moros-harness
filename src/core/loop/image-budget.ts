import {
	MAX_IMAGE_BYTES_PER_REQUEST,
	MAX_IMAGES_PER_REQUEST,
	imageByteLength,
	imageOmittedPlaceholder,
} from "#src/core/llm/image-limits.ts";
import type { CanonicalMessage } from "#src/core/llm/types.ts";

/**
 * 请求前的图片预算控制。
 *
 * 图片以 Base64 常驻内存并随每轮请求重发，长会话如果不做裁剪，会同时撑大驻留内存与
 * 请求体（Base64 在线路上还有约 4/3 的膨胀）。策略是「最近优先」：从最新消息往回保留，
 * 累计超出字节预算或张数上限后，更旧的图片替换成固定文案的文本占位——模型知道那里
 * 原本有图，但不必再为它付带宽与 token。
 *
 * JSONL 事件流只存元数据（attachmentId/mediaType/width/height/bytes），这里裁剪的是
 * 内存中的规范消息，不触碰落盘内容：历史仍然完整，重新恢复时按同一条策略再裁一次。
 */

/** 预算覆盖项；仅测试或特殊调用需要收紧，默认取全局上限。 */
export interface ImageBudget {
	readonly maxBytes?: number;
	readonly maxImages?: number;
}

/**
 * 裁剪消息里的图片部件，返回新数组；没有超预算时返回内容等价的新数组。
 *
 * 最新的一张图无论多大都保留：用户刚发的图必须被模型看到，体积问题应由输入校验拦住，
 * 而不是在这里静默丢弃。旧图被换成文本后不再持有 Base64，原字符串可被回收。
 *
 * @param messages 待发送的规范消息（不会被修改）。
 * @param options 预算覆盖。
 * @returns 裁剪后的消息数组；图片顺序与消息顺序保持不变。
 */
export function applyImageBudget(messages: readonly CanonicalMessage[], options: ImageBudget = {}): CanonicalMessage[] {
	const maxBytes = options.maxBytes ?? MAX_IMAGE_BYTES_PER_REQUEST;
	const maxImages = options.maxImages ?? MAX_IMAGES_PER_REQUEST;
	let bytes = 0;
	let images = 0;
	let full = false;
	let changed = false;
	const result = [...messages];
	for (let index = result.length - 1; index >= 0; index -= 1) {
		const message = result[index]!;
		if (message.role !== "user" || typeof message.content === "string") continue;
		const parts = [...message.content];
		let messageChanged = false;
		for (let partIndex = parts.length - 1; partIndex >= 0; partIndex -= 1) {
			const part = parts[partIndex]!;
			if (part.type !== "image") continue;
			const size = imageByteLength(part.data);
			// 倒着走：第一张就是最新的一张，必须留下；一旦放不下就整段截断，
			// 不能让「更旧但更小」的图插队留在上下文里
			const fits = images === 0 || (!full && images < maxImages && bytes + size <= maxBytes);
			if (fits) {
				images += 1;
				bytes += size;
				continue;
			}
			full = true;
			parts[partIndex] = { type: "text", text: imageOmittedPlaceholder(part.mediaType, size) };
			messageChanged = true;
		}
		if (messageChanged) {
			result[index] = { role: "user", content: parts };
			changed = true;
		}
	}
	return changed ? result : [...messages];
}

/**
 * 回放前决定哪些历史图片值得解码。
 *
 * 与 `applyImageBudget` 同一套策略，但输入是事件元数据里的 `bytes`，因此不必读取附件
 * 文件、更不必做 Base64 解码，就能把「恢复会话」的开销压到预算之内。
 *
 * @param sizes 按时间顺序排列的图片原始字节数。
 * @param options 预算覆盖。
 * @returns 与 `sizes` 等长的保留标记；最新的一张恒为 true。
 */
export function planImageRetention(sizes: readonly number[], options: ImageBudget = {}): boolean[] {
	const maxBytes = options.maxBytes ?? MAX_IMAGE_BYTES_PER_REQUEST;
	const maxImages = options.maxImages ?? MAX_IMAGES_PER_REQUEST;
	const keep = new Array<boolean>(sizes.length).fill(false);
	let bytes = 0;
	let images = 0;
	let full = false;
	for (let index = sizes.length - 1; index >= 0; index -= 1) {
		const size = sizes[index]!;
		const fits = images === 0 || (!full && images < maxImages && bytes + size <= maxBytes);
		if (fits) {
			keep[index] = true;
			images += 1;
			bytes += size;
			continue;
		}
		full = true;
	}
	return keep;
}
