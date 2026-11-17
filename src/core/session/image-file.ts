import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { ImageMediaType } from "#src/core/llm/types.ts";
import { MAX_IMAGE_BYTES, formatImageBytes } from "#src/core/llm/image-limits.ts";
import { isMissingPath } from "#src/core/fs-error.ts";

/** 一张已完成缩放与格式转换、准备附加到会话输入的图片。 */
export interface SessionImageInput {
	/** MIME 类型仅允许 PNG、JPEG、WebP 与 GIF。 */
	readonly mediaType: ImageMediaType;
	/** 已预处理图片的标准 Base64 内容。 */
	readonly data: string;
	/** 图片像素宽度，最大 2000。 */
	readonly width: number;
	/** 图片像素高度，最大 2000。 */
	readonly height: number;
	/** 来源 URL；仅网络图片带此字段，用于事件审计。 */
	readonly sourceUrl?: string;
}

/** 附件允许的最大像素边长；与模型输入约束一致，超出时要求调用方先缩放。 */
const MAX_IMAGE_DIMENSION = 2000;

/**
 * 读取并校验本地图片，返回可直接交给 `runSession({ images })` 的附件输入。
 * 本模块不缩放、不转码：尺寸超过限制或格式不支持时抛错，由用户端先处理。
 * @param projectRoot 用于解析相对路径的项目根目录。
 * @param path 图片文件路径；相对路径基于 projectRoot 解析。
 * @returns 标准 Base64 的图片数据与像素尺寸。
 * @throws 文件缺失、格式不支持或无法解析、边长超过 2000 像素时抛出英文错误。
 */
export async function prepareImageFile(projectRoot: string, path: string): Promise<SessionImageInput> {
	const target = resolve(projectRoot, path);
	let bytes: Buffer;
	try {
		bytes = await readFile(target);
	} catch (error) {
		if (isMissingPath(error)) throw new Error(`Image file not found: ${target}`);
		throw error;
	}
	return prepareImageBuffer(bytes);
}

/**
 * 校验内存中的图片字节（粘贴、拖拽），返回可直接交给 `runSession({ images })` 的附件输入。
 * 与文件入口共用尺寸与格式规则，不缩放、不转码。
 * @param bytes 图片原始字节。
 * @throws 格式不支持、头部损坏或边长超过 2000 像素时抛出英文错误。
 */
export function prepareImageBuffer(bytes: Buffer): SessionImageInput {
	const sniffed = sniffImageDimensions(bytes);
	if (!sniffed) throw new Error("Unsupported or corrupt image; PNG, JPEG, WebP, and GIF are supported");
	if (sniffed.width > MAX_IMAGE_DIMENSION || sniffed.height > MAX_IMAGE_DIMENSION) {
		throw new Error(
			`Image is ${sniffed.width}x${sniffed.height}; the maximum is ${MAX_IMAGE_DIMENSION}x${MAX_IMAGE_DIMENSION}. Resize it before attaching.`,
		);
	}
	// 边长合规不代表体积合规：2000x2000 的高熵 PNG 仍可超过 10MB，而 Base64 还要再膨胀 4/3。
	// 这条限制必须落在 core，不能只写在 TUI——否则任何非 TUI 调用方都能绕过。
	if (bytes.byteLength > MAX_IMAGE_BYTES) {
		throw new Error(
			`Image is ${formatImageBytes(bytes.byteLength)}; the maximum is ${formatImageBytes(MAX_IMAGE_BYTES)}. Recompress or resize it before attaching.`,
		);
	}
	return { mediaType: sniffed.mediaType, data: bytes.toString("base64"), width: sniffed.width, height: sniffed.height };
}

interface SniffedImage {
	readonly mediaType: ImageMediaType;
	readonly width: number;
	readonly height: number;
}

/**
 * 从文件头解析图片格式与像素尺寸，不解码像素数据。
 * 返回 undefined 表示格式不受支持或头部损坏。
 */
function sniffImageDimensions(bytes: Buffer): SniffedImage | undefined {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (matchSignature(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
		if (bytes.length < 24) return undefined;
		return { mediaType: "image/png", width: view.getUint32(16), height: view.getUint32(20) };
	}
	if (matchSignature(bytes, [0x47, 0x49, 0x46, 0x38])) {
		if (bytes.length < 10) return undefined;
		return { mediaType: "image/gif", width: view.getUint16(6, true), height: view.getUint16(8, true) };
	}
	if (bytes[0] === 0xff && bytes[1] === 0xd8) return sniffJpeg(view);
	if (matchSignature(bytes, [0x52, 0x49, 0x46, 0x46]) && matchSignature(bytes.slice(8, 12), [0x57, 0x45, 0x42, 0x50])) {
		return sniffWebp(view, bytes);
	}
	return undefined;
}

/** 扫描 JPEG 段序列，从 SOF 段读取尺寸；遇到损坏结构即放弃。 */
function sniffJpeg(view: DataView): SniffedImage | undefined {
	let offset = 2;
	while (offset + 4 <= view.byteLength) {
		if (view.getUint8(offset) !== 0xff) return undefined;
		const marker = view.getUint8(offset + 1);
		if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
			offset += 2;
			continue;
		}
		if (marker === 0xd8 || marker === 0xd9) return undefined;
		const length = view.getUint16(offset + 2);
		if (length < 2) return undefined;
		const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
		if (isSof) {
			if (offset + 9 > view.byteLength) return undefined;
			return { mediaType: "image/jpeg", width: view.getUint16(offset + 7), height: view.getUint16(offset + 5) };
		}
		offset += 2 + length;
	}
	return undefined;
}

/** 按 WebP 三种子格式（VP8X / VP8 / VP8L）解析画布尺寸。 */
function sniffWebp(view: DataView, bytes: Buffer): SniffedImage | undefined {
	if (bytes.length < 30) return undefined;
	const format = bytes.toString("latin1", 12, 16);
	if (format === "VP8X") {
		// 画布尺寸为 24 位小端「宽-1 / 高-1」，位于标志位之后。
		const width = readUint24(view, 24) + 1;
		const height = readUint24(view, 27) + 1;
		return { mediaType: "image/webp", width, height };
	}
	if (format === "VP8 ") {
		// 有损帧：3 字节帧标签 + 固定同步码 9D 01 2A，随后为 14 位宽高。
		if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) return undefined;
		return {
			mediaType: "image/webp",
			width: view.getUint16(26, true) & 0x3fff,
			height: view.getUint16(28, true) & 0x3fff,
		};
	}
	if (format === "VP8L") {
		if (bytes[20] !== 0x2f) return undefined;
		const bits = view.getUint32(21, true);
		return { mediaType: "image/webp", width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
	}
	return undefined;
}

function readUint24(view: DataView, offset: number): number {
	return view.getUint8(offset) | (view.getUint8(offset + 1) << 8) | (view.getUint8(offset + 2) << 16);
}

function matchSignature(bytes: Buffer, signature: readonly number[]): boolean {
	return signature.every((byte, index) => bytes[index] === byte);
}
