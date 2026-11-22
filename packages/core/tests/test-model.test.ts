import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { Core } from "@moros/core/core.ts";

const directories: string[] = [];

async function tempHome(): Promise<string> {
	const home = await mkdtemp(join(tmpdir(), "moros-test-model-"));
	directories.push(home);
	return home;
}

afterEach(async () => {
	await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function sse(events: readonly unknown[]): Response {
	const body = `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

describe("Core.testModel 模型连通性测试", () => {
	it("成功时返回 ok 与回包预览", async () => {
		const home = await tempHome();
		const core = new Core({
			homeDir: home,
			fetch: async () =>
				sse([
					{ choices: [{ delta: { content: "OK" } }] },
					{ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 1 } },
				]),
		});
		const result = await core.testModel({
			api: "chat-completions",
			baseUrl: "http://127.0.0.1:1234/v1",
			modelId: "test-model",
			apiKey: "sk-test",
		});
		expect(result.ok).toBe(true);
		expect(result.text).toBe("OK");
		expect(result.durationMs).toBeGreaterThanOrEqual(0);
	});

	it("缺少密钥且无已保存供应商时返回 error，不发起请求", async () => {
		const home = await tempHome();
		let called = false;
		const core = new Core({
			homeDir: home,
			fetch: async () => {
				called = true;
				throw new Error("should not fetch");
			},
		});
		const result = await core.testModel({
			api: "chat-completions",
			baseUrl: "http://127.0.0.1:1234/v1",
			modelId: "test-model",
		});
		expect(result.ok).toBe(false);
		expect(result.error).toBe("请先填写 API Key");
		expect(called).toBe(false);
	});

	it("请求失败时返回 ok=false 与错误原因，不抛异常", async () => {
		const home = await tempHome();
		const core = new Core({
			homeDir: home,
			fetch: async () => new Response("boom", { status: 500, statusText: "Internal Server Error" }),
		});
		const result = await core.testModel({
			api: "chat-completions",
			baseUrl: "http://127.0.0.1:1234/v1",
			modelId: "test-model",
			apiKey: "sk-test",
		});
		expect(result.ok).toBe(false);
		expect(result.error).toBeTruthy();
	});
});
