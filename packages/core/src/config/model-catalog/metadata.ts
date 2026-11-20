import { readFile } from "node:fs/promises";

import { atomicWriteFile } from "../../atomic-file.ts";
import type { ModelInputType } from "../schema.ts";
import type { ModelCatalog, ModelMetadata, ReasoningEffortLevel } from "./fill.ts";

export { applyModelMetadata } from "./fill.ts";
export type { MetadataFillable, ModelCatalog, ModelMetadata, ReasoningEffortLevel } from "./fill.ts";

const DEFAULT_CATALOG_URL = "https://models.dev/api.json";
const DEFAULT_FETCH_TIMEOUT_MS = 10_000;
/** 在线缓存默认有效期：24 小时。 */
const DEFAULT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

const INPUT_PRIORITY: readonly ModelInputType[] = ["text", "image", "video", "pdf"];
const EFFORT_PRIORITY: readonly ReasoningEffortLevel[] = ["minimal", "low", "medium", "high", "max"];

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

/** 把 models.dev 的模态值（如 text / image/png / pdf）映射到本地输入类型枚举。 */
function toInputType(value: string): ModelInputType | undefined {
	const normalized = value.trim().toLowerCase();
	if (normalized.startsWith("text")) return "text";
	if (normalized.startsWith("image")) return "image";
	if (normalized.startsWith("video")) return "video";
	if (normalized === "pdf" || normalized.endsWith("/pdf")) return "pdf";
	return undefined;
}

function positiveInt(value: unknown): number | undefined {
	return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

/**
 * 把 models.dev `api.json` 解析为按模型 ID 索引的紧凑查找表。
 *
 * 同一模型 ID 可能出现在多个供应商下，逐字段合并，先出现且非空的字段优先，
 * 避免某个供应商的缺失值覆盖另一个供应商已有的值。
 */
export function parseCatalog(payload: unknown): ModelCatalog {
	if (!isRecord(payload)) return {};
	const catalog: Record<string, ModelMetadata> = {};
	for (const provider of Object.values(payload)) {
		if (!isRecord(provider) || !isRecord(provider.models)) continue;
		for (const [id, raw] of Object.entries(provider.models)) {
			if (!isRecord(raw) || id.length === 0) continue;
			const current = catalog[id];
			catalog[id] = mergeMetadata(current, normalizeEntry(raw)) as ModelMetadata;
		}
	}
	return catalog;
}

/** 构造期使用的可变版本，避免与对外只读的 ModelMetadata 冲突。 */
type MutableMetadata = { -readonly [K in keyof ModelMetadata]?: ModelMetadata[K] };

function normalizeEntry(raw: Record<string, unknown>): ModelMetadata {
	const metadata: MutableMetadata = {};
	if (typeof raw.name === "string" && raw.name.trim().length > 0) metadata.name = raw.name.trim();

	const limit = isRecord(raw.limit) ? raw.limit : undefined;
	if (limit !== undefined) {
		const context = positiveInt(limit.context);
		const output = positiveInt(limit.output);
		if (context !== undefined) metadata.contextWindow = context;
		if (output !== undefined) metadata.maxTokens = output;
	}

	const modalities = isRecord(raw.modalities) ? raw.modalities : undefined;
	if (modalities !== undefined && Array.isArray(modalities.input)) {
		const inputs = new Set<ModelInputType>();
		for (const value of modalities.input) {
			if (typeof value === "string") {
				const mapped = toInputType(value);
				if (mapped !== undefined) inputs.add(mapped);
			}
		}
		if (inputs.size > 0) metadata.input = INPUT_PRIORITY.filter((type) => inputs.has(type));
	}

	const efforts = extractEfforts(raw);
	if (efforts.length > 0) metadata.reasoningEfforts = efforts;

	return metadata as ModelMetadata;
}

/** 优先取 reasoning_options 中 type=effort 的具体档位；只有布尔支持时保守填 medium。 */
function extractEfforts(raw: Record<string, unknown>): readonly ReasoningEffortLevel[] {
	const options = Array.isArray(raw.reasoning_options) ? raw.reasoning_options : [];
	const effortValues = new Set<ReasoningEffortLevel>();
	for (const option of options) {
		if (!isRecord(option) || option.type !== "effort" || !Array.isArray(option.values)) continue;
		for (const value of option.values) {
			if (typeof value !== "string") continue;
			if ((EFFORT_PRIORITY as readonly string[]).includes(value)) effortValues.add(value as ReasoningEffortLevel);
		}
	}
	if (effortValues.size > 0) return EFFORT_PRIORITY.filter((level) => effortValues.has(level));
	return raw.reasoning === true ? ["medium"] : [];
}

function mergeMetadata(current: ModelMetadata | undefined, next: ModelMetadata | undefined): ModelMetadata | undefined {
	if (current === undefined) return next;
	if (next === undefined) return current;
	return {
		...(current.name !== undefined ? { name: current.name } : next.name !== undefined ? { name: next.name } : {}),
		...(current.contextWindow !== undefined
			? { contextWindow: current.contextWindow }
			: next.contextWindow !== undefined
				? { contextWindow: next.contextWindow }
				: {}),
		...(current.maxTokens !== undefined
			? { maxTokens: current.maxTokens }
			: next.maxTokens !== undefined
				? { maxTokens: next.maxTokens }
				: {}),
		...(current.input !== undefined ? { input: current.input } : next.input !== undefined ? { input: next.input } : {}),
		...(current.reasoningEfforts !== undefined
			? { reasoningEfforts: current.reasoningEfforts }
			: next.reasoningEfforts !== undefined
				? { reasoningEfforts: next.reasoningEfforts }
				: {}),
	};
}

interface CacheFile {
	readonly fetchedAt: number;
	readonly catalog: ModelCatalog;
}

function isCacheFile(value: unknown): value is CacheFile {
	return isRecord(value) && typeof value.fetchedAt === "number" && isRecord(value.catalog);
}

async function readCache(
	cachePath: string | undefined,
	now: () => number,
	ttlMs: number,
): Promise<ModelCatalog | undefined> {
	if (cachePath === undefined) return undefined;
	try {
		const raw: unknown = JSON.parse(await readFile(cachePath, "utf8"));
		if (!isCacheFile(raw) || now() - raw.fetchedAt >= ttlMs) return undefined;
		return raw.catalog;
	} catch {
		return undefined;
	}
}

/** 在线刷新选项；依赖可注入以便测试与自定义数据源。 */
export interface RefreshCatalogOptions {
	readonly fetch?: typeof fetch;
	readonly now?: () => number;
	readonly cachePath?: string;
	readonly sourceUrl?: string;
	readonly timeoutMs?: number;
}

/**
 * 从 models.dev 拉取最新目录，解析后写入本地缓存。
 * @returns 是否成功刷新并写入缓存。
 */
export async function refreshModelCatalog(options: RefreshCatalogOptions = {}): Promise<boolean> {
	const sourceUrl = options.sourceUrl ?? DEFAULT_CATALOG_URL;
	const timeoutMs = options.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await (options.fetch ?? fetch)(sourceUrl, { signal: controller.signal });
		if (!response.ok) return false;
		const payload: unknown = await response.json();
		const catalog = parseCatalog(payload);
		if (Object.keys(catalog).length === 0) return false;
		const cachePath = options.cachePath;
		if (cachePath !== undefined) {
			const cache: CacheFile = { fetchedAt: (options.now ?? Date.now)(), catalog };
			await atomicWriteFile(cachePath, JSON.stringify(cache));
		}
		return true;
	} catch {
		return false;
	} finally {
		clearTimeout(timer);
	}
}

/** 查询选项；catalog 可覆盖内置快照，用于测试或自定义数据源。 */
export interface LookupCatalogOptions extends RefreshCatalogOptions {
	readonly catalog?: ModelCatalog;
	/** 缓存有效期，默认 24 小时。 */
	readonly cacheTtlMs?: number;
}

// 同一缓存路径的并发刷新合并为一次，避免重复下载。
const inFlight = new Map<string, Promise<boolean>>();

function refreshOnce(cachePath: string | undefined, options: LookupCatalogOptions): Promise<boolean> {
	if (cachePath === undefined) return Promise.resolve(false);
	const existing = inFlight.get(cachePath);
	if (existing !== undefined) return existing;
	const task = refreshModelCatalog(options).finally(() => inFlight.delete(cachePath));
	inFlight.set(cachePath, task);
	return task;
}

/**
 * 在目录里查单个模型的元数据。
 *
 * 先按原始 ID 精确匹配；聚合网关（如 OpenRouter、各类 `auto/` 路由）会在模型名前加
 * 供应商前缀，models.dev 只收录裸模型名。精确匹配失败时对带 `/` 的 ID 取最后一段
 * 再查一次，让 `auto/deepseek-v4.1-flash-1017` 命中 `deepseek-v4.1-flash-1017`。
 *
 * @returns 命中的条目，未命中返回 undefined。
 */
function lookupCatalogEntry(catalog: ModelCatalog, id: string): ModelMetadata | undefined {
	const exact = catalog[id];
	if (exact !== undefined) return exact;
	const bare = id.split("/").pop();
	if (bare === undefined || bare === id) return undefined;
	return catalog[bare];
}

/**
 * 按模型 ID 查询元数据。
 *
 * 优先读新鲜磁盘缓存中的值；未命中或缓存过期时退回内置快照，并在后台触发一次
 * 在线刷新（不阻塞本次结果，失败静默）。注入 `catalog` 可完全绕过内置快照与缓存。
 *
 * @returns 命中的元数据，未命中返回 null。
 */
export async function lookupModelMetadata(
	id: string,
	options: LookupCatalogOptions = {},
): Promise<ModelMetadata | null> {
	const now = options.now ?? Date.now;
	const ttl = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
	const base = options.catalog ?? bundledModelCatalog;

	if (options.cachePath !== undefined) {
		const cached = await readCache(options.cachePath, now, ttl);
		if (cached !== undefined) {
			// 缓存新鲜：后台不刷新，直接用缓存值，缺失字段再与快照合并。
			const merged = mergeMetadata(lookupCatalogEntry(base, id), lookupCatalogEntry(cached, id));
			return merged === undefined ? null : merged;
		}
		// 缓存缺失或过期：本次用快照应答，同时后台刷新以供下次查询。
		void refreshOnce(options.cachePath, options);
	}
	return lookupCatalogEntry(base, id) ?? null;
}

import { bundledModelCatalog } from "./snapshot.ts";
