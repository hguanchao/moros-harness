import type { ImageMediaType } from "#src/core/llm/types.ts";

/**
 * 图片进入模型请求的体积上限。
 *
 * Base64 在原始字节上膨胀约 4/3，并且每轮请求都要重发一次。这里集中给出「单张」与
 * 「单次请求」两级预算，由输入校验（session/image-file.ts）、会话存储（core.ts）与
 * 请求裁剪（loop/image-budget.ts）共用，避免三处各写一套魔法数字。
 */

/** 单张图片的原始字节上限。 */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
/** 一次请求里所有图片的原始字节预算。 */
export const MAX_IMAGE_BYTES_PER_REQUEST = 20 * 1024 * 1024;
/** 一次请求里保留的图片张数上限。 */
export const MAX_IMAGES_PER_REQUEST = 8;

/**
 * 按 Base64 字符数还原原始字节数。
 *
 * `Buffer.byteLength` 只做计数，不分配解码缓冲区——这里的目的就是在不解码的前提下
 * 判断预算，避免为了“看一眼多大”先把图片展开。
 */
export function imageByteLength(data: string): number {
	return Buffer.byteLength(data, "base64");
}

/** 人类可读的体积，用于错误信息与省略占位。 */
export function formatImageBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * 被预算挤掉的图片在上下文里的替身。
 *
 * 措辞固定、不含时间戳与序号：同一张图在后续每一轮都产生完全相同的文本，提示缓存的
 * 前缀才不会因为占位文案抖动而失效。
 */
export function imageOmittedPlaceholder(mediaType: ImageMediaType, bytes: number): string {
	return `[image omitted: ${mediaType}, ${formatImageBytes(bytes)} — dropped to keep the request within the image budget]`;
}
