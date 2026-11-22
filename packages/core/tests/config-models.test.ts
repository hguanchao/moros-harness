import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { normalizeConfigKeys } from "@moros/core/config/keys.ts";
import { ModelSchema, parseConfig } from "@moros/core/config/schema.ts";
import { readSettings, writeSettings } from "@moros/core/config/settings.ts";

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

describe("外观配置键别名", () => {
	it("font_family 与 review_timeout_sec 归一为 camelCase", () => {
		expect(
			normalizeConfigKeys({
				limits: { review_timeout_sec: 120 },
				ui: { font_family: "maple", font_size: 16 },
			}),
		).toEqual({
			limits: { reviewTimeoutSec: 120 },
			ui: { fontFamily: "maple", fontSize: 16 },
		});
	});

	it("[ui] 补写的 font_family 读回时生效，不按未知键剥离", () => {
		const { config, skipped } = parseConfig(normalizeConfigKeys({ ui: { font_family: "maple" } }));

		expect(config.ui.fontFamily).toBe("maple");
		expect(skipped).toEqual([]);
	});
});

describe("工作步骤配置", () => {
	it("snake_case 别名归一为 camelCase", () => {
		expect(
			normalizeConfigKeys({
				ui: {
					work_step_detail: "detailed",
					collapse_timing: "immediately",
					collapsed_replies: "last",
					code_workspace: false,
				},
			}),
		).toEqual({
			ui: {
				workStepDetail: "detailed",
				collapseTiming: "immediately",
				collapsedReplies: "last",
				codeWorkspace: false,
			},
		});
	});

	it("缺省时各档位为 schema 默认值", () => {
		const { config, skipped } = parseConfig({});

		expect(config.ui.workStepDetail).toBe("standard");
		expect(config.ui.collapseTiming).toBe("afterAnswer");
		expect(config.ui.collapsedReplies).toBe("all");
		expect(config.ui.codeWorkspace).toBe(true);
		expect(skipped).toEqual([]);
	});

	it("写补丁后读回生效，且四个键都不按未知键剥离", async () => {
		const home = await mkdtemp(join(tmpdir(), "moros-work-steps-"));
		try {
			await writeSettings(home, {
				ui: {
					workStepDetail: "full",
					collapseTiming: "never",
					collapsedReplies: "none",
					codeWorkspace: false,
				},
			});
			const snapshot = await readSettings(home);

			expect(snapshot.config.ui.workStepDetail).toBe("full");
			expect(snapshot.config.ui.collapseTiming).toBe("never");
			expect(snapshot.config.ui.collapsedReplies).toBe("none");
			expect(snapshot.config.ui.codeWorkspace).toBe(false);
			expect(snapshot.skipped).toEqual([]);
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});
});

describe("模型输入类型与能力", () => {
	it("接受视频、PDF 输入与能力标记", () => {
		const model = ModelSchema.parse({
			id: "vision",
			maxTokens: 8192,
			reasoning: true,
			reasoningEfforts: ["minimal", "high"],
			input: ["text", "image", "video", "pdf"],
			capabilities: ["structured-output", "web-search", "mid-conversation-system"],
		});

		expect(model.input).toEqual(["text", "image", "video", "pdf"]);
		expect(model.capabilities).toEqual(["structured-output", "web-search", "mid-conversation-system"]);
		expect(model.reasoningEfforts).toEqual(["minimal", "high"]);
	});

	it("未配置能力标记时保持缺省", () => {
		const model = ModelSchema.parse({ id: "text-only", maxTokens: 8192, reasoning: false, input: ["text"] });

		expect(model.capabilities).toBeUndefined();
		expect(model.reasoningEfforts).toBeUndefined();
	});

	it("兼容旧版单档位 reasoningEffort 字段", () => {
		const model = ModelSchema.parse({
			id: "legacy",
			maxTokens: 8192,
			reasoning: true,
			reasoningEffort: "high",
			input: ["text"],
		});

		expect(model.reasoningEffort).toBe("high");
	});
});
