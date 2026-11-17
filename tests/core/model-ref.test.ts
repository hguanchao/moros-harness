import { describe, expect, it } from "vitest";

import { parseModelRef } from "#src/core/config/model-ref.ts";
import type { ProvidersFile } from "#src/core/config/schema.ts";

const providers: ProvidersFile = {
	providers: {
		hiyo: {
			api: "chat-completions",
			baseUrl: "https://api.hiyo.example/v1",
			apiKey: "",
			timeoutMs: 120_000,
			models: [
				{
					id: "deepseek-v4.1-flash-1017",
					maxTokens: 8192,
					reasoning: false,
					input: ["text"],
				},
			],
		},
		openrouter: {
			api: "chat-completions",
			baseUrl: "https://openrouter.example/v1",
			apiKey: "",
			timeoutMs: 120_000,
			models: [
				{
					id: "meta-llama/llama-3-70b",
					maxTokens: 8192,
					reasoning: false,
					input: ["text"],
				},
			],
		},
	},
};

describe("parseModelRef", () => {
	it("识别 provider/modelId 写法", () => {
		expect(parseModelRef("hiyo/deepseek-v4.1-flash-1017", providers)).toEqual({
			provider: "hiyo",
			model: "deepseek-v4.1-flash-1017",
		});
	});

	it("只有模型 id 时省略供应商，交给调用方补当前 provider", () => {
		expect(parseModelRef("deepseek-v4.1-flash-1017", providers)).toEqual({ model: "deepseek-v4.1-flash-1017" });
	});

	it("斜杠前不是已注册供应商时，整串当模型 id（id 本身常带斜杠）", () => {
		expect(parseModelRef("meta-llama/llama-3-70b", providers)).toEqual({ model: "meta-llama/llama-3-70b" });
	});

	it("前缀或后缀为空时不拆，避免把残缺写法当成合法引用", () => {
		expect(parseModelRef("/model", providers)).toEqual({ model: "/model" });
		expect(parseModelRef("hiyo/", providers)).toEqual({ model: "hiyo/" });
	});

	it("去掉首尾空白", () => {
		expect(parseModelRef("  hiyo/deepseek-v4.1-flash-1017  ", providers)).toEqual({
			provider: "hiyo",
			model: "deepseek-v4.1-flash-1017",
		});
	});
});
