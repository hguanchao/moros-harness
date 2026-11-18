import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { normalizeConfigKeys } from "@moros/core/config/keys.ts";
import { loadConfig } from "@moros/core/config/loader.ts";
import { parseConfig } from "@moros/core/config/schema.ts";
import { resolveMcpEnvironment } from "@moros/core/mcp/config.ts";
import type { McpServerConfig } from "@moros/core/mcp/types.ts";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makeRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "moros-mcp-config-"));
	roots.push(root);
	return root;
}

describe("MCP 配置解析", () => {
	it("解析 stdio server 并推断类型", () => {
		const { config, skipped } = parseConfig({
			mcpServers: {
				filesystem: {
					command: "npx",
					args: ["-y", "@modelcontextprotocol/server-filesystem", "."],
					env: { ROOT: "${MCP_ROOT}" },
					timeout: 30,
				},
			},
		});

		expect(skipped).toEqual([]);
		expect(config.mcpServers).toEqual([
			{
				name: "filesystem",
				type: "stdio",
				command: "npx",
				args: ["-y", "@modelcontextprotocol/server-filesystem", "."],
				url: undefined,
				headers: {},
				env: { ROOT: "${MCP_ROOT}" },
				timeoutSeconds: 30,
				disabled: false,
			},
		]);
	});

	it("有 url 时推断为 http，并保留 headers", () => {
		const { config } = parseConfig({
			mcpServers: {
				docs: { url: "https://example.com/mcp", headers: { Authorization: "Bearer ${DOCS_TOKEN}" } },
			},
		});

		expect(config.mcpServers[0]).toMatchObject({
			name: "docs",
			type: "http",
			command: undefined,
			url: "https://example.com/mcp",
			headers: { Authorization: "Bearer ${DOCS_TOKEN}" },
		});
	});

	it("sse 先保留为配置，连接阶段再明确报不支持", () => {
		const { config } = parseConfig({
			mcpServers: { legacy: { type: "sse", url: "https://example.com/sse" } },
		});

		expect(config.mcpServers[0]?.type).toBe("sse");
	});

	it("command 与 url 不能同时出现，也不能都没有", () => {
		const { config, skipped } = parseConfig({
			mcpServers: {
				both: { command: "node", url: "https://example.com/mcp" },
				neither: { args: [] },
			},
		});

		expect(config.mcpServers).toEqual([]);
		expect(skipped.map((entry) => entry.path)).toEqual(["mcp_servers.both", "mcp_servers.neither"]);
	});

	it("非法名称、未知字段与类型错误只跳过该条目", () => {
		const { config, skipped } = parseConfig({
			mcpServers: {
				"bad name": { command: "node" },
				good: { command: "node" },
				unknown: { command: "node", cwd: "." },
				wrong: { command: "node", timeout: 0 },
			},
		});

		expect(config.mcpServers.map((server) => server.name)).toEqual(["good"]);
		expect(skipped).toHaveLength(3);
	});

	it("mcp_servers 归一为 mcpServers，且不递归改写 server 名", () => {
		expect(normalizeConfigKeys({ mcp_servers: { shell_path: { command: "node" } } })).toEqual({
			mcpServers: { shell_path: { command: "node" } },
		});
	});
});

describe("MCP 配置装载", () => {
	it("只采纳用户级配置，项目级 mcp_servers 被忽略并报告", async () => {
		const home = await makeRoot();
		const project = await makeRoot();
		await mkdir(join(home, ".moros"), { recursive: true });
		await mkdir(join(project, ".moros"), { recursive: true });
		await writeFile(
			join(home, ".moros", "config.toml"),
			[
				'provider = "local"',
				'model = "main"',
				"",
				"[mcp_servers.global]",
				'command = "node"',
				'args = ["server.mjs"]',
			].join("\n"),
		);
		await writeFile(join(project, ".moros", "project.toml"), ["[mcp_servers.project]", 'command = "node"'].join("\n"));

		const loaded = await loadConfig({ homeDir: home, projectRoot: project });

		expect(loaded.config.mcpServers.map((server) => server.name)).toEqual(["global"]);
		expect(loaded.skipped).toContainEqual({
			path: "mcp_servers",
			reason: "MCP servers are user-level only; a project config cannot add or replace them",
		});
	});
});

describe("MCP 环境变量解析", () => {
	const server: McpServerConfig = {
		name: "docs",
		type: "http",
		command: undefined,
		args: [],
		url: "https://example.com/mcp",
		headers: { Authorization: "Bearer ${DOCS_TOKEN}" },
		env: { PLAIN: "value", FROM_ENV: "${FROM_ENV}" },
		timeoutSeconds: undefined,
		disabled: false,
	};

	it("支持值内嵌 ${ENV}", async () => {
		const resolved = await resolveMcpEnvironment(server, {
			env: { DOCS_TOKEN: "secret", FROM_ENV: "resolved" },
		});

		expect(resolved.headers).toEqual({ Authorization: "Bearer secret" });
		expect(resolved.env).toEqual({ PLAIN: "value", FROM_ENV: "resolved" });
	});

	it("缺失变量时抛错，由管理器标记该 server 不可用", async () => {
		await expect(resolveMcpEnvironment(server, { env: { FROM_ENV: "ok" } })).rejects.toThrow("DOCS_TOKEN");
	});
});
