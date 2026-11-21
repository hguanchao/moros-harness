import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { Core } from "@moros/core/core.ts";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makeRoot(prefix: string): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), prefix));
	roots.push(root);
	return root;
}

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

const MAIN_RESPONSE = () =>
	sse([
		{ choices: [{ delta: { content: "done" } }] },
		{ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 20, completion_tokens: 2 } },
	]);

const TITLE_RESPONSE = () =>
	sse([
		{ choices: [{ delta: { content: "标题" } }] },
		{ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5 } },
	]);

interface Harness {
	readonly core: Core;
	/** 主回合请求体（带 tools 的请求）；标题请求不记录。 */
	readonly mainRequests: Array<Record<string, unknown>>;
}

/** 两个模型的全局默认是 fake/fake-model；fake-model-2 只能靠会话级选择命中。 */
async function makeCore(home: string, fetchImpl: typeof fetch): Promise<Core> {
	const core = new Core({ homeDir: home, fetch: fetchImpl });
	return core;
}

async function writeFixture(home: string): Promise<void> {
	await mkdir(join(home, ".moros"), { recursive: true });
	await writeFile(
		join(home, ".moros", "config.toml"),
		['provider = "fake"', 'model = "fake-model"', 'approval = "yolo"', ""].join("\n"),
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
						{ id: "fake-model", maxTokens: 1_000, reasoning: true, input: ["text"], contextWindow: 8_000 },
						{ id: "fake-model-2", maxTokens: 1_000, reasoning: true, input: ["text"], contextWindow: 8_000 },
					],
				},
			},
		}),
	);
}

describe("会话模型/档位选择的折叠恢复", () => {
	it("重启后从 llm.request 恢复会话级覆盖，后续请求沿用恢复的路由", async () => {
		const home = await makeRoot("moros-restore-home-");
		const projectRoot = await makeRoot("moros-restore-proj-");
		await writeFixture(home);
		const core1Requests: Array<Record<string, unknown>> = [];
		const fetch1: typeof fetch = async (_input, init) => {
			const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
			if (!("tools" in body)) return TITLE_RESPONSE();
			core1Requests.push(body);
			return MAIN_RESPONSE();
		};

		const core1 = await makeCore(home, fetch1);
		let sessionId: string;
		try {
			const session = await core1.createSession(projectRoot, { mode: "creator" });
			sessionId = session.meta.id;
			await core1.selectModel(session, "fake", "fake-model-2");
			core1.selectEffort(session, "high");
			await core1.runSession(session, "hi");
		} finally {
			await core1.dispose();
		}
		// 覆盖后的主回合真的走了 fake-model-2 + high
		expect(core1Requests[0]?.["model"]).toBe("fake-model-2");
		expect(core1Requests[0]?.["reasoning_effort"]).toBe("high");

		// 模拟重启：全新 Core 打开同一会话
		const core2Requests: Array<Record<string, unknown>> = [];
		const fetch2: typeof fetch = async (_input, init) => {
			const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
			if (!("tools" in body)) return TITLE_RESPONSE();
			core2Requests.push(body);
			return MAIN_RESPONSE();
		};
		const core2 = await makeCore(home, fetch2);
		try {
			const restored = await core2.openSession(sessionId);
			expect(await core2.getSelectedModel(restored)).toEqual({ provider: "fake", model: "fake-model-2" });
			expect(core2.getSelectedEffort(restored)).toBe("high");

			// 恢复后的回合沿用恢复的路由与档位
			await core2.runSession(restored, "again");
			expect(core2Requests[0]?.["model"]).toBe("fake-model-2");
			expect(core2Requests[0]?.["reasoning_effort"]).toBe("high");
		} finally {
			await core2.dispose();
		}
	});

	it("旧格式 llm.request（无 provider）不被折叠，回落全局默认", async () => {
		const home = await makeRoot("moros-restore-home-");
		const projectRoot = await makeRoot("moros-restore-proj-");
		await writeFixture(home);
		const fetchImpl: typeof fetch = async (_input, init) => {
			const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
			if (!("tools" in body)) return TITLE_RESPONSE();
			return MAIN_RESPONSE();
		};

		const core1 = await makeCore(home, fetchImpl);
		let sessionId: string;
		try {
			const session = await core1.createSession(projectRoot, { mode: "creator" });
			sessionId = session.meta.id;
			await core1.runSession(session, "hi");
			// 手工补一条旧格式事件（无 provider），模拟升级前的历史流
			await session.events.append({
				type: "llm.request",
				payload: { endpoint: "chat-completions", model: "fake-model-2", messageCount: 1 },
			});
		} finally {
			await core1.dispose();
		}

		const core2 = await makeCore(home, fetchImpl);
		try {
			const restored = await core2.openSession(sessionId);
			// 折叠到旧格式事件即止：不采用其中的 model，回落全局默认
			expect(await core2.getSelectedModel(restored)).toEqual({ provider: "fake", model: "fake-model" });
			expect(core2.getSelectedEffort(restored)).toBeUndefined();
		} finally {
			await core2.dispose();
		}
	});
});
