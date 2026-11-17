#!/usr/bin/env node
import { homedir } from "node:os";

import { ensureConfigFiles } from "#src/core/index.ts";
import { runCli } from "#src/cli/index.ts";

const args = process.argv.slice(2);
// 纯查询命令不碰用户目录：--version / --help 应该在任何环境下都零副作用。
const needsBootstrap = !args.includes("--version") && !args.includes("--help") && !args.includes("-v");

/**
 * 真实进程入口。
 *
 * 配置骨架在这里初始化，而不是塞进 runCli：后者是可注入依赖的纯分发函数，测试替换了 Core
 * 之后不该有写用户主目录的副作用。初始化是 best-effort，失败也不影响启动——loadConfig
 * 本身容忍文件缺失，配置问题留给 doctor 与 TUI 内的操作提示。
 */
const boot = needsBootstrap ? ensureConfigFiles(homedir()) : Promise.resolve({ created: [], errors: [] });

void boot
	.then(() => runCli(args))
	.then((code) => {
		if (code !== 0) process.exitCode = code;
	})
	.catch((error: unknown) => {
		const message = error instanceof Error ? error.message : String(error);
		process.stderr.write(`Error: ${message}\n`);
		process.exitCode = 1;
	});
