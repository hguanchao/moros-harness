import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

async function createCore(): Promise<{ core: Core; projectRoot: string }> {
	const home = await makeRoot();
	const projectRoot = await makeRoot();
	await mkdir(join(home, ".moros"), { recursive: true });
	await writeFile(
		join(home, ".moros", "config.toml"),
		["[mcp_servers.fixture]", `command = '${process.execPath}'`, `args = ['${fixture}']`, "timeout = 10", ""].join(
			"\n",
		),
	);
	return { core: new Core({ homeDir: home }), projectRoot };
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
