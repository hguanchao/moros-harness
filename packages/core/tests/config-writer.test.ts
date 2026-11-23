import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { updateGlobalMcpServers } from "../src/config/writer.ts";

describe("updateGlobalMcpServers 保注释写回", () => {
	let homeDir: string;
	let configPath: string;

	beforeEach(async () => {
		homeDir = await mkdtemp(join(tmpdir(), "moros-mcp-writer-"));
		configPath = join(homeDir, ".moros", "config.toml");
		await mkdir(join(homeDir, ".moros"), { recursive: true });
	});

	afterEach(async () => {
		await rm(homeDir, { recursive: true, force: true });
	});

	it("新建 server 表并保留已有注释与其它表", async () => {
		await writeFile(configPath, '# 顶层注释\nprovider = "local"\n\n# 保留这段注释\n[limits]\nmaxTurns = 8\n', "utf8");

		await updateGlobalMcpServers(
			{
				set: {
					files: { type: "stdio", command: "npx", args: ["-y", "mcp-server-files"], env: { TOKEN: "a=b" } },
				},
			},
			{ homeDir },
		);

		const text = await readFile(configPath, "utf8");
		expect(text).toContain("# 顶层注释");
		expect(text).toContain("# 保留这段注释");
		expect(text).toContain("[limits]\nmaxTurns = 8");
		expect(text).toContain("[mcp_servers.files]");
		expect(text).toContain('type = "stdio"');
		expect(text).toContain('command = "npx"');
		expect(text).toContain('args = [ "-y", "mcp-server-files" ]');
		expect(text).toContain('env = { TOKEN = "a=b" }');
	});

	it("已存在的表原位更新字段，未覆盖的字段与注释保留", async () => {
		await writeFile(
			configPath,
			'[mcp_servers.docs]\n# 这是注释\ntype = "stdio"\ncommand = "old"\ntimeout = 30\n\n[trusts]\n',
			"utf8",
		);

		await updateGlobalMcpServers({ set: { docs: { command: "new-cmd" } } }, { homeDir });

		const text = await readFile(configPath, "utf8");
		expect(text).toContain("# 这是注释");
		expect(text).toContain('command = "new-cmd"');
		expect(text).toContain("timeout = 30");
		expect(text).not.toContain('command = "old"');
		expect(text).toContain("[trusts]");
	});

	it("删除一个 server 整段，保留其后表", async () => {
		await writeFile(
			configPath,
			'[mcp_servers.a]\ntype = "stdio"\ncommand = "a"\n\n[mcp_servers.b]\ntype = "stdio"\ncommand = "b"\n\n[limits]\nmaxTurns = 8\n',
			"utf8",
		);

		await updateGlobalMcpServers({ remove: ["a"] }, { homeDir });

		const text = await readFile(configPath, "utf8");
		expect(text).not.toContain("[mcp_servers.a]");
		expect(text).toContain('command = "b"');
		expect(text).toContain("[limits]\nmaxTurns = 8");
	});

	it("空补丁不写文件", async () => {
		await writeFile(configPath, 'provider = "local"\n', "utf8");
		const before = await readFile(configPath, "utf8");
		await updateGlobalMcpServers({}, { homeDir });
		expect(await readFile(configPath, "utf8")).toBe(before);
	});
});
