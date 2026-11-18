import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { Core } from "@moros/core/core.ts";

const fixture = resolve(process.cwd(), "tests/fixtures/mcp-stdio-server.mjs");
const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makeRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "moros-mcp-session-"));
	roots.push(root);
	return root;
}

/** 一段最小的 Chat Completions SSE 响应。 */
function sse(events: readonly unknown[]): Response {
	const body = `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;
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

describe("Core 会话使用 MCP 工具", () => {
	it("把 MCP 工具声明进请求，并把远端结果送回模型", async () => {
		const home = await makeRoot();
		const projectRoot = await makeRoot();
		await mkdir(join(home, ".moros"), { recursive: true });
		await writeFile(
			join(home, ".moros", "config.toml"),
			[
				'provider = "fake"',
				'model = "fake-model"',
				'approval = "yolo"',
				"",
				"[mcp_servers.fixture]",
				`command = '${process.execPath}'`,
				`args = ['${fixture}']`,
				"timeout = 10",
				"",
			].join("\n"),
		);
		await writeFile(
			join(home, ".moros", "providers.json"),
			JSON.stringify({
				providers: {
					fake: {
						api: "chat-completions",
						baseUrl: "https://fake.test/v1",
						apiKey: "test",
						models: [
							{
								id: "fake-model",
								maxTokens: 1_000,
								reasoning: false,
								input: ["text"],
								contextWindow: 8_000,
							},
						],
					},
				},
			}),
		);

		const requests: Record<string, unknown>[] = [];
		const fetchImpl: typeof fetch = async (_input, init) => {
			requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
			if (requests.length === 1) {
				return sse([
					{
						choices: [
							{
								delta: {
									tool_calls: [
										{
											index: 0,
											id: "call-1",
											function: { name: "mcp__fixture__echo", arguments: JSON.stringify({ text: "hi" }) },
										},
									],
								},
							},
						],
					},
					{
						choices: [{ delta: {}, finish_reason: "tool_calls" }],
						usage: { prompt_tokens: 10, completion_tokens: 5 },
					},
				]);
			}
			return sse([
				{ choices: [{ delta: { content: "done" } }] },
				{ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 20, completion_tokens: 2 } },
			]);
		};

		const core = new Core({ homeDir: home, fetch: fetchImpl });
		try {
			const session = await core.createSession(projectRoot, { mode: "creator" });
			const result = await core.runSession(session, "echo hi");

			const tools = requests[0]?.["tools"] as Array<{ function: { name: string } }>;
			expect(tools.map((tool) => tool.function.name)).toContain("mcp__fixture__echo");
			const messages = requests[1]?.["messages"] as Array<{ role: string; content: string }>;
			expect(messages).toContainEqual(expect.objectContaining({ role: "tool", content: "echo:hi" }));
			expect(result.messages.at(-1)).toMatchObject({ role: "assistant", content: "done" });
		} finally {
			await core.dispose();
		}
	});
});
