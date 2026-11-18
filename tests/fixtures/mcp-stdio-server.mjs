#!/usr/bin/env node
/**
 * 最小 MCP stdio server，供 MCP 客户端/管理器测试使用。
 *
 * 只实现测试需要的协议面：initialize、tools/list、tools/call、ping、tools/list_changed、
 * stderr 输出与崩溃。报文按行分隔，stdout 只写 JSON-RPC，日志一律走 stderr。
 */

import { createInterface } from "node:readline";

if (process.argv.includes("--fail")) {
	process.stderr.write("fixture startup failure\n");
	process.exit(1);
}

let tools = [
	{
		name: "echo",
		description: "Echo the supplied text",
		inputSchema: {
			type: "object",
			properties: { text: { type: "string" } },
			required: ["text"],
		},
	},
	{
		name: "fail",
		description: "Return an MCP error result",
		inputSchema: { type: "object", properties: {} },
	},
	{
		name: "structured",
		description: "Return only structuredContent",
		inputSchema: { type: "object", properties: {} },
	},
	{
		name: "stderr",
		description: "Write a line to stderr",
		inputSchema: { type: "object", properties: {} },
	},
	{
		name: "changed",
		description: "Announce a changed tool list",
		inputSchema: { type: "object", properties: {} },
	},
	{
		name: "crash",
		description: "Exit the server process",
		inputSchema: { type: "object", properties: {} },
	},
];

function send(message) {
	process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
}

function result(id, value) {
	send({ id, result: value });
}

function error(id, code, message) {
	send({ id, error: { code, message } });
}

async function callTool(id, name, args) {
	switch (name) {
		case "echo":
			result(id, { content: [{ type: "text", text: `echo:${args.text ?? ""}` }] });
			return;
		case "fail":
			result(id, { isError: true, content: [{ type: "text", text: "fixture failure" }] });
			return;
		case "structured":
			result(id, { content: [], structuredContent: { answer: 42 } });
			return;
		case "stderr":
			process.stderr.write("fixture stderr line\n");
			result(id, { content: [{ type: "text", text: "stderr written" }] });
			return;
		case "changed":
			result(id, { content: [{ type: "text", text: "tool list changed" }] });
			if (!tools.some((tool) => tool.name === "extra")) {
				tools = [
					...tools,
					{
						name: "extra",
						description: "Added after tools/list_changed",
						inputSchema: { type: "object", properties: {} },
					},
				];
			}
			send({ method: "notifications/tools/list_changed" });
			return;
		case "crash":
			result(id, { content: [{ type: "text", text: "crashing" }] });
			setTimeout(() => process.exit(1), 10);
			return;
		default:
			error(id, -32602, `Unknown tool: ${name}`);
	}
}

function handle(message) {
	if (typeof message.method !== "string") return;
	if (message.id === undefined) return; // 通知无需响应
	switch (message.method) {
		case "initialize":
			result(message.id, {
				protocolVersion: "2025-06-18",
				capabilities: { tools: {} },
				serverInfo: { name: "fixture", version: "1.0.0" },
			});
			return;
		case "ping":
			result(message.id, {});
			return;
		case "tools/list":
			result(message.id, { tools });
			return;
		case "tools/call": {
			const params = message.params ?? {};
			void callTool(message.id, params.name, params.arguments ?? {});
			return;
		}
		default:
			error(message.id, -32601, `Method not found: ${message.method}`);
	}
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => {
	const text = line.trim();
	if (text.length === 0) return;
	let message;
	try {
		message = JSON.parse(text);
	} catch {
		process.stderr.write(`invalid JSON: ${text.slice(0, 120)}\n`);
		return;
	}
	handle(message);
});
lines.on("close", () => process.exit(0));
process.stderr.write("fixture server started\n");
