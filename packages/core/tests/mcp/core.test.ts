import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { Core } from "@moros/core/core.ts";

const fixture = resolve(import.meta.dirname, "../fixtures/mcp-stdio-server.mjs");
const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makeRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "moros-mcp-core-"));
	roots.push(root);
	return root;
}

async function createCore(): Promise<{ core: Core; home: string; projectRoot: string }> {
	const home = await makeRoot();
	const projectRoot = await makeRoot();
	await mkdir(join(home, ".moros"), { recursive: true });
	await writeFile(
		join(home, ".moros", "config.toml"),
		["[mcp_servers.fixture]", `command = '${process.execPath}'`, `args = ['${fixture}']`, "timeout = 10", ""].join(
			"\n",
		),
	);
	return { core: new Core({ homeDir: home }), home, projectRoot };
}

describe("Core MCP 接线", () => {
	it("prepareMcp 启动配置里的 server，mcpStatus 返回实时状态", async () => {
		const { core, projectRoot } = await createCore();
		try {
			await core.prepareMcp(projectRoot);
			await core.awaitMcpStartup(projectRoot);

			expect(core.mcpStatus(projectRoot)).toEqual([{ name: "fixture", status: "connected", detail: "6 tool(s)" }]);
			expect((await core.getConfigSummary(projectRoot)).mcpServers).toEqual([
				{ name: "fixture", type: "stdio", enabled: true },
			]);
		} finally {
			await core.dispose();
		}
	});

	it("doctor 报告 MCP 配置但不启动进程", async () => {
		const { core, projectRoot } = await createCore();
		try {
			const report = await core.doctor(projectRoot);
			expect(report.mcpServers).toEqual([{ name: "fixture", type: "stdio", enabled: true }]);
		} finally {
			await core.dispose();
		}
	});

	it("dispose 关闭连接并清空管理器", async () => {
		const { core, projectRoot } = await createCore();
		await core.prepareMcp(projectRoot);
		await core.awaitMcpStartup(projectRoot);
		await core.dispose();

		expect(core.mcpStatus(projectRoot)).toEqual([]);
	});
});

describe("Core MCP 配置写回与运行时重建", () => {
	it("upsertMcpServer 写回 config.toml 并让新 server 出现在运行时状态", async () => {
		const { core, home, projectRoot } = await createCore();
		try {
			await core.prepareMcp(projectRoot);
			await core.awaitMcpStartup(projectRoot);
			expect(core.mcpStatus(projectRoot).map((entry) => entry.name)).toEqual(["fixture"]);

			const config = await core.upsertMcpServer(projectRoot, "second", {
				type: "stdio",
				command: process.execPath,
				args: [fixture],
			});
			expect(config.name).toBe("second");
			expect(config.type).toBe("stdio");

			const text = await readFile(join(home, ".moros", "config.toml"), "utf8");
			expect(text).toContain("[mcp_servers.second]");
			expect(text).toContain("[mcp_servers.fixture]"); // 原有 server 保留

			// 双缓存失效：重新读到配置、管理器按新配置重建，两个 server 都在。
			const status = core.mcpStatus(projectRoot);
			expect(status.map((entry) => entry.name).sort()).toEqual(["fixture", "second"]);
			await core.awaitMcpStartup(projectRoot);
		} finally {
			await core.dispose();
		}
	});

	it("removeMcpServer 删除配置段并让运行时不再包含它", async () => {
		const { core, home, projectRoot } = await createCore();
		try {
			await core.prepareMcp(projectRoot);
			await core.awaitMcpStartup(projectRoot);
			await core.upsertMcpServer(projectRoot, "second", {
				type: "stdio",
				command: process.execPath,
				args: [fixture],
			});

			await core.removeMcpServer(projectRoot, "second");

			const text = await readFile(join(home, ".moros", "config.toml"), "utf8");
			expect(text).not.toContain("[mcp_servers.second]");
			expect(core.mcpStatus(projectRoot).map((entry) => entry.name)).toEqual(["fixture"]);
		} finally {
			await core.dispose();
		}
	});

	it("非法 draft 写回失败，不改变配置与运行时", async () => {
		const { core, home, projectRoot } = await createCore();
		try {
			await core.prepareMcp(projectRoot);
			await core.awaitMcpStartup(projectRoot);
			const before = await readFile(join(home, ".moros", "config.toml"), "utf8");

			// 既有 command 又有 url，parseMcpServers 校验失败。
			await expect(
				core.upsertMcpServer(projectRoot, "bad", {
					type: "stdio",
					command: "npx",
					url: "https://example.com/mcp",
				}),
			).rejects.toThrow();

			expect(await readFile(join(home, ".moros", "config.toml"), "utf8")).toBe(before);
			expect(core.mcpStatus(projectRoot).map((entry) => entry.name)).toEqual(["fixture"]);
		} finally {
			await core.dispose();
		}
	});

	it("reloadMcp 读取外部手改的配置并重建运行时", async () => {
		const { core, home, projectRoot } = await createCore();
		try {
			await core.prepareMcp(projectRoot);
			await core.awaitMcpStartup(projectRoot);
			// 外部直接改文件（模拟使用者手改）。
			await writeFile(
				join(home, ".moros", "config.toml"),
				["[mcp_servers.manual]", `command = '${process.execPath}'`, `args = ['${fixture}']`, ""].join("\n"),
			);
			expect(core.mcpStatus(projectRoot).map((entry) => entry.name)).toEqual(["fixture"]); // 失效前仍是旧状态

			await core.reloadMcp(projectRoot);
			expect(core.mcpStatus(projectRoot).map((entry) => entry.name)).toEqual(["manual"]);
		} finally {
			await core.dispose();
		}
	});
});
