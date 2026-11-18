import { describe, expect, it } from "vitest";

import { JsonRpcLineReader } from "#src/core/mcp/line-reader.ts";
import type { JsonRpcMessage } from "#src/core/mcp/json-rpc.ts";

function reader(options: { maxMessageBytes?: number; maxStderrBytes?: number } = {}) {
	const messages: JsonRpcMessage[] = [];
	const errors: Error[] = [];
	const instance = new JsonRpcLineReader({
		...(options.maxMessageBytes === undefined ? {} : { maxMessageBytes: options.maxMessageBytes }),
		...(options.maxStderrBytes === undefined ? {} : { maxStderrBytes: options.maxStderrBytes }),
		onMessage: (message) => messages.push(message),
		onError: (error) => errors.push(error),
	});
	return { instance, messages, errors };
}

describe("MCP stdio 行分帧", () => {
	it("半条报文跨 chunk 到达后仍能解析", () => {
		const { instance, messages } = reader();
		const payload = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [] } });
		instance.readStdout(Buffer.from(payload.slice(0, 10)));
		instance.readStdout(Buffer.from(payload.slice(10) + "\n"));

		expect(messages).toEqual([{ jsonrpc: "2.0", id: 1, result: { tools: [] } }]);
	});

	it("一个 chunk 里的多条报文按序派发，CRLF 也能处理", () => {
		const { instance, messages } = reader();
		instance.readStdout(
			Buffer.from(
				`${JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} })}\r\n` +
					`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/tools/list_changed" })}\n`,
			),
		);

		expect(messages.map((message) => ("id" in message ? message.id : message.method))).toEqual([
			1,
			"notifications/tools/list_changed",
		]);
	});

	it("超过帧上限时报错并丢弃该条", () => {
		const { instance, messages, errors } = reader({ maxMessageBytes: 8 });
		instance.readStdout(Buffer.from(`${JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} })}\n`));

		expect(messages).toEqual([]);
		expect(errors[0]?.message).toContain("exceeds");
	});

	it("非 JSON 行只报错，不影响后续报文", () => {
		const { instance, messages, errors } = reader();
		instance.readStdout(Buffer.from("server log line\n"));
		instance.readStdout(Buffer.from(`${JSON.stringify({ jsonrpc: "2.0", id: 2, result: {} })}\n`));

		expect(errors).toHaveLength(1);
		expect(messages).toEqual([{ jsonrpc: "2.0", id: 2, result: {} }]);
	});

	it("stderr 只保留尾部", () => {
		const { instance } = reader({ maxStderrBytes: 5 });
		instance.readStderr(Buffer.from("0123456789"));
		expect(instance.stderr).toBe("56789");
	});

	it("结束时残留半条报文报错", () => {
		const { instance, errors } = reader();
		instance.readStdout(Buffer.from('{"jsonrpc":"2.0"'));
		instance.end();
		expect(errors[0]?.message).toContain("incomplete");
	});
});
