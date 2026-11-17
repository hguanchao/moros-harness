import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

import { MAX_IMAGE_BYTES, formatImageBytes } from "#src/core/llm/image-limits.ts";
import { prepareImageBuffer, type SessionImageInput } from "#src/core/session/image-file.ts";

/**
 * 从 http/https URL 抓取图片，交给与本地文件同一条预处理管线。
 *
 * 只由用户的显式动作触发（粘贴/拖入一个图片链接），不参与自动嗅探：URL 抓取是网络
 * 出口，默默发起请求既意外，也是现成的 SSRF 面。
 *
 * 防护要点：
 * - 只允许 http/https，拒绝带凭据的 URL；
 * - 解析域名后校验全部地址，命中私网/回环/链路本地/保留段即拒绝；
 * - 重定向手动跟随，每一跳重新做同样的地址校验（首跳合法不代表跳转目标合法）；
 * - 体积按流式累计截断，不信任 Content-Length（远端可以撒谎或不分块）；
 * - 错误信息只带 host，不回显完整 URL，避免把签名参数写进状态行与日志。
 *
 * 已知残留风险：校验与真正的连接各自做一次 DNS 解析，存在 DNS rebinding 窗口；要彻底
 * 关掉需要给 socket 绑定已校验的地址（自定义 dispatcher），超出当前范围。
 */

/** 单次下载的超时；慢 URL 不应挂住输入。 */
const DEFAULT_TIMEOUT_MS = 10_000;
/** 重定向跳数上限。 */
const DEFAULT_MAX_REDIRECTS = 3;
/** URL 长度上限，超过的多半不是正常的图片地址。 */
const MAX_URL_LENGTH = 4096;

/** 解析结果条目；只需地址与协议族。 */
interface ResolvedAddress {
	readonly address: string;
	readonly family: number;
}

/** 可注入的 DNS 解析入口，测试用来模拟私网与多地址场景。 */
export type LookupAll = (
	hostname: string,
	options: { readonly all: true; readonly verbatim: true },
) => Promise<readonly ResolvedAddress[]>;

export interface ImageUrlOptions {
	readonly fetch?: typeof fetch;
	readonly lookup?: LookupAll;
	readonly maxBytes?: number;
	readonly maxRedirects?: number;
	readonly timeoutMs?: number;
	readonly signal?: AbortSignal;
}

/**
 * 下载并校验一张网络图片。
 * @param value 图片 URL；仅支持 http/https。
 * @param options 可注入的 fetch/lookup 与预算覆盖。
 * @returns 可直接交给 `runSession({ images })` 的附件输入，`sourceUrl` 记录来源。
 * @throws URL 非法、目标为私网地址、HTTP 失败、内容过大或不是受支持的图片格式时抛出英文错误。
 */
export async function prepareImageUrl(value: string, options: ImageUrlOptions = {}): Promise<SessionImageInput> {
	const fetchImpl = options.fetch ?? fetch;
	const lookupAll = options.lookup ?? defaultLookup;
	const maxBytes = options.maxBytes ?? MAX_IMAGE_BYTES;
	const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
	const signal = options.signal
		? AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS)])
		: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

	let target = await assertFetchableUrl(value, lookupAll);
	for (let hop = 0; hop <= maxRedirects; hop += 1) {
		let response: Response;
		try {
			response = await fetchImpl(target.toString(), {
				method: "GET",
				redirect: "manual",
				headers: { accept: "image/*" },
				signal,
			});
		} catch (error) {
			// 调用方主动中止原样抛出；否则是超时，换成可读原因
			if (options.signal?.aborted === true) throw error;
			if (signal.aborted) throw new Error(`Timed out fetching the image: ${target.host}`);
			throw error;
		}
		if (isRedirect(response.status)) {
			const location = response.headers.get("location");
			await discardBody(response);
			if (!location) throw new Error(`Image URL redirected without a location: ${target.host}`);
			if (hop === maxRedirects) throw new Error(`Too many redirects while fetching the image: ${target.host}`);
			target = await assertFetchableUrl(new URL(location, target).toString(), lookupAll);
			continue;
		}
		if (!response.ok) {
			await discardBody(response);
			throw new Error(`Image URL returned HTTP ${response.status}: ${target.host}`);
		}
		const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
		// 明显是网页就直接拒绝：省掉下载整页 HTML 再靠魔数报错的流量
		if (contentType.startsWith("text/") || contentType.includes("html")) {
			await discardBody(response);
			throw new Error(`Image URL returned ${contentType.split(";")[0] ?? contentType}, not an image: ${target.host}`);
		}
		const bytes = await readBody(response, maxBytes, target.host);
		return { ...prepareImageBuffer(bytes), sourceUrl: target.toString() };
	}
	throw new Error(`Too many redirects while fetching the image: ${target.host}`);
}

function defaultLookup(
	hostname: string,
	options: { readonly all: true; readonly verbatim: true },
): Promise<readonly ResolvedAddress[]> {
	return lookup(hostname, options);
}

/**
 * 校验 URL 并确认它不指向私网。
 * @param value 待校验的地址。
 * @param lookupAll DNS 解析入口。
 * @returns 规范化后的 URL。
 */
async function assertFetchableUrl(value: string, lookupAll: LookupAll): Promise<URL> {
	if (value.length > MAX_URL_LENGTH) throw new Error("Image URL is too long");
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error("Invalid image URL");
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error(`Unsupported image URL protocol: ${url.protocol.replace(":", "")}`);
	}
	if (url.username || url.password) throw new Error("Image URL must not contain credentials");
	const host = url.hostname.replace(/^\[|\]$/g, "");
	if (host.length === 0) throw new Error("Image URL has no host");
	const addresses = await resolveHost(host, lookupAll);
	if (addresses.length === 0) throw new Error(`Could not resolve image URL host: ${host}`);
	// 任一解析结果落在禁区就整条拒绝：轮询 DNS 不能成为绕过手段
	if (addresses.some((address) => isBlockedAddress(address))) {
		throw new Error(`Image URL host resolves to a private or reserved address: ${host}`);
	}
	return url;
}

async function resolveHost(host: string, lookupAll: LookupAll): Promise<readonly string[]> {
	if (isIP(host) !== 0) return [host];
	try {
		const resolved = await lookupAll(host, { all: true, verbatim: true });
		return resolved.map((entry) => entry.address);
	} catch {
		throw new Error(`Could not resolve image URL host: ${host}`);
	}
}

/**
 * 地址是否属于不可访问的网段。
 * @param address IPv4/IPv6 字面量；无法识别时按不可访问处理。
 */
export function isBlockedAddress(address: string): boolean {
	const version = isIP(address);
	if (version === 4) return isBlockedIpv4(address);
	if (version === 6) return isBlockedIpv6(address);
	return true;
}

function isBlockedIpv4(address: string): boolean {
	const parts = address.split(".").map(Number);
	if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
	const [a, b, c] = parts as [number, number, number, number];
	return (
		a === 0 || // 本网络
		a === 10 || // 私有
		a === 127 || // 回环
		(a === 100 && b >= 64 && b <= 127) || // CGNAT
		(a === 169 && b === 254) || // 链路本地
		(a === 172 && b >= 16 && b <= 31) || // 私有
		(a === 192 && b === 0) || // IETF 协议分配 / 文档段
		(a === 192 && b === 168) || // 私有
		(a === 198 && (b === 18 || b === 19)) || // 基准测试
		(a === 198 && b === 51 && c === 100) || // 文档段
		(a === 203 && b === 0 && c === 113) || // 文档段
		a >= 224 // 组播与保留
	);
}

function isBlockedIpv6(address: string): boolean {
	const normalized = address.toLowerCase();
	// IPv4 映射地址要按 IPv4 规则判：::ffff:127.0.0.1 和 ::ffff:7f00:1 是同一条回环
	const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalized);
	if (dotted?.[1]) return isBlockedIpv4(dotted[1]);
	const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(normalized);
	if (hex?.[1] && hex[2]) {
		const high = Number.parseInt(hex[1], 16);
		const low = Number.parseInt(hex[2], 16);
		return isBlockedIpv4([high >> 8, high & 0xff, low >> 8, low & 0xff].join("."));
	}
	if (normalized === "::" || normalized === "::1") return true;
	if (/^f[cd]/.test(normalized)) return true; // 唯一本地 fc00::/7
	if (/^fe[89ab]/.test(normalized)) return true; // 链路本地 fe80::/10
	if (/^ff/.test(normalized)) return true; // 组播
	if (/^2001:db8/.test(normalized)) return true; // 文档段
	return false;
}

function isRedirect(status: number): boolean {
	return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

/** 丢弃未消费的响应体，避免连接挂着不释放。 */
async function discardBody(response: Response): Promise<void> {
	await response.body?.cancel().catch(() => undefined);
}

/**
 * 流式读取响应体并在超限时立刻中断。
 * @param response 已确认状态码的响应。
 * @param maxBytes 原始字节上限。
 * @param host 出错时展示的主机名（不回显完整 URL）。
 */
async function readBody(response: Response, maxBytes: number, host: string): Promise<Buffer> {
	const declared = Number(response.headers.get("content-length") ?? Number.NaN);
	if (Number.isFinite(declared) && declared > maxBytes) {
		await discardBody(response);
		throw new Error(`Image at ${host} is ${formatImageBytes(declared)}; the maximum is ${formatImageBytes(maxBytes)}`);
	}
	const body = response.body;
	if (!body) throw new Error(`Image URL returned an empty body: ${host}`);
	const reader = body.getReader();
	const chunks: Buffer[] = [];
	let total = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > maxBytes) {
				throw new Error(
					`Image at ${host} is larger than ${formatImageBytes(maxBytes)}; the maximum is ${formatImageBytes(maxBytes)}`,
				);
			}
			chunks.push(Buffer.from(value));
		}
	} catch (error) {
		await reader.cancel().catch(() => undefined);
		throw error;
	} finally {
		reader.releaseLock();
	}
	return Buffer.concat(chunks, total);
}
