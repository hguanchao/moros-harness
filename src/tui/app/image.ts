import { extname } from "node:path";

import { MAX_IMAGE_BYTES, MAX_IMAGE_BYTES_PER_REQUEST } from "#src/core/llm/image-limits.ts";
import { formatBytes } from "#src/tui/app/contract/format.ts";
import { imageTooLarge, imagesTooLarge, tooManyImages } from "#src/tui/app/copy/index.ts";

/**
 * 输入框里的图片附件。
 *
 * 图片以 `[image: 文件名]` 标记的形式待在正文里，和文字一起编辑、一起发送；真正的二进制
 * 数据留在内存里随消息发出，不另建附件目录。标记被删掉，那张图就不会进入这一轮。
 */

export interface ImageAttachment {
	/** 文件名，既用于标记也用于历史显示 */
	readonly name: string;
	readonly mimeType: string;
	/** 不带 data URL 前缀的 base64 */
	readonly data: string;
	readonly bytes: number;
}

/** 一条已经读进来、等待发送的图片及其正文标记。 */
export interface PendingImage {
	readonly token: string;
	readonly image: ImageAttachment;
}

/** 整段粘贴内容识别出的图片来源：本地文件或网络地址。 */
export type PastedImage =
	{ readonly kind: "file"; readonly value: string } | { readonly kind: "url"; readonly value: string };

/** 界面需要的图片读取入口；由装配处提供，界面不直接碰文件系统与剪贴板命令。 */
export interface ImageSource {
	/** 读取指定路径；失败时抛错 */
	readonly read: (path: string) => Promise<ImageAttachment>;
	/** 整段文本像一个图片路径且文件存在时返回绝对路径 */
	readonly detect: (text: string) => string | undefined;
	/** 下载网络图片；不提供时 URL 粘贴按普通文本处理 */
	readonly readUrl?: (url: string) => Promise<ImageAttachment>;
	/** 读取系统剪贴板里的图片；失败时抛错 */
	readonly clipboard: () => Promise<ImageAttachment>;
	/** 读取系统剪贴板里的文本；剪贴板里没有文本时返回空串，读不了时抛错 */
	readonly clipboardText: () => Promise<string>;
}

/** 一次最多附几张图；比请求预算更严，输入框里四张已经是产品上限。 */
const MAX_IMAGE_COUNT = 4;

/** 扩展名是否属于支持的图片格式；内容是否真是图片由读取器再核对文件头。 */
export function isImagePath(path: string): boolean {
	return IMAGE_EXTENSIONS.has(extname(path).toLowerCase());
}

/**
 * 整段文本是否像一个图片 URL。
 *
 * 只做同步的形状判断，真正的可达性与格式由下载后的文件头校验负责。要求路径以图片扩展名
 * 结尾（或带 `format=png` 这类常见 CDN 参数），避免把普通网页链接也当成图片去抓——
 * 粘贴即触发网络请求，判定必须保守。
 */
export function isImageUrl(text: string): boolean {
	const candidate = text.trim();
	if (candidate.length === 0 || candidate.length > 4096) return false;
	if (/[\s\u0000-\u001f\u007f]/.test(candidate)) return false;
	let url: URL;
	try {
		url = new URL(candidate);
	} catch {
		return false;
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") return false;
	if (/\.(png|jpe?g|webp|gif)$/i.test(url.pathname)) return true;
	return /^(png|jpe?g|webp|gif)$/i.test(url.searchParams.get("format") ?? "");
}

const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

/** 新附件与已有附件一起是否超限；超限时返回给使用者看的原因。 */
export function imageLimitError(existing: readonly ImageAttachment[], next: ImageAttachment): string | undefined {
	return attachmentSetError([...existing, next]);
}

/** 一组附件是否超限；合并两批附件时也要走这里，不能只检查新增的那张。 */
export function attachmentSetError(images: readonly ImageAttachment[]): string | undefined {
	if (images.length > MAX_IMAGE_COUNT) {
		return tooManyImages(MAX_IMAGE_COUNT);
	}
	const oversized = images.find((image) => image.bytes > MAX_IMAGE_BYTES);
	if (oversized !== undefined) {
		return imageTooLarge(oversized.name, formatBytes(oversized.bytes), formatBytes(MAX_IMAGE_BYTES));
	}
	const total = images.reduce((sum, image) => sum + image.bytes, 0);
	if (total > MAX_IMAGE_BYTES_PER_REQUEST) {
		return imagesTooLarge(formatBytes(total), formatBytes(MAX_IMAGE_BYTES_PER_REQUEST));
	}
	return undefined;
}

/** 正文里的图片标记。 */
export function imageMarker(name?: string): string {
	return `[image: ${sanitizeName(name ?? "image")}]`;
}

const IMAGE_MARKER_PATTERN = /\[image:[^\]\r\n]*\]/g;

/**
 * 给正文里的图片标记换色。
 *
 * 标记结束后恢复到调用方指定的前景色，而不是直接 RESET：用户消息块有背景色，RESET 会把
 * 后半行和补齐空格打回终端底色。
 */
export function highlightImageMarkers(text: string, markerColor: string, restoreColor: string): string {
	return text.replace(IMAGE_MARKER_PATTERN, (marker) => `${markerColor}${marker}${restoreColor}`);
}

/** 同名图片加序号，保证正文里的标记能唯一对应一张图。 */
export function uniqueImageName(name: string, used: ReadonlySet<string>): string {
	const base = sanitizeName(name);
	if (!used.has(base)) return base;

	const dot = base.lastIndexOf(".");
	const stem = dot > 0 ? base.slice(0, dot) : base;
	const extension = dot > 0 ? base.slice(dot) : "";
	for (let index = 2; ; index += 1) {
		const candidate = `${stem}-${index}${extension}`;
		if (!used.has(candidate)) return candidate;
	}
}

/**
 * 按正文里还存在的标记挑出这一轮要发送的图片。
 *
 * 标记被删掉就表示使用者不要这张图；顺序按标记在正文里第一次出现的位置，重复标记只送一次。
 */
export function imagesInPrompt(text: string, pending: readonly PendingImage[]): readonly ImageAttachment[] {
	const found = pending
		.map((item) => ({ item, index: text.indexOf(item.token) }))
		.filter((entry) => entry.index >= 0)
		.sort((left, right) => left.index - right.index);
	const seen = new Set<string>();
	const images: ImageAttachment[] = [];
	for (const { item } of found) {
		if (seen.has(item.token)) continue;
		seen.add(item.token);
		images.push(item.image);
	}
	return images;
}

/** 文件名可能来自剪贴板或别的系统；控制字符会把标记撑乱。 */
function sanitizeName(name: string): string {
	const clean = name.replaceAll(/[\u0000-\u001f\u007f]/g, " ").trim();
	return clean.length === 0 ? "image" : clean;
}
