import type { ReasoningEffort } from "../llm/types.ts";
import type { ModelInputType, ProviderConfig } from "./schema.ts";
import { resolveSecret } from "./secrets.ts";

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_ERROR_DETAIL = 300;

const REASONING_EFFORTS: readonly ReasoningEffort[] = ["minimal", "low", "medium", "high", "max"];
const MODEL_INPUT_TYPES: readonly ModelInputType[] = ["text", "image", "video", "pdf"];

/** 供应商 `/models` 接口返回的模型条目；能力字段取决于上游是否提供。 */
export interface DiscoveredModel {
	readonly id: string;
	readonly name?: string;
	/** 上下文窗口（context_window / context_length）。 */
	readonly contextWindow?: number;
	/** 最大生成 Token（max_output_tokens）：写入模型表单的 maxTokens，控制单次生成上限。 */
	readonly maxTokens?: number;
	readonly input?: readonly ModelInputType[];
	/** 上游是否声明支持推理。 */
	readonly reasoning?: boolean;
	readonly reasoningEfforts?: readonly Exclude<ReasoningEffort, "off">[];
}

/** 读取供应商可用模型的请求；API Key 支持 `${ENV}` 与 `!command` 表达式。 */
export interface DiscoverProviderModelsInput {
	readonly api: ProviderConfig["api"];
	readonly baseUrl: string;
	readonly apiKey: string;
	readonly timeoutMs?: number;
}

/** UI 发起的模型发现请求：可直接提供密钥，或复用已保存供应商的密钥。 */
export interface DiscoverModelsRequest {
	readonly api: ProviderConfig["api"];
	readonly baseUrl: string;
	readonly apiKey?: string;
	readonly providerName?: string;
	readonly timeoutMs?: number;
}

export interface DiscoverProviderModelsOptions {
	readonly fetch?: typeof fetch;
	readonly env?: NodeJS.ProcessEnv;
	readonly signal?: AbortSignal;
}

/**
 * 从供应商的 `/models` 接口读取模型列表；只发 GET，不修改任何配置。
 * @param input 供应商 API 类型、Base URL、密钥表达式，可选超时时间。
 * @param options 可注入的 fetch、环境变量与取消信号，便于测试与代理场景扩展。
 * @returns 去重后的模型条目，保留供应商返回顺序。
 * @throws Base URL 非法、密钥缺失/解析失败、请求失败或响应不是模型列表时。
 */
export async function discoverProviderModels(
	input: DiscoverProviderModelsInput,
	options: DiscoverProviderModelsOptions = {},
): Promise<readonly DiscoveredModel[]> {
	const endpoint = modelsEndpoint(input.baseUrl);
	const rawKey = input.apiKey.trim();
	if (rawKey.length === 0) throw new Error("请先填写 API Key");
	const apiKey = await resolveSecret(rawKey, options);
	const headers = new Headers({ accept: "application/json" });
	if (input.api === "anthropic-messages") {
		headers.set("x-api-key", apiKey);
		headers.set("anthropic-version", "2023-06-01");
	} else {
		headers.set("authorization", `Bearer ${apiKey}`);
	}

	const controller = new AbortController();
	const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	const signal =
		options.signal === undefined ? controller.signal : AbortSignal.any([options.signal, controller.signal]);
	try {
		const response = await (options.fetch ?? fetch)(endpoint, { method: "GET", headers, signal });
		if (!response.ok) {
			const detail = await errorDetail(response);
			throw new Error(`获取模型失败（HTTP ${response.status}）${detail.length === 0 ? "" : `：${detail}`}`);
		}
		let payload: unknown;
		try {
			payload = await response.json();
		} catch {
			throw new Error("模型列表响应不是有效 JSON");
		}
		const models = extractDiscoveredModels(payload);
		if (models.length === 0) throw new Error("供应商未返回可用模型");
		return models;
	} catch (error) {
		if (controller.signal.aborted && options.signal?.aborted !== true) {
			throw new Error("获取模型超时，请检查网络或 Base URL");
		}
		throw error;
	} finally {
		clearTimeout(timer);
	}
}

/** 规范化 Base URL 并拼接 `/models`；拒绝非 HTTP(S) 协议。 */
function modelsEndpoint(value: string): string {
	let url: URL;
	try {
		url = new URL(value.trim());
	} catch {
		throw new Error("请填写有效的 Base URL");
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error("Base URL 必须是 HTTP 或 HTTPS 地址");
	}
	url.search = "";
	url.hash = "";
	url.pathname = `${url.pathname.replace(/\/+$/, "")}/models`;
	return url.toString();
}

/** 兼容 OpenAI `data`、部分供应商的 `models` 字段以及裸数组响应。 */
function extractDiscoveredModels(payload: unknown): readonly DiscoveredModel[] {
	const candidates = Array.isArray(payload)
		? payload
		: isRecord(payload) && Array.isArray(payload.data)
			? payload.data
			: isRecord(payload) && Array.isArray(payload.models)
				? payload.models
				: [];
	const models: DiscoveredModel[] = [];
	const seen = new Set<string>();
	for (const candidate of candidates) {
		const item = normalizeModel(candidate);
		if (item === undefined || seen.has(item.id)) continue;
		seen.add(item.id);
		models.push(item);
	}
	return models;
}

function normalizeModel(candidate: unknown): DiscoveredModel | undefined {
	if (typeof candidate === "string") {
		const id = candidate.trim();
		return id.length === 0 ? undefined : { id };
	}
	if (!isRecord(candidate)) return undefined;
	const idValue = candidate.id ?? candidate.model ?? candidate.name;
	if (typeof idValue !== "string") return undefined;
	const id = idValue.trim();
	if (id.length === 0) return undefined;
	const nameValue = candidate.display_name ?? (candidate.name === id ? undefined : candidate.name);
	const name = typeof nameValue === "string" ? nameValue.trim() : "";
	const contextWindow = positiveInt(candidate.context_window ?? candidate.context_length);
	const maxTokens = positiveInt(candidate.max_output_tokens);
	const input = extractInputs(candidate.modalities);
	const reasoningEfforts = extractEfforts(candidate);
	return {
		id,
		...(name.length === 0 ? {} : { name }),
		...(contextWindow === undefined ? {} : { contextWindow }),
		...(maxTokens === undefined ? {} : { maxTokens }),
		...(input === undefined ? {} : { input }),
		...(candidate.reasoning === true ? { reasoning: true } : {}),
		...(reasoningEfforts.length === 0 ? {} : { reasoningEfforts }),
	};
}

function positiveInt(value: unknown): number | undefined {
	return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

/** 把上游 modalities.input（如 text / image/jpeg）映射到本地输入类型。 */
function extractInputs(modalities: unknown): readonly ModelInputType[] | undefined {
	if (!isRecord(modalities) || !Array.isArray(modalities.input)) return undefined;
	const found = new Set<ModelInputType>();
	for (const value of modalities.input) {
		if (typeof value !== "string") continue;
		const normalized = value.toLowerCase();
		const mapped = MODEL_INPUT_TYPES.find((type) => normalized === type || normalized.startsWith(`${type}/`));
		if (mapped !== undefined) found.add(mapped);
	}
	return found.size === 0 ? undefined : MODEL_INPUT_TYPES.filter((type) => found.has(type));
}

/** 从 reasoning_levels / supported_reasoning_levels 提取合法推理档位。 */
function extractEfforts(candidate: Record<string, unknown>): readonly Exclude<ReasoningEffort, "off">[] {
	const values: unknown[] = [];
	if (Array.isArray(candidate.reasoning_levels)) values.push(...candidate.reasoning_levels);
	if (Array.isArray(candidate.supported_reasoning_levels)) {
		for (const entry of candidate.supported_reasoning_levels) {
			if (isRecord(entry)) values.push(entry.effort);
		}
	}
	const found = new Set<Exclude<ReasoningEffort, "off">>();
	for (const value of values) {
		if (typeof value !== "string") continue;
		if ((REASONING_EFFORTS as readonly string[]).includes(value)) {
			found.add(value as Exclude<ReasoningEffort, "off">);
		}
	}
	return REASONING_EFFORTS.filter(
		(effort) => effort !== "off" && found.has(effort as Exclude<ReasoningEffort, "off">),
	) as readonly Exclude<ReasoningEffort, "off">[];
}

/** 提取供应商错误消息；避免把整段响应或凭据带进界面。 */
async function errorDetail(response: Response): Promise<string> {
	const raw = (await response.text().catch(() => "")).trim();
	if (raw.length === 0) return "";
	try {
		const value: unknown = JSON.parse(raw);
		if (isRecord(value)) {
			const nested = value.error;
			if (typeof nested === "string") return truncate(nested);
			if (isRecord(nested) && typeof nested.message === "string") return truncate(nested.message);
			if (typeof value.message === "string") return truncate(value.message);
		}
	} catch {
		// 非 JSON 错误体按纯文本截断展示
	}
	return truncate(raw);
}

function truncate(value: string): string {
	return value.length <= MAX_ERROR_DETAIL ? value : `${value.slice(0, MAX_ERROR_DETAIL - 1)}…`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}
