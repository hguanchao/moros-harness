import { describe, expect, it } from "vitest";

import { createMcpToolName, mcpNamespace } from "@moros/core/mcp/naming.ts";

describe("MCP 工具命名", () => {
	it("使用 mcp__<server>__<tool>，并把非法字符转成下划线", () => {
		expect(createMcpToolName("filesystem", "read_file")).toBe("mcp__filesystem__read_file");
		expect(createMcpToolName("my-server", "read-file")).toBe("mcp__my_server__read_file");
	});

	it("超过 64 字符时追加 8 位 hash，且同名调用结果稳定", () => {
		const tool = "x".repeat(80);
		const first = createMcpToolName("server", tool);
		const second = createMcpToolName("server", tool);

		expect(first).toHaveLength(64);
		expect(first).toBe(second);
		expect(first).toMatch(/_[a-f0-9]{8}$/);
	});

	it("与其他工具重名时也追加 hash", () => {
		const plain = createMcpToolName("a", "b");
		const hashed = createMcpToolName("a", "b", (candidate) => candidate === plain);

		expect(hashed).not.toBe(plain);
		expect(hashed).toMatch(/_[a-f0-9]{8}$/);
	});

	it("server 命名空间把 - 与 _ 视为同一组", () => {
		expect(mcpNamespace("my-server")).toBe("mcp__my_server");
		expect(mcpNamespace("my_server")).toBe("mcp__my_server");
	});
});
