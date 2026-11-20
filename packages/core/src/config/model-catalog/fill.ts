import type { ReasoningEffort } from "../../llm/types.ts";
import type { ModelInputType } from "../schema.ts";

/** models.dev 可回填到本地模型表单的推理档位（不含 off）。 */
export type ReasoningEffortLevel = Exclude<ReasoningEffort, "off">;

/**
 * 单个模型可从 models.dev 回填的元数据；字段缺省表示数据源未提供。
 * 该类型供浏览器与 Node 两侧共用，请勿引入任何 Node 依赖。
 */
export interface ModelMetadata {
	readonly name?: string;
	/** 上下文窗口 = models.dev `limit.context`。 */
	readonly contextWindow?: number;
	/** 最大生成 Token = models.dev `limit.output`。 */
	readonly maxTokens?: number;
	readonly input?: readonly ModelInputType[];
	readonly reasoningEfforts?: readonly ReasoningEffortLevel[];
}

/** 紧凑查找表：模型 ID → 元数据。 */
export type ModelCatalog = Readonly<Record<string, ModelMetadata>>;

/** 可被元数据回填的表单字段子集；fill 时逐字段比对默认值。 */
export interface MetadataFillable {
	name: string;
	contextWindow: string;
	maxTokens: string;
	input: ModelInputType[];
	reasoningEfforts: ReasoningEffortLevel[];
}

function sameArray(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
	if (a === b) return true;
	if (a === undefined || b === undefined || a.length !== b.length) return false;
	return a.every((value, index) => value === b[index]);
}

/**
 * 把元数据填入表单，仅当字段仍等于默认值（即用户未修改）时才覆盖。
 * 返回新对象，不修改入参。
 */
export function applyModelMetadata<T extends MetadataFillable>(current: T, defaults: T, metadata: ModelMetadata): T {
	const next: T = { ...current };
	if (current.name === defaults.name && metadata.name !== undefined) next.name = metadata.name;
	if (current.contextWindow === defaults.contextWindow && metadata.contextWindow !== undefined) {
		next.contextWindow = String(metadata.contextWindow);
	}
	if (current.maxTokens === defaults.maxTokens && metadata.maxTokens !== undefined) {
		next.maxTokens = String(metadata.maxTokens);
	}
	if (sameArray(current.input, defaults.input) && metadata.input !== undefined) {
		next.input = [...metadata.input] as T["input"];
	}
	if (sameArray(current.reasoningEfforts, defaults.reasoningEfforts) && metadata.reasoningEfforts !== undefined) {
		next.reasoningEfforts = [...metadata.reasoningEfforts] as T["reasoningEfforts"];
	}
	return next;
}
