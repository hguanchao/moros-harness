import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { createPolicy } from "@moros/core/harness/policy.ts";
import type { ToolContext } from "@moros/core/harness/types.ts";
import { McpManager } from "@moros/core/mcp/manager.ts";
import type { McpServerConfig } from "@moros/core/mcp/types.ts";

const projectRoot = process.cwd();
const fixture = resolve(import.meta.dirname, "../fixtures/mcp-stdio-server.mjs");

function server(args: readonly string[] = []): McpServerConfig {
	return {
		name: "fixture",
		type: "stdio",
		command: process.execPath,
		args: [fixture, ...args],
		url: undefined,
		headers: {},
		env: {},
		timeoutSeconds: 10,
		disabled: false,
	};
}

function manager(config: McpServerConfig = server()): McpManager {
	return new McpManager({
		projectRoot,
		servers: [config],
		version: "0.0.0-test",
		// 测试不等自动退避，手动重连即可
		reconnectDelaysMs: [],
		startupSettleMs: 5_000,
	});
}

function context(): ToolContext {
	return {
		sessionId: "test-session",
		projectRoot,
		policy: createPolicy("creator"),
	};
}

describe("MCP manager（真实 stdio fixture）", () => {
	it("连接后注册带前缀的工具，并按 high risk / shell 资源暴露", async () => {
		const mcp = manager();
		try {
			mcp.start();
			await mcp.awaitStartup();

			expect(mcp.status()).toEqual([{ name: "fixture", status: "connected", detail: "6 tool(s)" }]);
			const tools = mcp.tools();
			expect(tools.map((tool) => tool.name)).toContain("mcp__fixture__echo");
			const echo = tools.find((tool) => tool.name === "mcp__fixture__echo");
			expect(echo).toMatchObject({
				resource: "shell",
				risk: { level: "high", rule: "mcp-tool" },
			});
			expect(echo?.parameters).toEqual({
				type: "object",
				properties: { text: { type: "string" } },
				required: ["text"],
			});
		} finally {
			await mcp.close();
		}
	});

	it("文本、错误与 structuredContent 都转换成工具结果", async () => {
		const mcp = manager();
		try {
			mcp.start();
			await mcp.awaitStartup();
			const tools = mcp.tools();
			const echo = tools.find((tool) => tool.name === "mcp__fixture__echo")!;
			const fail = tools.find((tool) => tool.name === "mcp__fixture__fail")!;
			const structured = tools.find((tool) => tool.name === "mcp__fixture__structured")!;

			expect(await echo.execute({ text: "hi" }, context())).toEqual({ content: "echo:hi" });
			expect(await fail.execute({}, context())).toEqual({ content: "fixture failure", isError: true });
			expect(await structured.execute({}, context())).toEqual({
				content: JSON.stringify({ answer: 42 }, null, 2),
			});
		} finally {
			await mcp.close();
		}
	});

	it("tools/list_changed 后刷新工具清单", async () => {
		const mcp = manager();
		try {
			mcp.start();
			await mcp.awaitStartup();
			expect(mcp.tools().some((tool) => tool.name === "mcp__fixture__extra")).toBe(false);

			const changed = mcp.tools().find((tool) => tool.name === "mcp__fixture__changed")!;
			await changed.execute({}, context());
			await new Promise((resolve) => setTimeout(resolve, 100));

			expect(mcp.tools().some((tool) => tool.name === "mcp__fixture__extra")).toBe(true);
		} finally {
			await mcp.close();
		}
	});

	it("进程退出后状态变为 unreachable，可手动重连", async () => {
		const mcp = manager();
		try {
			mcp.start();
			await mcp.awaitStartup();
			const crash = mcp.tools().find((tool) => tool.name === "mcp__fixture__crash")!;
			await crash.execute({}, context());
			await new Promise((resolve) => setTimeout(resolve, 100));

			expect(mcp.status()[0]?.status).toBe("unreachable");
			expect(mcp.tools()).toEqual([]);
			expect(await mcp.reconnect("fixture")).toContain("Reconnected fixture");
			expect(mcp.status()[0]?.status).toBe("connected");
		} finally {
			await mcp.close();
		}
	});

	it("启动失败时把 stderr 尾部带进状态", async () => {
		const mcp = manager(server(["--fail"]));
		try {
			mcp.start();
			await mcp.awaitStartup();

			const status = mcp.status()[0]!;
			expect(status.status).toBe("unreachable");
			expect(status.detail).toContain("fixture startup failure");
		} finally {
			await mcp.close();
		}
	});

	it("disabled 的 server 不启动，状态保持 disabled", async () => {
		const mcp = manager({ ...server(), disabled: true });
		try {
			mcp.start();
			await mcp.awaitStartup();

			expect(mcp.status()).toEqual([{ name: "fixture", status: "disabled", detail: "" }]);
			expect(mcp.tools()).toEqual([]);
		} finally {
			await mcp.close();
		}
	});
});

describe("MCP manager 运行时增删", () => {
	it("addServer 后出现状态与工具，同名忽略", async () => {
		const mcp = new McpManager({
			projectRoot,
			servers: [],
			version: "0.0.0-test",
			reconnectDelaysMs: [],
			startupSettleMs: 5_000,
		});
		try {
			expect(mcp.hasServer("fixture")).toBe(false);
			mcp.addServer(server());
			mcp.addServer(server()); // 同名忽略，不会重复
			expect(mcp.hasServer("fixture")).toBe(true);
			expect(mcp.status()).toHaveLength(1);

			await mcp.awaitStartup();
			expect(mcp.tools().some((tool) => tool.name.startsWith("mcp__fixture__"))).toBe(true);
		} finally {
			await mcp.close();
		}
	});

	it("removeServer 停止连接并清掉工具，可再次 add 重建", async () => {
		const mcp = manager();
		try {
			mcp.start();
			await mcp.awaitStartup();
			expect(mcp.tools().length).toBeGreaterThan(0);

			expect(await mcp.removeServer("fixture")).toBe(true);
			expect(mcp.hasServer("fixture")).toBe(false);
			expect(mcp.status()).toEqual([]);
			expect(mcp.tools()).toEqual([]);
			expect(await mcp.removeServer("fixture")).toBe(false);

			// 移除后的连接是终结态；add 用新连接重建，工具重新出现。
			mcp.addServer(server());
			await mcp.awaitStartup();
			expect(mcp.tools().length).toBeGreaterThan(0);
		} finally {
			await mcp.close();
		}
	});

	it("replaceServer 用新配置替换同名 server 并重连", async () => {
		const mcp = manager();
		try {
			mcp.start();
			await mcp.awaitStartup();
			// 同名不同配置：替换后仍是 fixture，但连接是新建的（stop 是终结态）。
			await mcp.replaceServer({ ...server(["--replaced"]) });

			expect(mcp.hasServer("fixture")).toBe(true);
			expect(mcp.status().map((entry) => entry.name)).toEqual(["fixture"]);
			await mcp.awaitStartup();
			expect(mcp.tools().some((tool) => tool.name.startsWith("mcp__fixture__"))).toBe(true);
		} finally {
			await mcp.close();
		}
	});
});
