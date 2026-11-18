import { describe, expect, it } from "vitest";

import { McpClient } from "@moros/core/mcp/client.ts";
import { McpHttpError, StreamableHttpTransport } from "@moros/core/mcp/http-transport.ts";
import { McpManager } from "@moros/core/mcp/manager.ts";
import type { McpServerConfig } from "@moros/core/mcp/types.ts";

const ECHO_TOOL = {
	name: "echo",
	description: "Echo text",
	inputSchema: { type: "object", properties: { text: { type: "string" } } },
};

function jsonResponse(value: unknown, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(value), {
		status: 200,
		headers: { "content-type": "application/json", ...headers },
	});
}

function sseResponse(events: readonly unknown[]): Response {
	const body = `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}`;
	return new Response(
		new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode(body));
				controller.close();
			},
		}),
		{ status: 200, headers: { "content-type": "text/event-stream" } },
	);
}

interface RecordedRequest {
	readonly method: string;
	readonly headers: Headers;
	readonly body: Record<string, unknown> | undefined;
}

function fakeFetch(handler: (request: RecordedRequest) => Response | Promise<Response>) {
	const requests: RecordedRequest[] = [];
	const fetchImpl: typeof fetch = async (input, init = {}) => {
		const request: RecordedRequest = {
			method: init.method ?? "GET",
			headers: new Headers(init.headers),
			body: typeof init.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined,
		};
		requests.push(request);
		return handler(request);
	};
	return { fetchImpl, requests };
}

function client(fetchImpl: typeof fetch, onNotification?: (method: string) => void): McpClient {
	return new McpClient({
		transport: new StreamableHttpTransport({ url: "https://fake.test/mcp", fetch: fetchImpl }),
		clientName: "test",
		version: "1.0.0",
		callTimeoutMs: 1_000,
		...(onNotification ? { onNotification } : {}),
	});
}

function initialize(request: RecordedRequest): Response {
	return jsonResponse(
		{
			jsonrpc: "2.0",
			id: request.body?.["id"],
			result: {
				protocolVersion: "2025-06-18",
				capabilities: { tools: {} },
				serverInfo: { name: "fake", version: "1.0.0" },
			},
		},
		{ "mcp-session-id": "sess-1" },
	);
}

describe("MCP Streamable HTTP", () => {
	it("POST 处理 JSON/SSE 响应，并回传 session id 与协议版本", async () => {
		const { fetchImpl, requests } = fakeFetch((request) => {
			if (request.method === "GET") return new Response(null, { status: 405 });
			const method = request.body?.["method"];
			if (method === "initialize") return initialize(request);
			if (method === "notifications/initialized") return new Response(null, { status: 202 });
			if (method === "tools/list") {
				return sseResponse([{ jsonrpc: "2.0", id: request.body?.["id"], result: { tools: [ECHO_TOOL] } }]);
			}
			if (method === "tools/call") {
				return jsonResponse({
					jsonrpc: "2.0",
					id: request.body?.["id"],
					result: { content: [{ type: "text", text: "hello" }] },
				});
			}
			return new Response(null, { status: 404 });
		});
		const mcp = client(fetchImpl);
		try {
			await mcp.connect();
			const tools = await mcp.listTools();
			expect(tools.map((tool) => tool.name)).toEqual(["echo"]);
			expect(await mcp.callTool("echo", { text: "hi" })).toEqual({ content: "hello", isError: false });

			const listRequest = requests.find((request) => request.body?.["method"] === "tools/list");
			expect(listRequest?.headers.get("mcp-session-id")).toBe("sess-1");
			expect(listRequest?.headers.get("mcp-protocol-version")).toBe("2025-06-18");
			expect(requests.some((request) => request.method === "GET")).toBe(true);
		} finally {
			await mcp.close();
		}
	});

	it("HTTP 错误带上状态与响应片段", async () => {
		const { fetchImpl } = fakeFetch((request) => {
			if (request.method === "GET") return new Response(null, { status: 405 });
			if (request.body?.["method"] === "initialize") return initialize(request);
			if (request.body?.["method"] === "notifications/initialized") return new Response(null, { status: 202 });
			return new Response("server exploded", { status: 500 });
		});
		const mcp = client(fetchImpl);
		try {
			await mcp.connect();
			const error = await mcp.listTools().catch((caught: unknown) => caught);
			expect(error).toBeInstanceOf(McpHttpError);
			expect(error).toMatchObject({ status: 500, body: "server exploded" });
		} finally {
			await mcp.close();
		}
	});

	it("manager 按配置选择 HTTP 传输", async () => {
		const { fetchImpl } = fakeFetch((request) => {
			if (request.method === "GET") return new Response(null, { status: 405 });
			const method = request.body?.["method"];
			if (method === "initialize") return initialize(request);
			if (method === "notifications/initialized") return new Response(null, { status: 202 });
			if (method === "tools/list") {
				return jsonResponse({
					jsonrpc: "2.0",
					id: request.body?.["id"],
					result: { tools: [ECHO_TOOL] },
				});
			}
			return new Response(null, { status: 404 });
		});
		const config: McpServerConfig = {
			name: "remote",
			type: "http",
			command: undefined,
			args: [],
			url: "https://fake.test/mcp",
			headers: {},
			env: {},
			timeoutSeconds: 10,
			disabled: false,
		};
		const mcp = new McpManager({
			projectRoot: process.cwd(),
			servers: [config],
			version: "0.0.0-test",
			fetch: fetchImpl,
			reconnectDelaysMs: [],
		});
		try {
			mcp.start();
			await mcp.awaitStartup();
			expect(mcp.status()[0]?.status).toBe("connected");
			expect(mcp.tools().map((tool) => tool.name)).toEqual(["mcp__remote__echo"]);
		} finally {
			await mcp.close();
		}
	});

	it("GET 事件流把服务端通知交给调用方", async () => {
		const seen: string[] = [];
		let getResolve: (() => void) | undefined;
		const { fetchImpl } = fakeFetch((request) => {
			if (request.method === "GET") {
				return new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							controller.enqueue(
								new TextEncoder().encode(
									`data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/tools/list_changed" })}\n\n`,
								),
							);
							getResolve = () => controller.close();
						},
					}),
					{ status: 200, headers: { "content-type": "text/event-stream" } },
				);
			}
			if (request.body?.["method"] === "initialize") return initialize(request);
			return new Response(null, { status: 202 });
		});
		const mcp = client(fetchImpl, (method) => seen.push(method));
		try {
			await mcp.connect();
			await new Promise((resolve) => setTimeout(resolve, 20));
			expect(seen).toContain("notifications/tools/list_changed");
		} finally {
			getResolve?.();
			await mcp.close();
		}
	});
});
