import { z } from "zod";

import { parseMcpServers } from "../mcp/config.ts";
import type { McpServerConfig } from "../mcp/types.ts";

const SecretValueSchema = z.string();

export const ModelInputTypeSchema = z.enum(["text", "image", "video", "pdf"]);

export const ModelCapabilitySchema = z.enum(["structured-output", "web-search", "mid-conversation-system"]);

export const ModelSchema = z.object({
	id: z.string().min(1),
	name: z.string().optional(),
	contextWindow: z.number().int().positive().optional(),
	maxTokens: z.number().int().positive(),
	reasoning: z.boolean(),
	/** 旧版单档位字段；新配置使用 reasoningEfforts。 */
	reasoningEffort: z.enum(["off", "minimal", "low", "medium", "high", "max"]).optional(),
	reasoningEfforts: z.array(z.enum(["minimal", "low", "medium", "high", "max"])).optional(),
	input: z.array(ModelInputTypeSchema).default(["text"]),
	capabilities: z.array(ModelCapabilitySchema).optional(),
	cost: z
		.object({
			input: z.number().nonnegative(),
			output: z.number().nonnegative(),
			cacheRead: z.number().nonnegative().optional(),
			cacheWrite: z.number().nonnegative().optional(),
		})
		.optional(),
});

export const ProviderSchema = z.object({
	api: z.enum(["anthropic-messages", "chat-completions", "responses"]),
	baseUrl: z
		.string()
		.url()
		.refine((value) => ["http:", "https:"].includes(new URL(value).protocol)),
	apiKey: SecretValueSchema.default(""),
	headers: z.record(z.string(), z.string()).optional(),
	timeoutMs: z.number().int().positive().default(120_000),
	/** 允许暂不配置模型，保留供应商供设置页继续编辑。 */
	models: z.array(ModelSchema),
});

export const ProvidersFileSchema = z.object({
	providers: z.record(z.string().min(1), ProviderSchema),
});

/** 供应商骨架（不含 models）：逐条容错时先校验骨架，模型再逐条校验。 */
const ProviderBaseSchema = ProviderSchema.omit({ models: true });

const ConfigSchema = z.object({
	provider: z.string().optional(),
	model: z.string().optional(),
	/** 压缩摘要模型：`modelId` 或 `provider/modelId`；缺省复用 model。 */
	compactModel: z.string().optional(),
	/** auto 档高危审查模型：`modelId` 或 `provider/modelId`；缺省复用 model。 */
	reviewModel: z.string().optional(),
	reasoningEffort: z.enum(["off", "minimal", "low", "medium", "high", "max"]).default("off"),
	approval: z.enum(["ask", "auto", "yolo"]).default("ask"),
	shellPath: z.string().optional(),
	httpProxy: z.string().url().optional(),
	limits: z
		.object({
			maxTurns: z.number().int().nonnegative().default(0),
			spillThreshold: z.number().int().nonnegative().default(8192),
			streamIdleTimeoutSec: z.number().nonnegative().default(0),
			/** auto 档高风险审查的单次模型调用时限；推理模型偏慢，过短会频繁超时退回人工。 */
			reviewTimeoutSec: z.number().int().positive().max(600).default(90),
		})
		.default({ maxTurns: 0, spillThreshold: 8192, streamIdleTimeoutSec: 0, reviewTimeoutSec: 90 }),
	retry: z
		.object({
			maxRetries: z.number().int().nonnegative().default(3),
			maxDelayMs: z.number().int().nonnegative().default(60_000),
		})
		.default({ maxRetries: 3, maxDelayMs: 60_000 }),
	compaction: z
		.object({
			compactAt: z.number().min(0).max(1).default(0.8),
			keepRecent: z.number().min(0).max(1).default(0.25),
			summaryTimeoutSec: z.number().nonnegative().default(0),
		})
		.default({ compactAt: 0.8, keepRecent: 0.25, summaryTimeoutSec: 0 }),
	ui: z
		.object({
			theme: z.enum(["auto", "light", "dark"]).default("auto"),
			notify: z.enum(["auto", "bell", "desktop", "off"]).default("auto"),
			/** 界面文字基准字号（px）；图标与布局尺寸不受影响。 */
			fontSize: z.number().int().min(12).max(20).default(14),
			/** 界面字体：system 用平台栈；wenkai/maple 使用应用内置的web字体。 */
			fontFamily: z.enum(["system", "wenkai", "maple"]).default("system"),
		})
		.default({ theme: "auto", notify: "auto", fontSize: 14, fontFamily: "system" }),
	/** 按项目路径记录的工作区信任决定；键为归一化路径（win32 小写）。 */
	trusts: z.record(z.string(), z.boolean()).optional(),
});

export type ModelInputType = z.infer<typeof ModelInputTypeSchema>;
export type ModelCapability = z.infer<typeof ModelCapabilitySchema>;
export type ProviderConfig = z.infer<typeof ProviderSchema>;
export type ProvidersFile = z.infer<typeof ProvidersFileSchema>;
/** 应用配置；MCP server 表由 `[mcp_servers]` 单独解析，校验失败的条目只跳过自己。 */
export type AppConfig = z.infer<typeof ConfigSchema> & {
	readonly mcpServers: readonly McpServerConfig[];
};

/** 被逐条容错跳过的坏条目：path 定位到 providers.json / config.toml 里的具体位置。 */
export interface ConfigSkip {
	/** 条目路径，如 `providers.foo.models[2]` 或 config.toml 的未知键名。 */
	readonly path: string;
	/** 跳过原因（校验问题的简述）。 */
	readonly reason: string;
}

export interface ParsedProvidersFile {
	/** 通过校验的注册表（与 providers.json 同构的文件形态）。 */
	readonly providers: ProvidersFile;
	readonly skipped: readonly ConfigSkip[];
}

/** 首条校验问题的简述；zod 的 issue JSON 太长，诊断只需要一句人话。 */
function firstIssueReason(error: z.ZodError): string {
	const issue = error.issues[0];
	if (!issue) return "invalid entry";
	const path = issue.path.length > 0 ? ` at ${issue.path.join(".")}` : "";
	return `${issue.message}${path}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * 校验供应商注册表（逐条容错，ADR-15）。
 *
 * 一个坏条目只跳过它自己并记入 skipped，好条目照常进注册表——手写一个不合规条目
 * 不再把整个注册表（连同 /model 的自助修复入口）拖死。容错粒度两级：供应商骨架
 * 与其下每个模型各自独立校验；模型 ID 在供应商内唯一，冲突时保留首个、后续跳过。
 * 明确的空模型数组保留供应商；非空数组中的模型全部无效时仍跳过供应商。
 * 条目里的未知字段剥离（不记录）。
 * @param value 从 JSON 文件或其他外部来源读取的值。
 * @returns 通过校验的注册表与被跳过条目的清单。
 * @throws 顶层结构损坏（providers 字段缺失或不是对象）时抛出——文件级损坏无法定位条目。
 */
export function parseProvidersFile(value: unknown): ParsedProvidersFile {
	if (!isRecord(value) || !isRecord(value.providers)) {
		throw new Error("providers.json must contain an object field `providers`");
	}
	const skipped: ConfigSkip[] = [];
	const registry: Record<string, ProviderConfig> = {};
	for (const [providerId, raw] of Object.entries(value.providers)) {
		const base = ProviderBaseSchema.safeParse(raw);
		if (!base.success) {
			skipped.push({ path: `providers.${providerId}`, reason: firstIssueReason(base.error) });
			continue;
		}
		const rawModels = isRecord(raw) ? raw.models : undefined;
		if (!Array.isArray(rawModels)) {
			skipped.push({ path: `providers.${providerId}`, reason: "No valid models" });
			continue;
		}
		const models: ProviderConfig["models"] = [];
		const modelSkips: ConfigSkip[] = [];
		const ids = new Set<string>();
		for (const [index, rawModel] of rawModels.entries()) {
			const model = ModelSchema.safeParse(rawModel);
			if (!model.success) {
				modelSkips.push({ path: `providers.${providerId}.models[${index}]`, reason: firstIssueReason(model.error) });
				continue;
			}
			if (ids.has(model.data.id)) {
				modelSkips.push({
					path: `providers.${providerId}.models[${index}]`,
					reason: `Duplicate model id: ${model.data.id}`,
				});
				continue;
			}
			ids.add(model.data.id);
			models.push(model.data);
		}
		if (rawModels.length > 0 && models.length === 0) {
			// 整供应商跳过时模型级 skip 是冗余细节，只留条目级一条
			skipped.push({ path: `providers.${providerId}`, reason: "All models invalid" });
			continue;
		}
		skipped.push(...modelSkips);
		registry[providerId] = { ...base.data, models };
	}
	return { providers: { providers: registry }, skipped };
}

/**
 * 校验合并后的 TOML 配置（未知键剥离并记录，ADR-15）。
 *
 * 顶层与四个嵌套组里的未知键不再让整个配置加载失败——手写错别字键或自定义小节
 * 只会被剥离并记入 skipped（doctor 与界面启动警告展示），其余配置照常生效。
 * 双拼写并存（如 reasoning_effort 与 reasoningEffort）仍属配置错误，由
 * normalizeConfigKeys 硬拒：歧义配置不能静默任选。
 * @param value 合并归一后的原始配置值。
 * @returns 校验后的配置与被剥离未知键的清单。
 */
export function parseConfig(
	value: unknown,
	mcpServers: unknown = isRecord(value) ? value["mcpServers"] : undefined,
): { config: AppConfig; skipped: ConfigSkip[] } {
	const config = ConfigSchema.parse(value);
	const skipped: ConfigSkip[] = [];
	const knownTop = new Set([
		"provider",
		"model",
		"compactModel",
		"reviewModel",
		"reasoningEffort",
		"approval",
		"shellPath",
		"httpProxy",
		"limits",
		"retry",
		"compaction",
		"ui",
		"trusts",
		"mcpServers",
	]);
	const source = isRecord(value) ? value : {};
	for (const key of Object.keys(source)) {
		if (!knownTop.has(key)) skipped.push({ path: key, reason: "Unknown config key (stripped)" });
	}
	const groups: ReadonlyArray<readonly [string, readonly string[]]> = [
		["limits", ["maxTurns", "spillThreshold", "streamIdleTimeoutSec", "reviewTimeoutSec"]],
		["retry", ["maxRetries", "maxDelayMs"]],
		["compaction", ["compactAt", "keepRecent", "summaryTimeoutSec"]],
		["ui", ["theme", "notify", "fontSize", "fontFamily"]],
	];
	for (const [group, keys] of groups) {
		const raw = isRecord(source[group]) ? source[group] : {};
		for (const key of Object.keys(raw)) {
			if (!keys.includes(key)) skipped.push({ path: `${group}.${key}`, reason: "Unknown config key (stripped)" });
		}
	}
	if (config.httpProxy) {
		const protocol = new URL(config.httpProxy).protocol;
		if (protocol !== "http:" && protocol !== "https:") throw new Error("httpProxy must use HTTP or HTTPS");
	}
	// MCP server 表逐条校验：一个坏条目只跳过自己，其余 server 照常进配置
	const mcp = parseMcpServers(mcpServers);
	return {
		config: { ...config, mcpServers: mcp.servers },
		skipped: [...skipped, ...mcp.skipped],
	};
}

export interface ParsedProvidersFile {
	readonly providers: ProvidersFile;
	readonly skipped: readonly ConfigSkip[];
}
