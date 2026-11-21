import { describe, expect, it } from "vitest";

import { assertPublicDestination, bodyToText, isPrivateAddress } from "../src/tools/builtins/web-fetch.ts";

describe("isPrivateAddress", () => {
	it.each([
		"127.0.0.1",
		"10.1.2.3",
		"172.16.0.1",
		"172.31.255.255",
		"192.168.1.1",
		"169.254.169.254",
		"100.64.0.1",
		"0.0.0.0",
		"::1",
		"::",
		"fe80::1",
		"fc00::1",
		"fd12::1",
		"::ffff:127.0.0.1",
		"not-an-ip",
	])("私网/环回/链路本地/非法地址按禁止处理：%s", (ip) => {
		expect(isPrivateAddress(ip)).toBe(true);
	});

	it.each(["8.8.8.8", "1.1.1.1", "2606:4700::1111"])("公网地址放行：%s", (ip) => {
		expect(isPrivateAddress(ip)).toBe(false);
	});
});

describe("assertPublicDestination", () => {
	const lookup = (addresses: readonly string[]) => async () => addresses.map((address) => ({ address }));

	it("域名解析出私网地址时抛错", async () => {
		await expect(assertPublicDestination("internal.example", lookup(["10.0.0.5"]))).rejects.toThrow(
			"Blocked fetch to private address",
		);
	});

	it("域名解析出多个地址时任一私网都抛错", async () => {
		await expect(assertPublicDestination("mixed.example", lookup(["1.1.1.1", "192.168.0.9"]))).rejects.toThrow(
			"Blocked fetch to private address",
		);
	});

	it("公网解析放行", async () => {
		await expect(assertPublicDestination("example.com", lookup(["93.184.216.34"]))).resolves.toBeUndefined();
	});

	it("IP 字面量私网直接抛错且不做 DNS 解析", async () => {
		let called = false;
		const probing = async () => {
			called = true;
			return [{ address: "8.8.8.8" }];
		};
		await expect(assertPublicDestination("127.0.0.1", probing)).rejects.toThrow("Blocked fetch to private address");
		expect(called).toBe(false);
	});

	it("解析结果为空时按失败处理", async () => {
		await expect(assertPublicDestination("empty.example", lookup([]))).rejects.toThrow("no addresses");
	});
});

describe("bodyToText", () => {
	it("HTML 转成 Markdown 并剥离脚本与隐藏内容", () => {
		const html = `<html><head><style>p{color:red}</style></head><body>
			<h1>标题</h1>
			<script>alert(1)</script>
			<p>正文</p>
			<div style="display:none">hidden</div>
		</body></html>`;
		const markdown = bodyToText("text/html; charset=utf-8", html);
		expect(markdown).toContain("# 标题");
		expect(markdown).toContain("正文");
		expect(markdown).not.toContain("alert");
		expect(markdown).not.toContain("hidden");
	});

	it("纯文本与 JSON 原样返回", () => {
		expect(bodyToText("text/plain", "hello")).toBe("hello");
		expect(bodyToText("application/json", '{"ok":true}')).toBe('{"ok":true}');
	});

	it("二进制类型给出不支持的说明", () => {
		expect(bodyToText("application/octet-stream", "\u0000data")).toContain("Unsupported content type");
	});
});
