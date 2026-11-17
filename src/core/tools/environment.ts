import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { delimiter, join } from "node:path";

const TOOL_NAMES = [
	"git",
	"docker",
	"node",
	"npm",
	"pnpm",
	"yarn",
	"python",
	"pip",
	"go",
	"cargo",
	"mysql",
	"psql",
] as const;

export interface EnvironmentTool {
	readonly found: boolean;
	readonly path?: string;
	readonly version?: string;
}

export interface EnvironmentOptions {
	readonly platform?: NodeJS.Platform;
	readonly env?: NodeJS.ProcessEnv;
	readonly timeoutMs?: number;
}

/**
 * 探测常见本机开发工具及其版本，不会下载或安装任何程序。
 * @param options 平台、环境变量和版本探测超时配置。
 * @returns 工具名到探测结果的映射。
 */
export async function detectEnvironment(options: EnvironmentOptions = {}): Promise<Record<string, EnvironmentTool>> {
	const platform = options.platform ?? process.platform;
	const env = options.env ?? process.env;
	const results = await Promise.all(
		TOOL_NAMES.map(async (name) => {
			const executable = await findExecutable(name, platform, env);
			if (!executable) return [name, { found: false }] as const;
			const version = await readVersion(executable, platform, options.timeoutMs ?? 600);
			return [name, { found: true, path: executable, ...(version ? { version } : {}) }] as const;
		}),
	);
	return Object.fromEntries(results);
}

async function findExecutable(
	name: string,
	platform: NodeJS.Platform,
	env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
	const extensions =
		platform === "win32"
			? (env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").map((extension) => extension.toLowerCase())
			: [""];
	for (const directory of (env.PATH ?? "").split(platform === "win32" ? ";" : delimiter)) {
		for (const extension of extensions) {
			const candidate = join(directory, `${name}${extension}`);
			try {
				await access(candidate, platform === "win32" ? constants.F_OK : constants.X_OK);
				return candidate;
			} catch {
				// 忽略不存在或不可执行的候选路径，继续查询后续 PATH 目录。
			}
		}
	}
	return undefined;
}

async function readVersion(
	executable: string,
	platform: NodeJS.Platform,
	timeoutMs: number,
): Promise<string | undefined> {
	if (platform === "win32" && /\.(?:cmd|bat)$/i.test(executable)) return undefined;
	return new Promise((resolveVersion) => {
		const child = spawn(executable, ["--version"], {
			stdio: ["ignore", "pipe", "ignore"],
			windowsHide: true,
		});
		let output = "";
		child.stdout.on("data", (chunk: Buffer) => {
			output = (output + chunk.toString("utf8")).slice(0, 512);
		});
		const timeout = setTimeout(() => child.kill(), timeoutMs);
		child.once("error", () => {
			clearTimeout(timeout);
			resolveVersion(undefined);
		});
		child.once("close", (code) => {
			clearTimeout(timeout);
			resolveVersion(code === 0 ? output.trim().split(/\r?\n/)[0] : undefined);
		});
	});
}
