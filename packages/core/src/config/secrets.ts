import { spawn } from "node:child_process";

export interface SecretResolverOptions {
	env?: NodeJS.ProcessEnv;
	runCommand?: (command: string, signal?: AbortSignal) => Promise<string>;
	signal?: AbortSignal;
}

/** 解析环境变量或 !command 密钥，并在失败信息中隐藏原始值。 */
export async function resolveSecret(value: string, options: SecretResolverOptions = {}): Promise<string> {
	const env = options.env ?? process.env;
	const envMatch = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(value);
	if (envMatch) {
		const secret = env[envMatch[1]!];
		if (!secret) throw new Error(`Secret environment variable ${envMatch[1]} is not set`);
		return secret;
	}
	if (value.startsWith("!")) {
		const command = value.slice(1).trim();
		if (!command) throw new Error("Secret command is empty");
		const runner = options.runCommand ?? runSecretCommand;
		try {
			const secret = (await runner(command, options.signal)).split(/\r?\n/, 1)[0]?.trim();
			if (!secret) throw new Error("command returned an empty value");
			return secret;
		} catch {
			throw new Error("Secret command failed");
		}
	}
	return value;
}

/**
 * 递归把疑似密钥的字段值替换成 `***`。
 *
 * 判据是「键名匹配 api_key / authorization / cookie / secret / token / password」且值为
 * 字符串；命中后只替换值、保留键，便于对照配置结构排查问题。用于把配置或请求写进日志、
 * 会话导出与错误信息时脱敏。
 */
export function redactSecrets(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(redactSecrets);
	if (!value || typeof value !== "object") return value;
	return Object.fromEntries(
		Object.entries(value).map(([key, child]) => [
			key,
			/api.?key|authorization|cookie|secret|token|password/i.test(key) && typeof child === "string"
				? "***"
				: redactSecrets(child),
		]),
	);
}

/** 用系统默认 shell 执行 `!command`；不继承 stdin，输出超过 64 KB 时提前终止。 */
export async function runSecretCommand(command: string, signal?: AbortSignal): Promise<string> {
	if (signal?.aborted) throw abortError();
	const isWindows = process.platform === "win32";
	const shell = isWindows ? (process.env.ComSpec ?? "cmd.exe") : (process.env.SHELL ?? "/bin/sh");
	const args = isWindows ? ["/d", "/s", "/c", command] : ["-lc", command];
	return new Promise((resolve, reject) => {
		const child = spawn(shell, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
		let stdout = "";
		const kill = () => child.kill();
		signal?.addEventListener("abort", kill, { once: true });
		child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
			stdout += chunk;
			if (stdout.length > 64 * 1024) child.kill();
		});
		child.once("error", () => {
			signal?.removeEventListener("abort", kill);
			reject(new Error("Secret command could not be started"));
		});
		child.once("close", (code) => {
			signal?.removeEventListener("abort", kill);
			if (signal?.aborted) reject(abortError());
			else if (code !== 0) reject(new Error(`Secret command exited with code ${code}`));
			else resolve(stdout);
		});
	});
}

function abortError(): Error {
	const error = new Error("Secret resolution aborted");
	error.name = "AbortError";
	return error;
}
