import type { ProvidersFile } from "./schema.ts";

/** 模型引用的解析结果；provider 缺省时由调用方补上会话当前供应商。 */
export interface ModelRef {
	readonly provider?: string;
	readonly model: string;
}

/**
 * 解析 `provider/modelId` 或 `modelId` 两种写法。
 *
 * 只有斜杠前的片段确实是注册表里的供应商时，才把前缀当供应商；否则整串视为模型 id——
 * 模型 id 本身常带斜杠（`meta-llama/llama-3-70b`），一刀切会把它们拆坏。
 * @param value config.toml 里的原始取值。
 * @param providers 已加载的供应商注册表。
 * @returns 拆出的供应商（可能缺省）与模型 id。
 */
export function parseModelRef(value: string, providers: ProvidersFile): ModelRef {
	const trimmed = value.trim();
	const slash = trimmed.indexOf("/");
	// 前缀为空、后缀为空都不算「供应商/模型」，退回整串当模型 id
	if (slash > 0 && slash < trimmed.length - 1) {
		const candidate = trimmed.slice(0, slash);
		if (providers.providers[candidate] !== undefined) {
			return { provider: candidate, model: trimmed.slice(slash + 1) };
		}
	}
	return { model: trimmed };
}
