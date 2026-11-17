import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import { atomicWriteFile } from "#src/core/atomic-file.ts";
import { isMissingPath } from "#src/core/fs-error.ts";
import { loadConfig } from "#src/core/config/loader.ts";
import {
	ModelSchema,
	parseProvidersFile,
	ProviderSchema,
	type AppConfig,
	type ConfigSkip,
	type ProviderConfig,
} from "#src/core/config/schema.ts";
import { updateGlobalSettings } from "#src/core/config/writer.ts";

/** 密钥来源：空、环境变量、`!command` 或明文。 */
export type SecretSource = "empty" | "env" | "command" | "literal";

export interface SecretView {
	/** 展示文本：环境变量/命令显示表达式，明文只显示掩码。 */
	readonly display: string;
	readonly source: SecretSource;
}

/** 设置页可见的供应商；不含明文密钥。 */
export interface ProviderView {
	readonly name: string;
	readonly api: ProviderConfig["api"];
	readonly baseUrl: string;
	readonly timeoutMs: number;
	readonly apiKey: SecretView;
	readonly headers?: Readonly<Record<string, string>>;
	readonly models: ProviderConfig["models"];
}

export interface SettingsSnapshot {
	readonly config: AppConfig;
	readonly providers: readonly ProviderView[];
	readonly skipped: readonly ConfigSkip[];
	readonly configPath: string;
	readonly providersPath: string;
}

const optionalNullableUrl = z
	.string()
	.url()
	.refine((value) => ["http:", "https:"].includes(new URL(value).protocol), "Must be HTTP or HTTPS")
	.nullable();

/** 设置页允许写入的全局配置补丁。 */
export const SettingsPatchSchema = z
	.object({
		provider: z.string().min(1).optional(),
		model: z.string().min(1).optional(),
		reasoningEffort: z.enum(["off", "minimal", "low", "medium", "high", "max"]).optional(),
		approval: z.enum(["ask", "auto", "yolo"]).optional(),
		shellPath: z.string().nullable().optional(),
		httpProxy: optionalNullableUrl.optional(),
		limits: z
			.object({
				maxTurns: z.number().int().nonnegative().optional(),
				spillThreshold: z.number().int().nonnegative().optional(),
				streamIdleTimeoutSec: z.number().nonnegative().optional(),
			})
			.optional(),
		retry: z
			.object({
				maxRetries: z.number().int().nonnegative().optional(),
				maxDelayMs: z.number().int().nonnegative().optional(),
			})
			.optional(),
		compaction: z
			.object({
				compactAt: z.number().min(0).max(1).optional(),
				keepRecent: z.number().min(0).max(1).optional(),
				summaryTimeoutSec: z.number().nonnegative().optional(),
			})
			.optional(),
		ui: z
			.object({
				theme: z.enum(["auto", "light", "dark"]).optional(),
				notify: z.enum(["auto", "bell", "desktop", "off"]).optional(),
			})
			.optional(),
	})
	.strict();

export type SettingsPatch = z.infer<typeof SettingsPatchSchema>;

const ProviderDraftSchema = ProviderSchema.partial()
	.extend({ apiKey: z.string().optional(), models: z.array(ModelSchema).optional() })
	.strict();

/** 供应商新增/编辑补丁；`***` 表示保留原密钥。 */
export type ProviderDraft = z.infer<typeof ProviderDraftSchema>;

function configPath(homeDir: string): string {
	return join(homeDir, ".moros", "config.toml");
}

function providersPath(homeDir: string): string {
	return join(homeDir, ".moros", "providers.json");
}

/** 读取设置快照；密钥脱敏，明文只显示 `***`。 */
export async function readSettings(homeDir: string): Promise<SettingsSnapshot> {
	const loaded = await loadConfig({ homeDir });
	const providers = Object.entries(loaded.providers.providers).map(([name, provider]): ProviderView => {
		const { apiKey, headers, ...rest } = provider;
		return {
			name,
			...rest,
			apiKey: describeSecret(apiKey),
			...(headers ? { headers: maskHeaders(headers) } : {}),
		};
	});
	return {
		config: loaded.config,
		providers,
		skipped: loaded.skipped,
		configPath: configPath(homeDir),
		providersPath: providersPath(homeDir),
	};
}

/**
 * 写回全局配置补丁。
 * @throws 补丁不合法或配置文件损坏时抛出错误。
 */
export async function writeSettings(homeDir: string, patch: SettingsPatch): Promise<SettingsSnapshot> {
	const parsed = SettingsPatchSchema.parse(patch);
	await updateGlobalSettings(parsed, { homeDir });
	return readSettings(homeDir);
}

/** 读取原始密钥表达式（可能是 `${ENV}` 或 `!command`，不解析成真实值）。 */
export async function revealProviderSecret(homeDir: string, name: string): Promise<string> {
	const raw = await readProvidersJson(homeDir);
	const provider = raw.providers[name];
	if (!provider) throw new Error(`Unknown provider: ${name}`);
	return provider.apiKey ?? "";
}

/**
 * 新增或更新供应商；未提供的字段沿用原值，apiKey 为 `***` 时保留原密钥。
 * @throws 合并后条目未通过校验时抛出错误，文件不会被改写。
 */
export async function upsertProvider(homeDir: string, name: string, draft: ProviderDraft): Promise<SettingsSnapshot> {
	if (name.trim().length === 0) throw new Error("Provider name must not be empty");
	const parsed = ProviderDraftSchema.parse(draft);
	const raw = await readProvidersJson(homeDir);
	const existing = raw.providers[name];
	const { apiKey: draftKey, ...rest } = stripUndefined(parsed);
	const merged = {
		...(existing ?? {}),
		...rest,
		...(draftKey === undefined || draftKey === "***" ? {} : { apiKey: draftKey }),
	};
	if (merged.apiKey === undefined) merged.apiKey = "";
	delete merged.models;
	const models = parsed.models ?? existing?.models ?? [];
	merged.models = models;
	const candidate = { providers: { ...raw.providers, [name]: merged } };
	const validated = parseProvidersFile(candidate);
	if (!validated.providers.providers[name]) {
		const reason = validated.skipped.find((skip) => skip.path === `providers.${name}`)?.reason ?? "invalid provider";
		throw new Error(`Invalid provider ${name}: ${reason}`);
	}
	await writeProvidersJson(homeDir, candidate);
	return readSettings(homeDir);
}

/** 删除供应商；不存在时抛错。 */
export async function deleteProvider(homeDir: string, name: string): Promise<SettingsSnapshot> {
	const raw = await readProvidersJson(homeDir);
	if (!raw.providers[name]) throw new Error(`Unknown provider: ${name}`);
	const providers = { ...raw.providers };
	delete providers[name];
	await writeProvidersJson(homeDir, { providers });
	return readSettings(homeDir);
}

interface RawProviders {
	providers: Record<string, Partial<ProviderConfig> & { models?: ProviderConfig["models"] }>;
}

/** 读取原始 providers.json；缺失时返回空表，损坏时抛错。 */
async function readProvidersJson(homeDir: string): Promise<RawProviders> {
	const path = providersPath(homeDir);
	try {
		const value: unknown = JSON.parse(await readFile(path, "utf8"));
		if (!isRecord(value) || !isRecord(value.providers)) return { providers: {} };
		return value as unknown as RawProviders;
	} catch (error) {
		if (isMissingPath(error)) return { providers: {} };
		throw new Error(`Cannot read provider registry ${path}`, { cause: error });
	}
}

async function writeProvidersJson(homeDir: string, value: unknown): Promise<void> {
	await atomicWriteFile(providersPath(homeDir), `${JSON.stringify(value, null, 2)}\n`);
}

function describeSecret(value: string): SecretView {
	if (value.length === 0) return { display: "", source: "empty" };
	if (/^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(value)) return { display: value, source: "env" };
	if (value.startsWith("!")) return { display: value, source: "command" };
	return { display: "***", source: "literal" };
}

function maskHeaders(headers: Readonly<Record<string, string>>): Record<string, string> {
	return Object.fromEntries(
		Object.entries(headers).map(([key, value]) => [
			key,
			/api.?key|authorization|cookie|secret|token|password/i.test(key) ? "***" : value,
		]),
	);
}

function stripUndefined<T extends Record<string, unknown>>(value: T): Partial<T> {
	return Object.fromEntries(Object.entries(value).filter(([, child]) => child !== undefined)) as Partial<T>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}
