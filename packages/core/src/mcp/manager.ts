import { basename } from "node:path";
import { pathToFileURL } from "node:url";

import type { ToolDefinition } from "../harness/types.ts";
import { DEFAULT_CALL_TIMEOUT_MS, McpClient } from "./client.ts";
import { resolveMcpEnvironment } from "./config.ts";
import { McpHttpError, StreamableHttpTransport } from "./http-transport.ts";
import { McpError, McpConnectionClosedError, JSON_RPC_ERROR_CODES, toError } from "./json-rpc.ts";
import { createMcpToolName } from "./naming.ts";
import { StdioTransport } from "./stdio-transport.ts";
import { createMcpTool, formatMcpProgress } from "./tools.ts";
import type { McpTransport } from "./transport.ts";
import type { McpCallResult, McpConnectionStatus, McpServerConfig, McpStatus, McpToolInfo } from "./types.ts";

/** 首条消息前给仍在握手的 server 的收口窗口；整个进程只等第一次。 */
export const STARTUP_SETTLE_MS = 3_000;
const STARTUP_POLL_MS = 100;
/** 断线重连的退避序列；耗尽后停在 unreachable，等使用者在 /mcps 里手动重连。 */
export const RECONNECT_DELAYS_MS = [2_000, 4_000, 8_000, 16_000, 30_000] as const;
/** stderr 只留尾部，够说清「为什么连不上」即可。 */
const STDERR_TAIL_CHARS = 2_000;

export interface McpManagerOptions {
	readonly projectRoot: string;
	readonly servers: readonly McpServerConfig[];
	readonly version: string;
	/** `${ENV}` / `!command` 的解析来源；缺省 process.env。 */
	readonly env?: NodeJS.ProcessEnv;
	/** HTTP 传输使用的 fetch；测试与代理注入用。 */
	readonly fetch?: typeof fetch;
	/** 测试注入：替换传输层构造。 */
	readonly transportFactory?: (
		config: McpServerConfig,
		environment: { readonly env: Record<string, string>; readonly headers: Record<string, string> },
	) => McpTransport;
	/** 测试注入：重连退避序列。 */
	readonly reconnectDelaysMs?: readonly number[];
	/** 测试注入：启动收口窗口。 */
	readonly startupSettleMs?: number;
}

type TransportFactory = NonNullable<McpManagerOptions["transportFactory"]>;

/**
 * 一个项目内全部 MCP server 的生命周期。
 *
 * 连接在后台进行，不阻塞宿主启动；工具清单是实时快照，连上后下一轮对话自动补进工具面。
 * 连接失败只影响该 server 的状态，不会让其它 server 或主流程停下来。断开后按固定退避
 * 重连，耗尽后停在 unreachable，由 `/mcps` 的 r 手动重连。
 */
export class McpManager {
	readonly #options: McpManagerOptions;
	readonly #connections: McpConnection[];
	readonly #startupSettleMs: number;
	#closed = false;
	#startupSettled = false;
	/** 工具对外名称缓存：`server\0tool` → 名称，重连后保持稳定。 */
	readonly #toolNames = new Map<string, string>();
	readonly #usedNames = new Set<string>();

	constructor(options: McpManagerOptions) {
		this.#options = options;
		this.#startupSettleMs = options.startupSettleMs ?? STARTUP_SETTLE_MS;
		this.#connections = options.servers.map((config) => this.#createConnection(config));
	}

	/** 用与构造时相同的注入选项创建一个连接；运行时增删复用，保证测试注入仍然生效。 */
	#createConnection(config: McpServerConfig): McpConnection {
		const options = this.#options;
		return new McpConnection(config, {
			projectRoot: options.projectRoot,
			version: options.version,
			...(options.env ? { env: options.env } : {}),
			...(options.fetch ? { fetch: options.fetch } : {}),
			...(options.transportFactory ? { transportFactory: options.transportFactory } : {}),
			reconnectDelaysMs: options.reconnectDelaysMs ?? RECONNECT_DELAYS_MS,
		});
	}

	/** 后台启动全部启用的 server；重复调用是幂等的。 */
	start(): void {
		if (this.#closed) return;
		for (const connection of this.#connections) void connection.start();
	}

	/** 当前可用的 MCP 工具；每次调用按连接状态重新生成，下一轮对话自然拿到新清单。 */
	tools(): readonly ToolDefinition[] {
		const tools: ToolDefinition[] = [];
		for (const connection of this.#connections) {
			if (!connection.isConnected) continue;
			for (const info of connection.toolInfos) {
				tools.push(
					createMcpTool({
						server: connection.name,
						info,
						name: this.#nameFor(connection.name, info.name),
						call: (tool, args, signal, onProgress) => connection.call(tool, args, signal, onProgress),
					}),
				);
			}
		}
		return tools;
	}

	/** 每个 server 的实时状态，供 `/mcps` 与启动握手轮询。 */
	status(): readonly McpStatus[] {
		return this.#connections.map((connection) => connection.status());
	}

	/**
	 * 等待握手收口；只等第一次。
	 * 超时照常放行，迟到的工具下一轮补上。
	 */
	async awaitStartup(): Promise<void> {
		if (this.#startupSettled) return;
		this.#startupSettled = true;
		const deadline = Date.now() + this.#startupSettleMs;
		while (Date.now() < deadline) {
			if (this.#connections.every((connection) => connection.status().status !== "connecting")) return;
			await new Promise<void>((resolve) => setTimeout(resolve, STARTUP_POLL_MS));
		}
	}

	/** 是否已有同名 server；运行时增删前去重。 */
	hasServer(name: string): boolean {
		return this.#connections.some((connection) => connection.name === name);
	}

	/**
	 * 运行时新增一个 server 并立即后台连接。同名已存在时忽略。
	 * 配置写回后调用，使变更在无进程重启的情况下生效。
	 */
	addServer(config: McpServerConfig): void {
		if (this.#closed || this.hasServer(config.name)) return;
		this.#connections.push(this.#createConnection(config));
		// 新增的 server 也要参与后续启动收口（若有等待中的 awaitStartup）。
		this.#startupSettled = false;
		if (!this.#closed) void this.#connections.at(-1)!.start();
	}

	/**
	 * 运行时移除一个 server：停止连接并清掉它的工具名缓存。
	 * McpConnection.stop() 是终结态，移除后不可再启动，需要时用 addServer 重建。
	 * @returns 是否命中并移除了该 server。
	 */
	async removeServer(name: string): Promise<boolean> {
		const connection = this.#connections.find((candidate) => candidate.name === name);
		if (connection === undefined) return false;
		await connection.stop();
		this.#connections.splice(this.#connections.indexOf(connection), 1);
		for (const key of [...this.#toolNames.keys()]) {
			if (key.startsWith(`${name}\0`)) {
				this.#usedNames.delete(this.#toolNames.get(key)!);
				this.#toolNames.delete(key);
			}
		}
		return true;
	}

	/** 用新配置替换一个 server（先移除旧连接再新增），保持运行时与配置一致。 */
	async replaceServer(config: McpServerConfig): Promise<void> {
		await this.removeServer(config.name);
		this.addServer(config);
	}

	/** 手动重连一个 server；返回给使用者看的结果说明。 */
	async reconnect(name: string): Promise<string> {
		const connection = this.#find(name);
		return connection.reconnect();
	}

	/** 检查全部连接；每个 server 一行。 */
	async healthCheck(): Promise<readonly string[]> {
		return Promise.all(this.#connections.map((connection) => connection.healthCheck()));
	}

	/** 关闭全部连接与重连定时器；可重复调用。 */
	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		await Promise.allSettled(this.#connections.map((connection) => connection.stop()));
	}

	#find(name: string): McpConnection {
		const connection = this.#connections.find((candidate) => candidate.name === name);
		if (!connection) throw new Error(`Unknown MCP server: ${name}`);
		return connection;
	}

	#nameFor(server: string, tool: string): string {
		const owner = `${server}\0${tool}`;
		const existing = this.#toolNames.get(owner);
		if (existing !== undefined) return existing;
		const name = createMcpToolName(server, tool, (candidate) => this.#usedNames.has(candidate));
		this.#toolNames.set(owner, name);
		this.#usedNames.add(name);
		return name;
	}
}

interface McpConnectionOptions {
	readonly projectRoot: string;
	readonly version: string;
	readonly env?: NodeJS.ProcessEnv;
	readonly fetch?: typeof fetch;
	readonly transportFactory?: TransportFactory;
	readonly reconnectDelaysMs: readonly number[];
}

/** 单个 server 的连接、状态与重连。 */
class McpConnection {
	readonly #config: McpServerConfig;
	readonly #options: McpConnectionOptions;
	#status: McpConnectionStatus;
	#failure = "";
	#stderrTail = "";
	#toolInfos: McpToolInfo[] = [];
	#client: McpClient | undefined;
	#transport: McpTransport | undefined;
	#reconnectAttempts = 0;
	#reconnectTimer: ReturnType<typeof setTimeout> | undefined;
	#starting: Promise<void> | undefined;
	#stopped = false;

	constructor(config: McpServerConfig, options: McpConnectionOptions) {
		this.#config = config;
		this.#options = options;
		this.#status = config.disabled ? "disabled" : "connecting";
	}

	get name(): string {
		return this.#config.name;
	}

	get toolInfos(): readonly McpToolInfo[] {
		return this.#toolInfos;
	}

	get isConnected(): boolean {
		return this.#status === "connected" && this.#client !== undefined;
	}

	/** 启动或重连；失败写进状态，不向调用方抛错。 */
	start(force = false): Promise<void> {
		if (this.#stopped || this.#config.disabled) return Promise.resolve();
		if (!force && this.#status === "connected") return Promise.resolve();
		if (this.#starting) return this.#starting;
		this.#starting = this.#startInternal().finally(() => {
			this.#starting = undefined;
		});
		return this.#starting;
	}

	async #startInternal(): Promise<void> {
		// 重连前先收掉旧连接：两个连接同时存在会让工具调用落到哪个都不确定
		await this.#closeClient();
		this.#status = "connecting";
		this.#failure = "";
		this.#stderrTail = "";

		if (this.#config.type === "sse") {
			this.#markUnreachable("SSE transport is not supported; use Streamable HTTP instead", false);
			return;
		}

		let environment: { env: Record<string, string>; headers: Record<string, string> };
		try {
			environment = await resolveMcpEnvironment(this.#config, {
				...(this.#options.env ? { env: this.#options.env } : {}),
			});
		} catch (error) {
			this.#markUnreachable(`Cannot resolve environment: ${errorText(error)}`, false);
			return;
		}
		if (this.#stopped) return;

		let transport: McpTransport;
		try {
			transport = this.#createTransport(environment);
		} catch (error) {
			this.#markUnreachable(errorText(error), false);
			return;
		}
		if (this.#stopped) {
			await transport.close().catch(() => undefined);
			return;
		}
		this.#transport = transport;
		const client = new McpClient({
			transport,
			clientName: "moros",
			version: this.#options.version,
			callTimeoutMs:
				this.#config.timeoutSeconds === undefined ? DEFAULT_CALL_TIMEOUT_MS : this.#config.timeoutSeconds * 1_000,
			roots: [{ uri: pathToFileURL(this.#options.projectRoot).href, name: basename(this.#options.projectRoot) }],
			onNotification: (method) => {
				if (method === "notifications/tools/list_changed") void this.#refreshTools();
			},
			onError: (error) => {
				// 解析失败、管道错误等非致命问题：留在 stderr 尾部，别把连接直接判死
				this.#stderrTail = tail(`${this.#stderrTail}\n${errorText(error)}`);
			},
		});
		this.#client = client;
		// 进程退出/HTTP 流结束时把状态改为 unreachable 并排期重连。主动 close 会先把
		// #client 置空，因此这里不会把「用户重连」误判成「连接掉了」。
		transport.onClose(() => {
			if (this.#stopped || this.#client !== client) return;
			this.#status = "unreachable";
			this.#failure = "Connection closed";
			this.#toolInfos = [];
			this.#scheduleReconnect();
		});

		try {
			await client.connect();
			let tools: readonly McpToolInfo[];
			try {
				tools = await client.listTools();
			} catch (error) {
				// server 没声明 tools 能力时不回答 tools/list；按「没有工具」处理
				if (error instanceof McpError && error.code === JSON_RPC_ERROR_CODES.methodNotFound) tools = [];
				else throw error;
			}
			// 握手期间使用者可能已经关闭/移除该 server，别把已收掉的连接再标成可用
			if (this.#stopped) {
				await this.#closeClient();
				return;
			}
			this.#toolInfos = [...tools];
			this.#status = "connected";
			this.#failure = "";
			this.#stderrTail = "";
			this.#reconnectAttempts = 0;
			this.#clearReconnectTimer();
		} catch (error) {
			const detail = errorText(error);
			const stderr = this.#transport instanceof StdioTransport ? this.#transport.stderr.trim() : "";
			this.#stderrTail = tail([stderr, this.#stderrTail].filter(Boolean).join("\n"));
			await this.#closeClient();
			this.#markUnreachable(detail);
		}
	}

	/** 执行一次远端调用；连接不可用时返回错误结果而不是抛错。 */
	async call(
		tool: string,
		args: Record<string, unknown>,
		signal: AbortSignal | undefined,
		onProgress: (text: string) => void,
	): Promise<McpCallResult> {
		const client = this.#client;
		if (client === undefined || this.#status !== "connected") {
			const reason = this.#failure.length > 0 ? this.#failure : "not connected yet";
			return { content: `MCP server ${this.name} is unavailable: ${reason}`, isError: true };
		}
		try {
			return await client.callTool(tool, args, {
				...(signal ? { signal } : {}),
				onProgress: (progress) => {
					const text = formatMcpProgress(progress);
					if (text !== undefined) onProgress(text);
				},
			});
		} catch (error) {
			return { content: `MCP tool ${this.name}/${tool} failed: ${errorText(error)}`, isError: true };
		}
	}

	/** 手动重连；返回结果说明。 */
	async reconnect(): Promise<string> {
		if (this.#stopped) return `${this.name} has been removed`;
		if (this.#config.disabled) return `${this.name} is disabled in config.toml`;
		this.#clearReconnectTimer();
		this.#reconnectAttempts = 0;
		await this.start(true);
		if (this.#status === "connected") {
			return `Reconnected ${this.name}: ${this.#toolInfos.length} tool(s)`;
		}
		return `Could not reconnect ${this.name}: ${this.#failure.length > 0 ? this.#failure : "unknown error"}`;
	}

	/** 健康检查；失败时标记不可用并排期重连。 */
	async healthCheck(): Promise<string> {
		if (this.#stopped) return `${this.name}: removed`;
		if (this.#config.disabled) return `${this.name}: disabled`;
		const client = this.#client;
		if (client === undefined || this.#status !== "connected") {
			const detail = this.#failure.length > 0 ? ` (${this.#failure})` : "";
			return `${this.name}: ${this.#status}${detail}`;
		}
		try {
			await client.ping();
			return `${this.name}: ok`;
		} catch (error) {
			this.#failure = errorText(error);
			this.#status = "unreachable";
			await this.#closeClient();
			this.#scheduleReconnect();
			return `${this.name}: failed (${this.#failure})`;
		}
	}

	/** 一行状态；连接失败必须把原因带出来。 */
	status(): McpStatus {
		if (this.#stopped || this.#config.disabled) {
			return { name: this.name, status: "disabled", detail: "" };
		}
		switch (this.#status) {
			case "connecting":
				return { name: this.name, status: "connecting", detail: "" };
			case "connected":
				return {
					name: this.name,
					status: "connected",
					detail: this.#toolInfos.length === 0 ? "no tools" : `${this.#toolInfos.length} tool(s)`,
				};
			case "unreachable": {
				const retry =
					this.#reconnectTimer === undefined
						? this.#reconnectAttempts >= this.#options.reconnectDelaysMs.length
							? " (retries exhausted; reconnect from /mcps)"
							: ""
						: ` (retrying: attempt ${this.#reconnectAttempts}/${this.#options.reconnectDelaysMs.length})`;
				const detail = this.#stderrTail.length > 0 ? `${this.#failure}\n${this.#stderrTail}` : this.#failure;
				return { name: this.name, status: "unreachable", detail: `${detail}${retry}` };
			}
			case "disabled":
				return { name: this.name, status: "disabled", detail: "" };
		}
	}

	/** 停止连接、清掉重连定时器；幂等。 */
	async stop(): Promise<void> {
		if (this.#stopped) return;
		this.#stopped = true;
		this.#clearReconnectTimer();
		const starting = this.#starting;
		await this.#closeClient();
		await starting?.catch(() => undefined);
		this.#toolInfos = [];
		this.#status = "disabled";
	}

	async #refreshTools(): Promise<void> {
		const client = this.#client;
		if (client === undefined || this.#status !== "connected") return;
		try {
			this.#toolInfos = [...(await client.listTools())];
		} catch (error) {
			// 拉清单失败不改连接状态；下一次 list_changed 或重连会再试
			this.#stderrTail = tail(`${this.#stderrTail}\n${errorText(error)}`);
		}
	}

	#createTransport(environment: {
		readonly env: Record<string, string>;
		readonly headers: Record<string, string>;
	}): McpTransport {
		if (this.#options.transportFactory !== undefined) {
			return this.#options.transportFactory(this.#config, environment);
		}
		if (this.#config.type === "stdio") {
			return new StdioTransport({
				command: this.#config.command ?? "",
				args: this.#config.args,
				cwd: this.#options.projectRoot,
				env: environment.env,
				onStderr: (chunk) => {
					this.#stderrTail = tail(`${this.#stderrTail}${chunk}`);
				},
			});
		}
		if (this.#config.type === "http") {
			return new StreamableHttpTransport({
				url: this.#config.url ?? "",
				headers: environment.headers,
				...(this.#options.fetch ? { fetch: this.#options.fetch } : {}),
			});
		}
		// sse 是旧式传输；配置保留但明确报不支持，避免把配置错误伪装成网络失败
		throw new Error("SSE transport is not supported; use Streamable HTTP instead");
	}

	#markUnreachable(message: string, retry = true): void {
		if (this.#stopped) return;
		this.#status = "unreachable";
		this.#failure = message;
		this.#toolInfos = [];
		if (retry) this.#scheduleReconnect();
	}

	/** 断线后的自动重连；退避耗尽就停在 unreachable，等手动重连。 */
	#scheduleReconnect(): void {
		if (this.#stopped || this.#config.disabled) return;
		if (this.#reconnectTimer !== undefined) return;
		const delay = this.#options.reconnectDelaysMs[this.#reconnectAttempts];
		if (delay === undefined) return;
		this.#reconnectAttempts += 1;
		const timer = setTimeout(() => {
			this.#reconnectTimer = undefined;
			void this.start(true);
		}, delay);
		timer.unref?.();
		this.#reconnectTimer = timer;
	}

	#clearReconnectTimer(): void {
		if (this.#reconnectTimer === undefined) return;
		clearTimeout(this.#reconnectTimer);
		this.#reconnectTimer = undefined;
	}

	async #closeClient(): Promise<void> {
		const client = this.#client;
		this.#client = undefined;
		this.#transport = undefined;
		await client?.close().catch(() => undefined);
	}
}

function errorText(error: unknown): string {
	const text =
		error instanceof McpHttpError
			? error.body.length > 0
				? `${error.message}: ${error.body}`
				: error.message
			: error instanceof McpConnectionClosedError
				? error.message
				: toError(error).message;
	return redactText(text);
}

function tail(text: string): string {
	const redacted = redactText(text);
	return redacted.length > STDERR_TAIL_CHARS ? redacted.slice(-STDERR_TAIL_CHARS) : redacted;
}

/** 状态行会展示 server 的错误与 stderr，常见的密钥形态先粗脱敏再截断。 */
function redactText(text: string): string {
	return text
		.replace(/(api[_-]?key|token|password|secret|authorization)\s*[:=]\s*\S+/gi, "$1=***")
		.replace(/Bearer\s+\S+/gi, "Bearer ***");
}
