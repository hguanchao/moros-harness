/**
 * 附件、图片与折叠粘贴文案
 *
 * 界面文案按用途拆分，`copy.ts` 是唯一的对外入口；这里只放本段自己的词与句。
 */

// ── 附件与图片 ────────────────────────────────────────────────────────────

/** 图片数量上限。 */
export function tooManyImages(max: number): string {
	return `Up to ${max} images per message`;
}

/** 单张超限。 */
export function imageTooLarge(name: string, bytes: string, limit: string): string {
	return `Image ${name} is ${bytes}; the limit is ${limit}`;
}

/** 合计超限。 */
export function imagesTooLarge(total: string, limit: string): string {
	return `Attached images total ${total}; the limit is ${limit}`;
}

/** 模型不吃图片：说明它会变成占位符，而不是悄悄丢掉。 */
export function attachedWithoutVision(name: string): string {
	return `Attached ${name} · this model can't read images, so it gets a placeholder`;
}

/** 还在读上一张图，先别发。 */
export const IMAGE_STILL_READING = "Still reading an image; try again in a moment";

/** 这个构建没有接网络图片下载入口。 */
export const IMAGE_URL_UNSUPPORTED = "This build can't load images from URLs";

// ── 折叠粘贴 ──────────────────────────────────────────────────────────────

/**
 * 大段粘贴折叠成一行标记后的显示文字。
 *
 * 行数优先：多行粘贴用行数更好懂；体积大到行数已经失去意义时（上万行日志）改用大小。
 */
export function pasteChipLines(lines: number): string {
	return `${lines} ${lines === 1 ? "line" : "lines"}`;
}

/** 体积标签按十进制单位，与文件大小一致。 */
export function pasteChipBytes(bytes: number): string {
	if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
	if (bytes >= 1000) return `${Math.floor(bytes / 1000)} KB`;
	return `${bytes} bytes`;
}

/** 输入框里的折叠标记：带序号，便于同一段内容贴多次时区分与定位。 */
export function pasteMarker(id: number, label: string): string {
	return `[Pasted #${id}: ${label}]`;
}
