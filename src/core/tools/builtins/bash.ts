import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";

import { z } from "zod";

import type { ToolContext, ToolDefinition, ToolResult } from "#src/core/harness/types.ts";
import { asToolArguments } from "#src/core/tools/tool-utils.ts";

const BASH_SCHEMA = z.object({
	command: z.string().min(1).describe("Shell command to execute from the project root."),
	timeout: z.number().positive().max(86_400).optional().describe("Optional command timeout in seconds."),
});
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

export interface BashToolOptions {
	readonly shellPath?: string;
	readonly platform?: NodeJS.Platform;
	readonly env?: NodeJS.ProcessEnv;
	readonly timeoutMs?: number;
	readonly now?: () => number;
}

/**
 * 建立本机 Bash 或 PowerShell 工具；只负责启动命令，不处理审批与沙箱。
 * @param options Shell 可执行文件、环境、超时及时钟配置。
 * @returns 交由统一 Harness 管线控制的 Shell 工具。
 */
export function createBashTool(options: BashToolOptions = {}): ToolDefinition {
	const platform = options.platform ?? process.platform;
	const shellPath = options.shellPath ?? defaultShell(platform, options.env ?? process.env);
	const powerShell = isPowerShell(shellPath);
	return {
		name: powerShell ? "powershell" : "bash",
		description:
			"Run a local shell command from the project root. Commands require approval and auditing; the shell is not an OS-level sandbox.",
		schema: BASH_SCHEMA,
		resource: "shell",
		command: (args) => asToolArguments(args).command as string,
		execute: (args, context) => executeCommand(asToolArguments(args), context, shellPath, platform, options),
	};
}

async function executeCommand(
	args: Record<string, unknown>,
	context: ToolContext,
	shellPath: string,
	platform: NodeJS.Platform,
	options: BashToolOptions,
): Promise<ToolResult> {
	if (context.signal?.aborted) throw abortError();
	await access(context.projectRoot, constants.F_OK);
	const timeoutMs = args.timeout === undefined ? (options.timeoutMs ?? 120_000) : (args.timeout as number) * 1000;
	const shellArgs = createShellArguments(shellPath, args.command as string, platform);
	const child = spawn(shellPath, shellArgs, {
		cwd: context.projectRoot,
		env: options.env ?? process.env,
		stdio: ["ignore", "pipe", "pipe"],
		windowsHide: true,
		detached: platform !== "win32",
	});
	const decoder = new StringDecoder("utf8");
	const startedAt = (options.now ?? Date.now)();
	let outputBytes = 0;
	let outputTruncated = false;
	let timedOut = false;
	let outputError: unknown;
	let pendingWrite: Promise<void> = Promise.resolve();
	const abort = () => terminate(child, platform);
	const timeout = setTimeout(() => {
		timedOut = true;
		terminate(child, platform);
	}, timeoutMs);
	context.signal?.addEventListener("abort", abort, { once: true });

	const writeChunk = (chunk: Buffer): void => {
		const remaining = MAX_OUTPUT_BYTES - outputBytes;
		if (remaining <= 0) {
			outputTruncated = true;
			return;
		}
		const accepted = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
		outputBytes += accepted.length;
		if (accepted.length < chunk.length) outputTruncated = true;
		const decoded = decoder.write(accepted);
		if (!decoded || !context.writeOutput) return;
		child.stdout.pause();
		child.stderr.pause();
		pendingWrite = pendingWrite
			.then(() => context.writeOutput!(decoded))
			.catch((error: unknown) => {
				outputError = error;
				terminate(child, platform);
			})
			.finally(() => {
				child.stdout.resume();
				child.stderr.resume();
			});
	};
	child.stdout.on("data", writeChunk);
	child.stderr.on("data", writeChunk);

	try {
		const exitCode = await waitForChild(child);
		await pendingWrite;
		if (outputError) throw outputError;
		if (context.signal?.aborted) throw abortError();
		const finalChunk = decoder.end();
		if (finalChunk && context.writeOutput) await context.writeOutput(finalChunk);
		const durationMs = Math.max(0, (options.now ?? Date.now)() - startedAt);
		const status = timedOut ? "timeout" : `exit=${exitCode}`;
		return {
			content: `${status} duration=${durationMs}ms${outputTruncated ? " output-truncated" : ""}`,
			isError: timedOut || exitCode !== 0,
		};
	} finally {
		clearTimeout(timeout);
		context.signal?.removeEventListener("abort", abort);
	}
}

function createShellArguments(shellPath: string, command: string, platform: NodeJS.Platform): string[] {
	if (platform === "win32" && isPowerShell(shellPath)) {
		// Windows PowerShell 5.1 把管道输出按控制台 OEM 代码页编码（中文机器常为 936），
		// Node 侧按 UTF-8 解码会得到乱码。执行前把控制台输出编码切到 UTF-8；命令文本
		// 保持原样，审批卡与工具行里看到的仍是模型给出的那条命令。
		return [
			"-NoLogo",
			"-NoProfile",
			"-NonInteractive",
			"-Command",
			`[Console]::OutputEncoding = [Text.Encoding]::UTF8; ${command}`,
		];
	}
	if (platform === "win32" && isCmd(shellPath)) {
		// cmd.exe 不认 bash 的 --noprofile/-lc。管道输出没有控制台代码页，chcp 改不了
		// 已创建管道的字节编码，因此统一按 UTF-8 解码；git/node 等本机工具本身就是 UTF-8，
		// 只有 cmd 内建命令的中文可能乱码，需要中文时建议 shell_path 指 PowerShell。
		return ["/d", "/s", "/c", command];
	}
	if (platform === "win32") return ["--noprofile", "-lc", command];
	return ["-lc", command];
}

function isPowerShell(shellPath: string): boolean {
	return /(?:^|[\\/])(?:pwsh|powershell)(?:\.exe)?$/i.test(shellPath);
}

function isCmd(shellPath: string): boolean {
	return /(?:^|[\\/])cmd(?:\.exe)?$/i.test(shellPath);
}

function defaultShell(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string {
	if (env.MOROS_SHELL) return env.MOROS_SHELL;
	if (platform === "win32") return "powershell.exe";
	return env.SHELL ?? "/bin/sh";
}

function waitForChild(child: ReturnType<typeof spawn>): Promise<number> {
	return new Promise((resolve, reject) => {
		child.once("error", reject);
		child.once("close", (code) => resolve(code ?? 1));
	});
}

function terminate(child: ReturnType<typeof spawn>, platform: NodeJS.Platform): void {
	if (!child.pid) return;
	if (platform === "win32") {
		// child.kill 只结束 shell 本身；npm test 之类孙进程仍持有管道继续跑，
		// close 要等它们全部退出，超时形同虚设。taskkill /T 结束整棵树。
		const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
		killer.once("error", () => child.kill());
		return;
	}
	try {
		process.kill(-child.pid, "SIGTERM");
	} catch {
		child.kill();
	}
}

function abortError(): Error {
	const error = new Error("Shell execution aborted");
	error.name = "AbortError";
	return error;
}
