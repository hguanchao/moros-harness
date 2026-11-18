import type { CanonicalMessage, CanonicalPart, ImageMediaType } from "./types.ts";

const IMAGE_MEDIA_TYPES: readonly ImageMediaType[] = ["image/png", "image/jpeg", "image/webp", "image/gif"];

/** 校验图片部件中的 MIME 类型与 Base64 编码。 */
export function validateImagePart(part: CanonicalPart): void {
	if (part.type !== "image") return;
	if (!IMAGE_MEDIA_TYPES.includes(part.mediaType)) throw new Error(`Unsupported image media type: ${part.mediaType}`);
	if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(part.data)) {
		throw new Error("Image data must be valid Base64");
	}
}

/** 在发请求前验证规范消息中的所有图片部件。 */
export function validateMessages(messages: readonly CanonicalMessage[]): void {
	for (const message of messages) {
		if (message.role !== "user" || typeof message.content === "string") continue;
		for (const part of message.content) validateImagePart(part);
	}
}
