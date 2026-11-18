import { describe, expect, it } from "vitest";

import { McpClient, LATEST_PROTOCOL_VERSION } from "#src/core/mcp/client.ts";
import { McpAbortError, McpTimeoutError, type JsonRpcMessage, type JsonRpcRequest } from "#src/core/mcp/json-rpc.ts";
import { TransportEvents, type McpTransport } from "#src/core/mcp/transport.ts";

type Handler = (message: JsonRpcRequest) => unknown | Promise<unknown>;

/** 按脚本应答的传输层；`push` 用于模拟服务端主动发消息。 */
class FakeTransport extends TransportEvents implements McpTransport {
	readonly sent: JsonRpcMessage[] = [];
	readonly #handler: Handler;

	constructor(handler: Handler) {
		super();
		this.#handler = handler;
	}

	async start(): Promise<void> {}

	async send(message: JsonRpcMessage, options: { readonly signal?: AbortSignal } = {}): Promise<void> {
		this.sent.push(message);
		if (options.signal?.aborted) throw new McpAbortError();
		if (!("id" in message) || !("method" in message)) return;
		const result = await this.#handler(message as JsonRpcRequest);
		queueMicrotask(() => this.emitMessage({ jsonrpc: "2.0", id: message.id, result }));
	}

	async close(): Promise<void> {
		this.emitClose();
	}

	push(message: JsonRpcMessage): void {
		this.emitMessage(message);
	}
}

function methodOf(message: JsonRpcMessage): string | undefined {
	return "method" in message && typeof message.method === "string" ? message.method : undefined;
}

function idOf(message: JsonRpcMessage): unknown {
	return "id" in message ? message.id : undefined;
}

const ECHO_TOOL = {
	name: "echo",
	description: "Echo text",
	inputSchema: { type: "object", properties: { text: { type: "string" } } },
};

function initializeResult(version = LATEST_PROTOCOL_VERSION): unknown {
	return {
		protocolVersion: version,
		capabilities: { tools: {} },
		serverInfo: { name: "fake", version: "1.0.0" },
	};
}

async function connect(handler: Handler): Promise<{ client: McpClient; transport: FakeTransport }> {
	const transport = new FakeTransport(handler);
	const client = new McpClient({
		transport,
		clientName: "test",
		version: "1.0.0",
		callTimeoutMs: 1_000,
		roots: [{ uri: "file:///workspace", name: "workspace" }],
	});
	await client.connect();
	return { client, transport };
}

describe("MCP client 握手与列表", () => {
	it("initialize 后发 initialized，并记录 server 能力", async () => {
		const { client, transport } = await connect((message) => {
			if (message.method === "initialize") return initializeResult();
			return { tools: [ECHO_TOOL] };
		});

		expect(client.state).toBe("connected");
		expect(client.serverCapabilities).toEqual({ tools: {} });
		expect(transport.sent.some((message) => methodOf(message) === "notifications/initialized")).toBe(true);
		await client.close();
	});

	it("按 cursor 翻完 tools/list 的所有页", async () => {
		const { client } = await connect((message) => {
			if (message.method === "initialize") return initializeResult();
			if (message.method !== "tools/list") return {};
			const cursor = (message.params as { cursor?: string } | undefined)?.cursor;
			if (cursor === undefined) {
				return { tools: [ECHO_TOOL], nextCursor: "page-2" };
			}
			return { tools: [{ name: "second", description: "", inputSchema: {} }] };
		});

		const tools = await client.listTools();
		expect(tools.map((tool) => tool.name)).toEqual(["echo", "second"]);
		expect(tools[1]?.inputSchema).toEqual({ type: "object", properties: {} });
		await client.close();
	});

	it("重复 cursor 视为协议错误", async () => {
		const { client } = await connect((message) => {
			if (message.method === "initialize") return initializeResult();
			if (message.method !== "tools/list") return {};
			return { tools: [ECHO_TOOL], nextCursor: "same" };
		});

		await expect(client.listTools()).rejects.toThrow("repeated cursor");
		await client.close();
	});
});

describe("MCP client 工具调用", () => {
	it("文本、isError 与 structuredContent 都转成模型可读结果", async () => {
		const { client } = await connect((message) => {
			if (message.method === "initialize") return initializeResult();
			if (message.method !== "tools/call") return {};
			const name = (message.params as { name: string }).name;
			if (name === "fail") return { isError: true, content: [{ type: "text", text: "boom" }] };
			if (name === "structured") return { content: [], structuredContent: { answer: 42 } };
			return { content: [{ type: "text", text: "hello" }] };
		});

		expect(await client.callTool("echo", { text: "hi" })).toEqual({ content: "hello", isError: false });
		expect(await client.callTool("fail", {})).toEqual({ content: "boom", isError: true });
		expect(await client.callTool("structured", {})).toEqual({
			content: JSON.stringify({ answer: 42 }, null, 2),
			isError: false,
		});
		await client.close();
	});

	it("超时以 McpTimeoutError 收尾", async () => {
		const { client } = await connect((message) => {
			if (message.method === "initialize") return initializeResult();
			return new Promise(() => undefined);
		});

		await expect(client.callTool("slow", {}, { timeoutMs: 20 })).rejects.toBeInstanceOf(McpTimeoutError);
		await client.close();
	});

	it("中止后拒绝请求并通知 server 取消", async () => {
		const { client, transport } = await connect((message) => {
			if (message.method === "initialize") return initializeResult();
			return new Promise(() => undefined);
		});
		const controller = new AbortController();
		const running = client.callTool("slow", {}, { signal: controller.signal });
		controller.abort();
		await expect(running).rejects.toMatchObject({ name: "AbortError" });
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(
			transport.sent.some((message) => methodOf(message) === "notifications/cancelled" && "params" in message),
		).toBe(true);
		await client.close();
	});
});

describe("MCP client 服务端反向请求与通知", () => {
	it("回应 ping 与 roots/list，未知方法回 methodNotFound", async () => {
		const { client, transport } = await connect((message) => {
			if (message.method === "initialize") return initializeResult();
			return {};
		});
		transport.push({ jsonrpc: "2.0", id: 101, method: "ping" });
		transport.push({ jsonrpc: "2.0", id: 102, method: "roots/list" });
		transport.push({ jsonrpc: "2.0", id: 103, method: "sampling/createMessage" });
		await new Promise((resolve) => setTimeout(resolve, 10));

		expect(transport.sent.find((message) => idOf(message) === 101)).toMatchObject({ result: {} });
		expect(transport.sent.find((message) => idOf(message) === 102)).toMatchObject({
			result: { roots: [{ uri: "file:///workspace", name: "workspace" }] },
		});
		expect(transport.sent.find((message) => idOf(message) === 103)).toMatchObject({
			error: { code: -32601 },
		});
		await client.close();
	});

	it("通知按方法名交给调用方", async () => {
		const seen: string[] = [];
		const transport = new FakeTransport((message) => {
			if (message.method === "initialize") return initializeResult();
			return {};
		});
		const client = new McpClient({
			transport,
			clientName: "test",
			version: "1.0.0",
			callTimeoutMs: 1_000,
			onNotification: (method) => seen.push(method),
		});
		await client.connect();
		transport.push({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
		expect(seen).toEqual(["notifications/tools/list_changed"]);
		await client.close();
	});
});
