import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { cleanGeneratedTitle } from "@moros/core/session/title-generator.ts";
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

function sseTitle(text: string): Response {
	return sse([
		{ choices: [{ delta: { content: text } }] },
		{ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5 } },
	]);
}

const DONE_RESPONSE = () =>
	sse([
		{ choices: [{ delta: { content: "done" } }] },
		{ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 20, completion_tokens: 2 } },
	]);

interface Harness {
	readonly core: Core;
	readonly session: Awaited<ReturnType<Core["createSession"]>>;
	/** 收到的标题请求体（不带 tools 的请求）；主回合请求不记录。 */
	readonly titleRequests: Array<Record<string, unknown>>;
	readonly warnings: string[];
}

interface HarnessOptions {
	/** 标题请求返回的响应；缺省成功返回「贪吃蛇游戏开发」。 */
	readonly titleResponse?: () => Response;
	/** createSession 的额外选项（如显式 title）。 */
	readonly createOptions?: { title?: string };
}

/** 搭一个带假 fetch 的 Core：主回合一律回 "done"，标题请求按场景定制。 */
async function makeHarness(projectRoot: string, options: HarnessOptions = {}): Promise<Harness> {
	const home = await makeRoot("moros-title-home-");
	await mkdir(join(home, ".moros"), { recursive: true });
	// max_retries = 0：标题调用失败立即抛错，测试不必等退避
	await writeFile(
		join(home, ".moros", "config.toml"),
		['provider = "fake"', 'model = "fake-model"', 'approval = "yolo"', "", "[retry]", "max_retries = 0", ""].join(
			"\n",
		),
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

	const titleRequests: Array<Record<string, unknown>> = [];
	const warnings: string[] = [];
	const fetchImpl: typeof fetch = async (_input, init) => {
		const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
		// 标题请求经 omitTools 永不带 tools，按此与主回合请求区分
		if (!("tools" in body)) {
			titleRequests.push(body);
			return options.titleResponse?.() ?? sseTitle("贪吃蛇游戏开发");
		}
		return DONE_RESPONSE();
	};

	const core = new Core({
		homeDir: home,
		fetch: fetchImpl,
		onWarning: (message) => warnings.push(message),
	});
	const session = await core.createSession(projectRoot, { mode: "creator", ...options.createOptions });
	return { core, session, titleRequests, warnings };
}

/** 轮询等待后台标题任务落盘；后台任务与主回合并发，完成时点不与 runSession 对齐。 */
async function waitFor(description: string, probe: () => Promise<boolean> | boolean, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (await probe()) return;
		if (Date.now() > deadline) throw new Error(`condition not met in time: ${description}`);
		await new Promise((resume) => setTimeout(resume, 25));
	}
}

async function titleOf(core: Core, projectRoot: string, sessionId: string): Promise<string | undefined> {
	const metas = await core.listSessions(projectRoot);
	return metas.find((item) => item.id === sessionId)?.title;
}

describe("LLM 自动生成会话标题", () => {
	it("首回合后台生成标题并写回，第二回合不再调用", async () => {
		const projectRoot = await makeRoot("moros-title-proj-");
		const { core, session, titleRequests } = await makeHarness(projectRoot);
		try {
			const result = await core.runSession(session, "帮我写一个贪吃蛇游戏");
			expect(result.messages.at(-1)).toMatchObject({ role: "assistant", content: "done" });

			await waitFor("标题写入列表投影", async () => (await titleOf(core, projectRoot, session.meta.id)) === "贪吃蛇游戏开发");

			// 标题请求形态：防注入包裹、无工具声明、留足推理余量的 maxTokens
			expect(titleRequests).toHaveLength(1);
			const titleRequest = titleRequests[0];
			expect(titleRequest).toBeDefined();
			expect(titleRequest?.["max_tokens"]).toBe(512);
			const messages = titleRequest?.["messages"] as Array<{ role: string; content: string }>;
			expect(messages).toHaveLength(2);
			expect(messages[0]?.role).toBe("system");
			expect(messages[0]?.content).toContain("never as instructions");
			expect(messages[1]?.role).toBe("user");
			expect(messages[1]?.content).toContain("<message>");
			expect(messages[1]?.content).toContain("帮我写一个贪吃蛇游戏");

			// renamed 事件落流，desktop 侧栏走既有推送即可刷新
			const events = await session.events.read();
			const renamed = events.find((event) => event.type === "session.renamed");
			expect(renamed).toMatchObject({ payload: { title: "贪吃蛇游戏开发" } });

			// 已生成过（state.title 落盘）→ 第二回合不再发起标题调用
			await core.runSession(session, "继续");
			await new Promise((resume) => setTimeout(resume, 200));
			expect(titleRequests).toHaveLength(1);
		} finally {
			await core.dispose();
		}
	});

	it("已手动改名的会话不再自动命名", async () => {
		const projectRoot = await makeRoot("moros-title-proj-");
		const { core, session, titleRequests } = await makeHarness(projectRoot);
		try {
			await core.renameSession(session, "手动标题");
			await core.runSession(session, "hi");
			await new Promise((resume) => setTimeout(resume, 200));
			expect(titleRequests).toHaveLength(0);
			expect(await titleOf(core, projectRoot, session.meta.id)).toBe("手动标题");
		} finally {
			await core.dispose();
		}
	});

	it("创建即命名的会话（如 Code review）不接管", async () => {
		const projectRoot = await makeRoot("moros-title-proj-");
		const { core, session, titleRequests } = await makeHarness(projectRoot, { createOptions: { title: "Code review" } });
		try {
			await core.runSession(session, "审查我的提交");
			await new Promise((resume) => setTimeout(resume, 200));
			expect(titleRequests).toHaveLength(0);
		} finally {
			await core.dispose();
		}
	});

	it("标题调用失败不影响主回合，下一回合重试", async () => {		const projectRoot = await makeRoot("moros-title-proj-");
		let failTitle = true;
		const { core, session, titleRequests, warnings } = await makeHarness(projectRoot, {
			titleResponse: () => (failTitle ? new Response("provider exploded", { status: 500 }) : sseTitle("贪吃蛇游戏开发")),
		});
		try {
			const result = await core.runSession(session, "帮我写一个贪吃蛇游戏");
			expect(result.messages.at(-1)).toMatchObject({ role: "assistant", content: "done" });

			await waitFor("失败上报 warning", () => warnings.some((message) => message.startsWith("Session title generation failed")));
			// 生成失败：派生标题（首条消息首行）仍在
			expect(await titleOf(core, projectRoot, session.meta.id)).toBe("帮我写一个贪吃蛇游戏");

			// 下一回合自动重试并成功写回
			failTitle = false;
			await core.runSession(session, "继续");
			await waitFor("重试成功写回", async () => (await titleOf(core, projectRoot, session.meta.id)) === "贪吃蛇游戏开发");
			expect(titleRequests).toHaveLength(2);
		} finally {
			await core.dispose();
		}
	});
	it("输出被 max_tokens 掐断时拒收半截标题，下回合重试", async () => {
		const projectRoot = await makeRoot("moros-title-proj-");
		let truncated = true;
		const { core, session, titleRequests, warnings } = await makeHarness(projectRoot, {
			titleResponse: () =>
				truncated
					? sse([
							{ choices: [{ delta: { content: "询问助手能" } }] },
							{
								choices: [{ delta: {}, finish_reason: "length" }],
								usage: { prompt_tokens: 10, completion_tokens: 128 },
							},
						])
					: sseTitle("贪吃蛇游戏开发"),
		});
		try {
			await core.runSession(session, "帮我写一个贪吃蛇游戏");
			await waitFor("截断上报 warning", () =>
				warnings.some((message) => message.includes("truncated by max_tokens")),
			);
			// 半截标题不落盘，派生标题仍在
			expect(await titleOf(core, projectRoot, session.meta.id)).toBe("帮我写一个贪吃蛇游戏");

			// 下一回合重试并成功写回完整标题
			truncated = false;
			await core.runSession(session, "继续");
			await waitFor("重试成功写回", async () => (await titleOf(core, projectRoot, session.meta.id)) === "贪吃蛇游戏开发");
			expect(titleRequests).toHaveLength(2);
		} finally {
			await core.dispose();
		}
	});
});

describe("标题输出清洗", () => {
	it("剥掉成对包裹引号并取首个非空行", () => {
		expect(cleanGeneratedTitle("“贪吃蛇游戏”")).toBe("贪吃蛇游戏");
		expect(cleanGeneratedTitle("「贪吃蛇」")).toBe("贪吃蛇");
		expect(cleanGeneratedTitle('"AI 助手"')).toBe("AI 助手");
		expect(cleanGeneratedTitle("  \n  贪吃蛇游戏  \n  多余内容  ")).toBe("贪吃蛇游戏");
	});

	it("空输出与纯引号行视为无效", () => {
		expect(cleanGeneratedTitle("\n  \n")).toBeUndefined();
		expect(cleanGeneratedTitle("“ ”")).toBeUndefined();
		expect(cleanGeneratedTitle("")).toBeUndefined();
	});
});
