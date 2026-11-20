import { describe, expect, it } from "vitest";

import { discoverProviderModels } from "@moros/core/config/model-discovery.ts";

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const forbiddenFetch: typeof fetch = async () => {
	throw new Error("fetch should not be called");
};

describe("discoverProviderModels", () => {
	it("使用 Bearer 认证，拼接 /models 并解析 OpenAI 风格列表", async () => {
		let requestUrl = "";
		let authorization: string | null = null;
		const models = await discoverProviderModels(
			{ api: "chat-completions", baseUrl: "https://api.example.com/v1/", apiKey: "sk-test" },
			{
				fetch: async (input, init) => {
					requestUrl = input.toString();
					authorization = new Headers(init?.headers).get("authorization");
					return jsonResponse({ data: [{ id: "gpt-4o", name: "GPT-4o" }, { id: "gpt-4o" }] });
				},
			},
		);

		expect(requestUrl).toBe("https://api.example.com/v1/models");
		expect(authorization).toBe("Bearer sk-test");
		expect(models).toEqual([{ id: "gpt-4o", name: "GPT-4o" }]);
	});

	it("Anthropic 使用 x-api-key 与固定版本头，并解析显示名称", async () => {
		const models = await discoverProviderModels(
			{ api: "anthropic-messages", baseUrl: "https://api.anthropic.com/v1", apiKey: "${TEST_KEY}" },
			{
				env: { TEST_KEY: "anthropic-secret" },
				fetch: async (_input, init) => {
					const headers = new Headers(init?.headers);
					expect(headers.get("x-api-key")).toBe("anthropic-secret");
					expect(headers.get("anthropic-version")).toBe("2023-06-01");
					return jsonResponse({ data: [{ id: "claude-sonnet-4", display_name: "Claude Sonnet 4" }] });
				},
			},
		);

		expect(models).toEqual([{ id: "claude-sonnet-4", name: "Claude Sonnet 4" }]);
	});

	it("兼容 models 字段与裸数组响应", async () => {
		const fromModels = await discoverProviderModels(
			{ api: "responses", baseUrl: "https://api.example.com/v1", apiKey: "sk-test" },
			{ fetch: async () => jsonResponse({ models: ["alpha", "beta"] }) },
		);
		const fromArray = await discoverProviderModels(
			{ api: "responses", baseUrl: "https://api.example.com/v1", apiKey: "sk-test" },
			{ fetch: async () => jsonResponse([{ model: "gamma" }]) },
		);

		expect(fromModels).toEqual([{ id: "alpha" }, { id: "beta" }]);
		expect(fromArray).toEqual([{ id: "gamma" }]);
	});

	it("HTTP 错误附带供应商返回的错误消息", async () => {
		await expect(
			discoverProviderModels(
				{ api: "chat-completions", baseUrl: "https://api.example.com/v1", apiKey: "bad" },
				{ fetch: async () => jsonResponse({ error: { message: "Invalid API key" } }, 401) },
			),
		).rejects.toThrow("获取模型失败（HTTP 401）：Invalid API key");
	});

	it("缺少密钥或 Base URL 非法时在请求前直接失败", async () => {
		await expect(
			discoverProviderModels(
				{ api: "chat-completions", baseUrl: "ftp://api.example.com/v1", apiKey: "sk-test" },
				{ fetch: forbiddenFetch },
			),
		).rejects.toThrow("Base URL 必须是 HTTP 或 HTTPS 地址");
		await expect(
			discoverProviderModels(
				{ api: "chat-completions", baseUrl: "https://api.example.com/v1", apiKey: " " },
				{ fetch: forbiddenFetch },
			),
		).rejects.toThrow("请先填写 API Key");
	});

	it("响应中没有模型时返回明确错误", async () => {
		await expect(
			discoverProviderModels(
				{ api: "chat-completions", baseUrl: "https://api.example.com/v1", apiKey: "sk-test" },
				{ fetch: async () => jsonResponse({ data: [] }) },
			),
		).rejects.toThrow("供应商未返回可用模型");
	});

	it("解析上游返回的上下文、Token、模态与推理字段", async () => {
		const models = await discoverProviderModels(
			{ api: "chat-completions", baseUrl: "https://api.example.com/v1", apiKey: "sk-test" },
			{
				fetch: async () =>
					jsonResponse({
						data: [
							{
								id: "auto/model-x",
								display_name: "Model X",
								context_window: 1_000_000,
								max_input_tokens: 950_000,
								max_output_tokens: 922_000,
								modalities: { input: ["text", "image/jpeg"] },
								reasoning: true,
								reasoning_levels: ["low", "xhigh", "max"],
							},
						],
					}),
			},
		);
		expect(models).toEqual([
			{
				id: "auto/model-x",
				name: "Model X",
				contextWindow: 1_000_000,
				maxTokens: 922_000,
				input: ["text", "image"],
				reasoning: true,
				reasoningEfforts: ["low", "max"],
			},
		]);
	});

	it("上游缺失的能力字段保持缺省，不伪造值", async () => {
		const models = await discoverProviderModels(
			{ api: "chat-completions", baseUrl: "https://api.example.com/v1", apiKey: "sk-test" },
			{ fetch: async () => jsonResponse({ data: [{ id: "bare-model" }] }) },
		);
		expect(models).toEqual([{ id: "bare-model" }]);
	});
});
