import { describe, expect, it } from "vitest";

import type { SettingsSnapshot } from "@moros/core/config/settings.ts";
import { availableModel, configuredModel } from "../src/utils/model.ts";

/** 测试只关心 provider/model 字段，用最小对象断言为完整快照。 */
function settingsWith(provider: string, model: string): SettingsSnapshot {
	return { config: { provider, model } } as SettingsSnapshot;
}

const catalog = {
	providers: [
		{
			name: "moxuna",
			models: [{ id: "deepseek-chat", name: "DeepSeek Chat", maxTokens: 8192, reasoning: false, input: ["text"] }],
		},
	],
} as const;

describe("availableModel", () => {
	it("模型中裸 id 仍在目录中时返回该引用", () => {
		expect(availableModel(catalog, { provider: "moxuna", model: "deepseek-chat" })).toEqual({
			provider: "moxuna",
			model: "deepseek-chat",
		});
	});

	it("兼容历史 provider/id 复合格式", () => {
		expect(availableModel(catalog, { provider: "moxuna", model: "moxuna/deepseek-chat" })).toEqual({
			provider: "moxuna",
			model: "moxuna/deepseek-chat",
		});
	});

	it("模型已从目录移除时按未选择处理（幽灵模型）", () => {
		expect(availableModel(catalog, { provider: "moxuna", model: "deepseek-flash" })).toBeUndefined();
	});

	it("供应商已不存在时按未选择处理", () => {
		expect(availableModel(catalog, { provider: "deleted-provider", model: "deepseek-chat" })).toBeUndefined();
	});

	it("未指定模型时返回 undefined", () => {
		expect(availableModel(catalog, undefined)).toBeUndefined();
	});
});

describe("configuredModel", () => {
	it("配置模型存在时返回规范化引用", () => {
		expect(configuredModel(catalog, settingsWith("moxuna", "deepseek-chat"))).toEqual({
			provider: "moxuna",
			model: "deepseek-chat",
		});
	});

	it("配置模型已失效时返回 undefined", () => {
		expect(configuredModel(catalog, settingsWith("moxuna", "deepseek-flash"))).toBeUndefined();
	});
});
