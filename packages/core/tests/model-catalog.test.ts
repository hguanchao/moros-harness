import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
	applyModelMetadata,
	lookupModelMetadata,
	parseCatalog,
	refreshModelCatalog,
	type ModelCatalog,
	type ModelMetadata,
} from "@moros/core/config/model-catalog/metadata.ts";

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const tempDirs: string[] = [];
async function makeCachePath(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "model-catalog-"));
	tempDirs.push(dir);
	return join(dir, "catalog.json");
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("parseCatalog", () => {
	it("解析 limit、模态与推理档位，并把 MIME 映射到本地输入类型", () => {
		const catalog = parseCatalog({
			anthropic: {
				models: {
					"claude-x": {
						name: "Claude X",
						limit: { context: 200000, output: 64000 },
						modalities: {
							input: ["text", "image/jpeg", "image/png", "application/pdf", "audio/wav", "video/mp4"],
							output: ["text"],
						},
						reasoning_options: [{ type: "effort", values: ["low", "high", "xhigh"] }],
					},
				},
			},
		});

		expect(catalog["claude-x"]).toEqual({
			name: "Claude X",
			contextWindow: 200000,
			maxTokens: 64000,
			input: ["text", "image", "video", "pdf"],
			reasoningEfforts: ["low", "high"],
		});
	});

	it("推理仅有布尔支持时保守填 medium", () => {
		const catalog = parseCatalog({
			openai: { models: { "gpt-x": { name: "GPT X", reasoning: true } } },
		});
		expect(catalog["gpt-x"]?.reasoningEfforts).toEqual(["medium"]);
	});

	it("非正数 limit 与未知模态被忽略", () => {
		const catalog = parseCatalog({
			x: {
				models: {
					"m-1": {
						limit: { context: 0, output: -1 },
						modalities: { input: ["font/woff2"] },
					},
				},
			},
		});
		expect(catalog["m-1"]).toEqual({});
	});

	it("同一 ID 多供应商时逐字段合并，先出现的非空值优先", () => {
		const catalog = parseCatalog({
			first: { models: { shared: { name: "First", limit: { context: 100 } } } },
			second: {
				models: {
					shared: { name: "Second", limit: { context: 200, output: 50 }, reasoning: true },
				},
			},
		});
		expect(catalog.shared).toEqual({
			name: "First",
			contextWindow: 100,
			maxTokens: 50,
			reasoningEfforts: ["medium"],
		});
	});

	it("非对象载荷返回空表", () => {
		expect(parseCatalog(null)).toEqual({});
		expect(parseCatalog([])).toEqual({});
	});
});

interface FormShape {
	name: string;
	contextWindow: string;
	maxTokens: string;
	input: ("text" | "image" | "video" | "pdf")[];
	reasoningEfforts: ("minimal" | "low" | "medium" | "high" | "max")[];
}

const defaults: FormShape = {
	name: "",
	contextWindow: "",
	maxTokens: "8192",
	input: ["text"],
	reasoningEfforts: [],
};

describe("applyModelMetadata", () => {
	const metadata: ModelMetadata = {
		name: "Filled Name",
		contextWindow: 128000,
		maxTokens: 32000,
		input: ["text", "image"],
		reasoningEfforts: ["low", "high"],
	};

	it("仅回填仍为默认值的字段，不修改入参", () => {
		const current: FormShape = { ...defaults };
		const filled = applyModelMetadata(current, defaults, metadata);
		expect(filled).toEqual({
			name: "Filled Name",
			contextWindow: "128000",
			maxTokens: "32000",
			input: ["text", "image"],
			reasoningEfforts: ["low", "high"],
		});
		expect(current).toEqual(defaults);
	});

	it("用户已修改的字段保持原值", () => {
		const current: FormShape = {
			name: "My Name",
			contextWindow: "999",
			maxTokens: "1234",
			input: ["text", "pdf"],
			reasoningEfforts: ["max"],
		};
		expect(applyModelMetadata(current, defaults, metadata)).toEqual(current);
	});

	it("元数据未提供的字段保留原值", () => {
		const current: FormShape = { ...defaults, name: "Keep" };
		const filled = applyModelMetadata(current, defaults, { contextWindow: 64000 });
		expect(filled.name).toBe("Keep");
		expect(filled.contextWindow).toBe("64000");
		expect(filled.maxTokens).toBe("8192");
	});
});

describe("refreshModelCatalog", () => {
	it("拉取并解析目录后写入缓存", async () => {
		const cachePath = await makeCachePath();
		const payload = { x: { models: { m1: { name: "M1", limit: { context: 10 } } } } };
		const ok = await refreshModelCatalog({
			cachePath,
			now: () => 1000,
			sourceUrl: "https://example.test/catalog.json",
			fetch: async () => jsonResponse(payload),
		});
		expect(ok).toBe(true);
		const cache = JSON.parse(await readFile(cachePath, "utf8"));
		expect(cache.fetchedAt).toBe(1000);
		expect(cache.catalog.m1).toEqual({ name: "M1", contextWindow: 10 });
	});

	it("HTTP 失败或空目录返回 false", async () => {
		const badStatus = await refreshModelCatalog({ fetch: async () => jsonResponse({}, 500) });
		const empty = await refreshModelCatalog({ fetch: async () => jsonResponse({}) });
		expect(badStatus).toBe(false);
		expect(empty).toBe(false);
	});
});

describe("lookupModelMetadata", () => {
	const catalog: ModelCatalog = { known: { name: "Known", contextWindow: 100 } };

	it("命中注入的 catalog", async () => {
		const result = await lookupModelMetadata("known", {
			catalog,
			fetch: async () => {
				throw new Error("no fetch");
			},
		});
		expect(result).toEqual({ name: "Known", contextWindow: 100 });
	});

	it("未命中返回 null", async () => {
		const result = await lookupModelMetadata("missing", { catalog });
		expect(result).toBeNull();
	});

	it("带供应商前缀的 ID 未精确命中时按裸模型名回退", async () => {
		const prefixedCatalog: ModelCatalog = { "deepseek-v4.1-flash": { name: "Flash", contextWindow: 100 } };
		const result = await lookupModelMetadata("auto/deepseek-v4.1-flash", { catalog: prefixedCatalog });
		expect(result).toEqual({ name: "Flash", contextWindow: 100 });
	});

	it("精确命中优先于裸模型名回退", async () => {
		const prefixedCatalog: ModelCatalog = {
			"gateway/flash": { name: "Prefixed", contextWindow: 1 },
			flash: { name: "Bare", contextWindow: 2 },
		};
		const result = await lookupModelMetadata("gateway/flash", { catalog: prefixedCatalog });
		expect(result).toEqual({ name: "Prefixed", contextWindow: 1 });
	});

	it("带前缀 ID 无对应裸模型时返回 null", async () => {
		const result = await lookupModelMetadata("auto/unique-prefixed-only", { catalog });
		expect(result).toBeNull();
	});

	it("命中新鲜缓存并用其字段补全快照", async () => {
		const cachePath = await makeCachePath();
		await writeFile(cachePath, JSON.stringify({ fetchedAt: 1000, catalog: { known: { maxTokens: 42 } } }), "utf8");
		const result = await lookupModelMetadata("known", {
			catalog,
			cachePath,
			now: () => 1000 + 1000,
			cacheTtlMs: 5000,
		});
		expect(result).toEqual({ name: "Known", contextWindow: 100, maxTokens: 42 });
	});

	it("缓存过期时回退注入 catalog 并在后台刷新", async () => {
		const cachePath = await makeCachePath();
		await writeFile(cachePath, JSON.stringify({ fetchedAt: 0, catalog: {} }), "utf8");
		let fetched = false;
		const staleCatalog: ModelCatalog = { known: { name: "Snapshot" } };
		const result = await lookupModelMetadata("known", {
			catalog: staleCatalog,
			cachePath,
			now: () => 999_999,
			cacheTtlMs: 1000,
			fetch: async () => {
				fetched = true;
				return jsonResponse({ x: { models: { known: { name: "Fresh" } } } });
			},
		});
		expect(result).toEqual({ name: "Snapshot" });
		await Promise.resolve();
		await Promise.resolve();
		expect(fetched).toBe(true);
		// 后台刷新会原子写缓存；等写入完成再让 afterEach 清理临时目录，
		// 否则 Windows 上 rmdir 会与 rename 竞争并抛 ENOTEMPTY。
		for (let attempt = 0; attempt < 100; attempt += 1) {
			try {
				const written = JSON.parse(await readFile(cachePath, "utf8"));
				if (written.fetchedAt === 999_999) break;
			} catch {
				// 原子写入尚未 rename，稍后重试
			}
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
	});

	it("缓存内容损坏时回退快照不抛错", async () => {
		const cachePath = await makeCachePath();
		await writeFile(cachePath, "{ not json", "utf8");
		const result = await lookupModelMetadata("known", { catalog, cachePath, now: () => 1 });
		expect(result).toEqual({ name: "Known", contextWindow: 100 });
	});
});
