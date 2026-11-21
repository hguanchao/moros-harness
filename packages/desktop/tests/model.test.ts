import { describe, expect, it } from "vitest";

import type { SettingsSnapshot } from "@moros/core/config/settings.ts";
import { availableModel, clampEffortToModel, configuredModel } from "../src/utils/model.ts";

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
		{
			name: "limited",
			models: [
				{
					id: "mid-reasoning",
					maxTokens: 8192,
					reasoning: true,
					reasoningEfforts: ["low", "medium", "high"],
					input: ["text"],
				},
				{ id: "no-efforts", maxTokens: 8192, reasoning: true, reasoningEfforts: [], input: ["text"] },
				{ id: "gap-efforts", maxTokens: 8192, reasoning: true, reasoningEfforts: ["low", "high"], input: ["text"] },
				{ id: "legacy", maxTokens: 8192, reasoning: true, input: ["text"] },
			],
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

describe("clampEffortToModel", () => {
	const midModel = { provider: "limited", model: "mid-reasoning" };

	it("原档位受支持时原样返回", () => {
		expect(clampEffortToModel(catalog, midModel, "low")).toBe("low");
	});

	it("超出支持范围时钳到最近档位（Max→High）", () => {
		expect(clampEffortToModel(catalog, midModel, "max")).toBe("high");
	});

	it("低于支持范围时钳到最低支持档（Off→Low）", () => {
		expect(clampEffortToModel(catalog, midModel, "off")).toBe("low");
	});

	it("距离相同时取更弱档位（档位缺口 [low, high] 之间的 Medium→Low）", () => {
		expect(clampEffortToModel(catalog, { provider: "limited", model: "gap-efforts" }, "medium")).toBe("low");
	});

	it("关闭推理的模型只支持 Off", () => {
		expect(clampEffortToModel(catalog, { provider: "moxuna", model: "deepseek-chat" }, "max")).toBe("off");
		expect(clampEffortToModel(catalog, { provider: "limited", model: "no-efforts" }, "high")).toBe("off");
	});

	it("旧配置未配档位时视为任意档可用", () => {
		expect(clampEffortToModel(catalog, { provider: "limited", model: "legacy" }, "max")).toBe("max");
	});

	it("模型不在目录中时原样返回", () => {
		expect(clampEffortToModel(catalog, { provider: "limited", model: "missing" }, "max")).toBe("max");
	});
});
