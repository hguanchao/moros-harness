import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { Core } from "../src/core.ts";
import { parseProvidersFile, ProviderSchema, type ProviderConfig } from "../src/config/schema.ts";
import { readSettings, upsertProvider } from "../src/config/settings.ts";

const PROVIDER_FIELDS = {
	api: "chat-completions",
	baseUrl: "https://provider.example/v1",
	apiKey: "${MOROS_TEST_PROVIDER_KEY}",
	headers: { "x-fixture": "retained" },
	timeoutMs: 120_000,
} satisfies Omit<ProviderConfig, "models">;

const LAST_MODEL = {
	id: "last-model",
	maxTokens: 8192,
	reasoning: false,
	input: ["text"],
} satisfies ProviderConfig["models"][number];

const directories: string[] = [];
const cores: Core[] = [];

async function createHome(): Promise<string> {
	const homeDir = await mkdtemp(join(tmpdir(), "moros-provider-models-"));
	directories.push(homeDir);
	await mkdir(join(homeDir, ".moros"));
	return homeDir;
}

function openCore(homeDir: string): Core {
	const core = new Core({ homeDir });
	cores.push(core);
	return core;
}

afterEach(async () => {
	await Promise.all(cores.splice(0).map((core) => core.dispose()));
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("空模型供应商校验", () => {
	it("供应商 schema 接受明确的空模型数组", () => {
		expect(ProviderSchema.parse({ ...PROVIDER_FIELDS, models: [] }).models).toEqual([]);
	});

	it("解析注册表时保留合法的空模型供应商", () => {
		const provider = { ...PROVIDER_FIELDS, models: [] };

		expect(parseProvidersFile({ providers: { fixture: provider } })).toEqual({
			providers: { providers: { fixture: provider } },
			skipped: [],
		});
	});

	it.each([
		{ scenario: "缺失模型数组", models: undefined, reason: "No valid models" },
		{ scenario: "模型字段不是数组", models: {}, reason: "No valid models" },
		{ scenario: "非空数组中的模型全部无效", models: [{ id: "invalid" }], reason: "All models invalid" },
	])("$scenario 时继续跳过供应商", ({ models, reason }) => {
		const parsed = parseProvidersFile({ providers: { fixture: { ...PROVIDER_FIELDS, models } } });

		expect(parsed.providers.providers).toEqual({});
		expect(parsed.skipped).toEqual([{ path: "providers.fixture", reason }]);
	});

	it("非空数组仍逐条跳过无效模型并保留有效模型", () => {
		const parsed = parseProvidersFile({
			providers: { fixture: { ...PROVIDER_FIELDS, models: [LAST_MODEL, { id: "invalid" }] } },
		});

		expect(parsed.providers.providers.fixture?.models).toEqual([LAST_MODEL]);
		expect(parsed.skipped).toEqual([expect.objectContaining({ path: "providers.fixture.models[1]" })]);
	});
});

describe("清空供应商模型的保存与重新加载", () => {
	it("删除最后一个模型后保存空列表，保留供应商的其余配置", async () => {
		const homeDir = await createHome();
		await upsertProvider(homeDir, "fixture", { ...PROVIDER_FIELDS, models: [LAST_MODEL] });

		const saved = await upsertProvider(homeDir, "fixture", { models: [] });
		const reopened = await readSettings(homeDir);
		const persisted: unknown = JSON.parse(await readFile(join(homeDir, ".moros", "providers.json"), "utf8"));

		expect(saved.providers).toEqual(reopened.providers);
		expect(saved.providers).toEqual([
			{ ...PROVIDER_FIELDS, name: "fixture", apiKey: { source: "env", display: PROVIDER_FIELDS.apiKey }, models: [] },
		]);
		expect(saved.skipped).toEqual([]);
		expect(persisted).toEqual({ providers: { fixture: { ...PROVIDER_FIELDS, models: [] } } });
	});

	it("依次删除多个模型至空后重新加载，不恢复最后一个模型", async () => {
		const homeDir = await createHome();
		const secondModel = { ...LAST_MODEL, id: "second-model" };
		await upsertProvider(homeDir, "fixture", { ...PROVIDER_FIELDS, models: [LAST_MODEL, secondModel] });

		const remaining = await upsertProvider(homeDir, "fixture", { models: [secondModel] });
		expect(remaining.providers[0]?.models).toEqual([secondModel]);
		await upsertProvider(homeDir, "fixture", { models: [] });

		expect((await readSettings(homeDir)).providers[0]?.models).toEqual([]);
	});

	it("省略 models 的字段更新保留现有列表，包括已清空的列表", async () => {
		const homeDir = await createHome();
		await upsertProvider(homeDir, "fixture", { ...PROVIDER_FIELDS, models: [LAST_MODEL] });

		const nonempty = await upsertProvider(homeDir, "fixture", { timeoutMs: 60_000 });
		expect(nonempty.providers[0]?.models).toEqual([LAST_MODEL]);
		await upsertProvider(homeDir, "fixture", { models: [] });
		const empty = await upsertProvider(homeDir, "fixture", { timeoutMs: 30_000 });

		expect(empty.providers[0]?.models).toEqual([]);
		expect(empty.providers[0]?.timeoutMs).toBe(30_000);
	});

	it("清空后刷新已有 Core 缓存及重新打开 Core，目录和配置保持为空", async () => {
		const homeDir = await createHome();
		const core = openCore(homeDir);
		await core.upsertProvider("fixture", { ...PROVIDER_FIELDS, models: [LAST_MODEL] });
		expect((await core.listModels()).providers[0]?.models.map((model) => model.id)).toEqual([LAST_MODEL.id]);
		await core.loadConfig();

		await core.upsertProvider("fixture", { models: [] });

		expect((await core.listModels()).providers).toEqual([{ name: "fixture", models: [] }]);
		expect((await core.loadConfig()).providers.providers.fixture?.models).toEqual([]);
		const reopened = openCore(homeDir);
		expect((await reopened.listModels()).providers).toEqual([{ name: "fixture", models: [] }]);
		expect((await reopened.loadConfig()).providers.providers.fixture?.models).toEqual([]);
	});

	it("清空后不自动补回默认模型，选择已删除模型返回明确错误", async () => {
		const homeDir = await createHome();
		const core = openCore(homeDir);
		await core.upsertProvider("fixture", { ...PROVIDER_FIELDS, models: [LAST_MODEL] });
		await core.setDefaultModel("fixture", LAST_MODEL.id);

		await core.upsertProvider("fixture", { models: [] });

		expect((await core.listModels()).providers).toEqual([{ name: "fixture", models: [] }]);
		await expect(core.setDefaultModel("fixture", LAST_MODEL.id)).rejects.toThrow(
			`Unknown model: fixture/${LAST_MODEL.id}`,
		);
		expect((await core.getSettings()).config).toMatchObject({ provider: "fixture", model: LAST_MODEL.id });
	});
});
