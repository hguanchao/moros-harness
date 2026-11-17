import { describe, expect, it } from "vitest";

import { normalizeConfigKeys } from "#src/core/config/keys.ts";
import { parseConfig } from "#src/core/config/schema.ts";

describe("辅助模型配置", () => {
	it("接受顶层的 compact_model 与 review_model", () => {
		const { config, skipped } = parseConfig({
			provider: "local",
			model: "main",
			compactModel: "cheap",
			reviewModel: "guard",
		});

		expect(config.compactModel).toBe("cheap");
		expect(config.reviewModel).toBe("guard");
		expect(skipped).toEqual([]);
	});

	it("未配置时审查关闭、压缩复用激活模型", () => {
		const { config } = parseConfig({});

		expect(config.compactModel).toBeUndefined();
		expect(config.reviewModel).toBeUndefined();
	});

	it("snake_case 别名归一为 camelCase", () => {
		expect(normalizeConfigKeys({ compact_model: "a", review_model: "b" })).toEqual({
			compactModel: "a",
			reviewModel: "b",
		});
	});

	it("模型写在 [compaction] 里是旧写法，按未知键剥离", () => {
		const { config, skipped } = parseConfig({ compaction: { model: "x" } });

		expect(skipped).toEqual([{ path: "compaction.model", reason: "Unknown config key (stripped)" }]);
		expect(config.compaction.compactAt).toBe(0.8);
	});
});
