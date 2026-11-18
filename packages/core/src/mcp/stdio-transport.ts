import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import process from "node:process";

import crossSpawn from "cross-spawn";

import { McpAbortError, McpConnectionClosedError, type JsonRpcMessage } from "./json-rpc.ts";
import { JsonRpcLineReader } from "./line-reader.ts";
import { TransportEvents, type McpTransport } from "./transport.ts";

const DEFAULT_CLOSE_TIMEOUT_MS = 2_000;
/** 关闭 stdin 后给 server 自行退出的宽限；很多 server 会在这里就结束。 */
const STDIN_CLOSE_GRACE_MS = 500;
const USE_PROCESS_GROUPS = process.platform !== "win32";

/** 仍存活的进程组；宿主异常退出时统一收掉，避免留下孤儿 server。 */
const liveProcessGroups = new Set<number>();
let exitHookInstalled = false;

/**
 * 杀掉 server 及其子进程。
 *
 * Windows 没有优雅信号，`npx`/`uvx` 又是通过 cmd.exe shim 启动的；只杀直接子进程会把真正
 * 的 server 留在后台，所以用 `taskkill /T /F` 整棵树。POSIX 下 server 在独立进程组里，
 * 向 `-pid` 发信号才能带走包装器的子进程。
 */
function killProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
	const pid = child.pid;
	if (process.platform === "win32" && pid !== undefined) {
		if (child.exitCode !== null) return;
		nodeSpawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
			stdio: "ignore",
			windowsHide: true,
		}).on("error", () => undefined);
		return;
	}
	if (USE_PROCESS_GROUPS && pid !== undefined) {
		try {
			process.kill(-pid, signal);
			return;
		} catch {
			// 进程组已经消失；退回直接子进程
		}
	}
	try {
		child.kill(signal);
	} catch {
		// pid 尚未分配或进程已退出，没有可杀的对象
	}
}

function installExitHook(): void {
	if (exitHookInstalled) return;
	exitHookInstalled = true;
	process.once("exit", () => {
		for (const pid of liveProcessGroups) {
			try {
				process.kill(-pid, "SIGTERM");
			} catch {
				// 进程组已不存在
			}
		}
	});
}

function unrefChild(child: ChildProcess): void {
	child.unref();
	for (const stream of [child.stdin, child.stdout, child.stderr]) {
		// 运行期管道是带 unref 的 Socket；server 只是能力提供者，不该拖住宿主退出
		(stream as { unref?: () => void } | null)?.unref?.();
	}
}

export interface StdioTransportOptions {
	readonly command: string;
	readonly args?: readonly string[];
	readonly cwd: string;
	/** 叠加在宿主环境之上的变量；默认继承宿主环境。 */
	readonly env?: Readonly<Record<string, string>>;
	/** false 时只传 `env`，不继承宿主环境。 */
	readonly inheritEnv?: boolean;
	readonly maxMessageBytes?: number;
	readonly maxStderrBytes?: number;
	/** SIGTERM 之后等多久发 SIGKILL，默认 2000ms。 */
	readonly closeTimeoutMs?: number;
	readonly onStderr?: (chunk: string) => void;
}

/**
 * 本地 MCP server 的 stdio 传输。
 *
 * 报文按行分帧，stdout 只认 JSON-RPC，stderr 只留尾部诊断。关闭遵循 MCP 的约定：
 * 关闭 stdin → 宽限 → SIGTERM → SIGKILL，并清理整个进程组。
 */
export class StdioTransport extends TransportEvents implements McpTransport {
	readonly #options: StdioTransportOptions;
	readonly #lines: JsonRpcLineReader;
	#child: ChildProcess | undefined;
	#started = false;
	#closed = false;

	constructor(options: StdioTransportOptions) {
		super();
		this.#options = options;
		this.#lines = new JsonRpcLineReader({
			...(options.maxMessageBytes === undefined ? {} : { maxMessageBytes: options.maxMessageBytes }),
			...(options.maxStderrBytes === undefined ? {} : { maxStderrBytes: options.maxStderrBytes }),
			onMessage: (message) => this.emitMessage(message),
			onError: (error) => this.emitError(error),
			...(options.onStderr ? { onStderr: options.onStderr } : {}),
		});
	}

	get pid(): number | undefined {
		return this.#child?.pid;
	}

	/** 最近收到的 stderr 尾部，连接失败时带进状态与 `/mcps`。 */
	get stderr(): string {
		return this.#lines.stderr;
	}

	async start(): Promise<void> {
		if (this.#started) throw new Error("MCP stdio transport already started");
		if (this.#closed) throw new McpConnectionClosedError();
		this.#started = true;

		const env =
			this.#options.inheritEnv === false ? { ...this.#options.env } : { ...process.env, ...this.#options.env };
		const child = crossSpawn(this.#options.command, [...(this.#options.args ?? [])], {
			cwd: this.#options.cwd,
			env,
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
			// 独立进程组，关闭时才能带走 npx/uvx 的子进程
			detached: USE_PROCESS_GROUPS,
		});
		this.#child = child;
		const pid = child.pid;
		if (USE_PROCESS_GROUPS && pid !== undefined) {
			installExitHook();
			liveProcessGroups.add(pid);
			child.once("close", () => liveProcessGroups.delete(pid));
		}

		child.stdout?.on("data", (chunk: Buffer) => this.#lines.readStdout(chunk));
		child.stdout?.on("error", (error) => this.emitError(error));
		child.stderr?.on("data", (chunk: Buffer) => this.#lines.readStderr(chunk));
		child.stderr?.on("error", (error) => this.emitError(error));
		child.stdin?.on("error", (error) => {
			if (!this.#closed) this.emitError(error);
		});
		child.on("close", () => {
			this.#child = undefined;
			this.#lines.end();
			this.emitClose();
		});
		unrefChild(child);

		// spawn 失败时 error 与 close 会先后到达；只认第一条能说清原因的事件
		await new Promise<void>((resolve, reject) => {
			const onSpawn = (): void => {
				child.off("error", onError);
				resolve();
			};
			const onError = (error: Error): void => {
				child.off("spawn", onSpawn);
				reject(error);
			};
			child.once("spawn", onSpawn);
			child.once("error", onError);
		});
		child.on("error", (error) => {
			if (!this.#closed) this.emitError(error);
		});
	}

	async send(message: JsonRpcMessage, options: { readonly signal?: AbortSignal } = {}): Promise<void> {
		const stdin = this.#child?.stdin;
		if (!this.#started || this.#closed || !stdin?.writable) throw new McpConnectionClosedError();
		if (options.signal?.aborted) throw new McpAbortError();
		const payload = `${JSON.stringify(message)}\n`;
		await new Promise<void>((resolve, reject) => {
			let settled = false;
			const finish = (error?: Error): void => {
				if (settled) return;
				settled = true;
				options.signal?.removeEventListener("abort", onAbort);
				if (error) reject(error);
				else resolve();
			};
			const onAbort = (): void => finish(new McpAbortError());
			options.signal?.addEventListener("abort", onAbort, { once: true });
			stdin.write(payload, (error) => finish(error ?? undefined));
		});
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		const child = this.#child;
		if (!child) {
			this.emitClose();
			return;
		}
		// 已经退出的进程没有可关的管道；close 事件会负责派发 emitClose
		if (child.exitCode !== null || child.signalCode !== null) {
			child.stdin?.end();
			return;
		}

		const closeTimeoutMs = this.#options.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS;
		const grace = Math.min(STDIN_CLOSE_GRACE_MS, closeTimeoutMs);
		await new Promise<void>((resolve) => {
			const timers: ReturnType<typeof setTimeout>[] = [];
			const cleanup = (): void => {
				for (const timer of timers) clearTimeout(timer);
				child.off("close", cleanup);
			};
			child.once("close", () => {
				cleanup();
				// 直接子进程退出了，但它的子进程可能还握着管道；再收一次进程组
				killProcessTree(child, "SIGTERM");
				resolve();
			});
			timers.push(setTimeout(() => killProcessTree(child, "SIGTERM"), grace));
			timers.push(setTimeout(() => killProcessTree(child, "SIGKILL"), grace + closeTimeoutMs));
			// 最坏情况下 close 事件不来，也不能让宿主一直等
			timers.push(
				setTimeout(
					() => {
						cleanup();
						resolve();
					},
					grace + closeTimeoutMs + 1_000,
				),
			);
			child.stdin?.end();
		});
	}
}
