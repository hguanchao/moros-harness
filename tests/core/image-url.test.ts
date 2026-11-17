import { describe, expect, it } from "vitest";

import { isBlockedAddress, prepareImageUrl, type LookupAll } from "#src/core/session/image-url.ts";

const publicLookup: LookupAll = async () => [{ address: "93.184.216.34", family: 4 }];

/** 最小合法 PNG 头：只需要签名与 IHDR 里的宽高，sniff 不解码像素。 */
function pngBytes(width = 1, height = 1): Buffer {
	const bytes = Buffer.alloc(33);
	Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
	bytes.writeUInt32BE(width, 16);
	bytes.writeUInt32BE(height, 20);
	return bytes;
}

function imageResponse(bytes: Buffer, headers: Record<string, string> = {}): Response {
	return new Response(bytes, { status: 200, headers: { "content-type": "image/png", ...headers } });
}

/** 永远不应被调用的 fetch，用于断言校验发生在网络之前。 */
const forbiddenFetch: typeof fetch = async () => {
	throw new Error("fetch should not be called");
};

describe("isBlockedAddress", () => {
	it.each([
		["0.0.0.0", true],
		["10.1.2.3", true],
		["100.64.0.1", true],
		["127.0.0.1", true],
		["169.254.169.254", true],
		["172.16.0.1", true],
		["172.32.0.1", false],
		["192.168.1.1", true],
		["198.18.0.1", true],
		["203.0.113.5", true],
		["224.0.0.1", true],
		["8.8.8.8", false],
		["93.184.216.34", false],
		["::1", true],
		["::", true],
		["fc00::1", true],
		["fd12:3456::1", true],
		["fe80::1", true],
		["2001:db8::1", true],
		["2606:4700::1111", false],
		["::ffff:127.0.0.1", true],
		["::ffff:7f00:1", true],
		["not-an-ip", true],
	])("%s → blocked=%s", (address, blocked) => {
		expect(isBlockedAddress(address)).toBe(blocked);
	});
});

describe("prepareImageUrl", () => {
	it("下载成功后返回 Base64、尺寸与来源 URL", async () => {
		const bytes = pngBytes(3, 2);
		const result = await prepareImageUrl("https://example.com/cat.png", {
			lookup: publicLookup,
			fetch: async () => imageResponse(bytes),
		});
		expect(result).toMatchObject({
			mediaType: "image/png",
			width: 3,
			height: 2,
			sourceUrl: "https://example.com/cat.png",
		});
		expect(Buffer.from(result.data, "base64").equals(bytes)).toBe(true);
	});

	it("拒绝非 http(s) 协议，且不发请求", async () => {
		await expect(prepareImageUrl("file:///etc/passwd", { fetch: forbiddenFetch })).rejects.toThrow(
			"Unsupported image URL protocol",
		);
	});

	it("拒绝带凭据的 URL", async () => {
		await expect(
			prepareImageUrl("https://user:secret@example.com/a.png", { lookup: publicLookup, fetch: forbiddenFetch }),
		).rejects.toThrow("must not contain credentials");
	});

	it("拒绝回环地址字面量", async () => {
		await expect(prepareImageUrl("http://127.0.0.1/a.png", { fetch: forbiddenFetch })).rejects.toThrow(
			"private or reserved address",
		);
	});

	it("任一解析结果落在私网就整条拒绝", async () => {
		const mixed: LookupAll = async () => [
			{ address: "93.184.216.34", family: 4 },
			{ address: "10.0.0.7", family: 4 },
		];
		await expect(
			prepareImageUrl("https://internal.example.com/a.png", { lookup: mixed, fetch: forbiddenFetch }),
		).rejects.toThrow("private or reserved address");
	});

	it("重定向目标也要过地址校验", async () => {
		let calls = 0;
		const fetchImpl: typeof fetch = async () => {
			calls += 1;
			return new Response(null, { status: 302, headers: { location: "http://127.0.0.1/a.png" } });
		};
		await expect(
			prepareImageUrl("https://example.com/a.png", { lookup: publicLookup, fetch: fetchImpl }),
		).rejects.toThrow("private or reserved address");
		expect(calls).toBe(1);
	});

	it("重定向跳数超限即失败", async () => {
		let calls = 0;
		const fetchImpl: typeof fetch = async () => {
			calls += 1;
			return new Response(null, { status: 302, headers: { location: "/next.png" } });
		};
		await expect(
			prepareImageUrl("https://example.com/a.png", { lookup: publicLookup, fetch: fetchImpl, maxRedirects: 2 }),
		).rejects.toThrow("Too many redirects");
		expect(calls).toBe(3);
	});

	it("HTTP 错误状态直接失败", async () => {
		const fetchImpl: typeof fetch = async () => new Response("nope", { status: 404 });
		await expect(
			prepareImageUrl("https://example.com/a.png", { lookup: publicLookup, fetch: fetchImpl }),
		).rejects.toThrow("HTTP 404");
	});

	it("返回 HTML 时不下载正文", async () => {
		const fetchImpl: typeof fetch = async () =>
			new Response("<html></html>", { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
		await expect(
			prepareImageUrl("https://example.com/a.png", { lookup: publicLookup, fetch: fetchImpl }),
		).rejects.toThrow("not an image");
	});

	it("声明体积超限时提前拒绝", async () => {
		const fetchImpl: typeof fetch = async () =>
			new Response(Buffer.alloc(16), {
				status: 200,
				headers: { "content-type": "image/png", "content-length": String(9 * 1024 * 1024) },
			});
		await expect(
			prepareImageUrl("https://example.com/a.png", { lookup: publicLookup, fetch: fetchImpl }),
		).rejects.toThrow("the maximum is");
	});

	it("不信任 Content-Length，流式累计超限即中断", async () => {
		const chunk = new Uint8Array(1024);
		const fetchImpl: typeof fetch = async () =>
			new Response(
				new ReadableStream<Uint8Array>({
					start(controller) {
						for (let index = 0; index < 64; index += 1) controller.enqueue(chunk);
						controller.close();
					},
				}),
				{ status: 200, headers: { "content-type": "image/png" } },
			);
		await expect(
			prepareImageUrl("https://example.com/a.png", { lookup: publicLookup, fetch: fetchImpl, maxBytes: 4096 }),
		).rejects.toThrow("larger than");
	});

	it("下载超时给出可读错误", async () => {
		const fetchImpl: typeof fetch = (_input, init) =>
			new Promise((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
			});
		await expect(
			prepareImageUrl("https://example.com/a.png", { lookup: publicLookup, fetch: fetchImpl, timeoutMs: 20 }),
		).rejects.toThrow("Timed out");
	});

	it("下载到的字节不是图片时报格式错误", async () => {
		const fetchImpl: typeof fetch = async () =>
			imageResponse(Buffer.from("definitely not an image"), {
				"content-type": "application/octet-stream",
			});
		await expect(
			prepareImageUrl("https://example.com/a.png", { lookup: publicLookup, fetch: fetchImpl }),
		).rejects.toThrow("Unsupported or corrupt image");
	});
});
