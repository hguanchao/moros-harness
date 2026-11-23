import { describe, expect, it } from "vitest";

import { formatKeyValueLines, parseArgumentLines, parseKeyValueLines } from "../src/utils/mcp-form.ts";

describe("MCP 表单解析", () => {
	it("逐行参数忽略空行与注释", () => {
		expect(parseArgumentLines("-y\n\n# 注释\n@modelcontextprotocol/server-files\n  E:/work  \n")).toEqual([
			"-y",
			"@modelcontextprotocol/server-files",
			"E:/work",
		]);
	});

	it("KEY=VALUE 值里的等号按第一个切分", () => {
		expect(parseKeyValueLines("TOKEN=a=b\nDEBUG=1")).toEqual({ ok: true, value: { TOKEN: "a=b", DEBUG: "1" } });
	});

	it("KEY=VALUE 拒绝无效行、空键与重复键", () => {
		expect(parseKeyValueLines("NO_EQUALS").ok).toBe(false);
		expect(parseKeyValueLines("=value").ok).toBe(false);
		expect(parseKeyValueLines("A=1\nA=2")).toMatchObject({ ok: false, error: "重复的键：A" });
	});

	it("空文本得到空对象，格式化可往返", () => {
		expect(parseKeyValueLines("")).toEqual({ ok: true, value: {} });
		const pairs = { Authorization: "Bearer x", "X-Project": "demo" };
		expect(parseKeyValueLines(formatKeyValueLines(pairs))).toEqual({ ok: true, value: pairs });
	});
});
