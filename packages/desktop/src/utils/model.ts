import type { SettingsSnapshot } from "@moros/core/config/settings.ts";
import type { ModelCatalog } from "@moros/core/core.ts";
import type { SessionView } from "../shared/contract.ts";

/**
 * 校验模型引用是否仍存在于当前目录，兼容裸 id 与 provider/id 两种历史格式。
 *
 * 会话保存的模型可能在配置变更后被移除；此时按“未选择”处理，避免界面显示
 * 一个已不存在的幽灵模型。草稿的默认模型同样经过此校验。
 *
 * @param catalog 当前工作区的模型目录。
 * @param model 待校验的模型引用，可为空。
 * @returns 目录中确实存在的模型引用；不存在时返回 undefined。
 * @example availableModel(catalog, { provider: "moxuna", model: "deepseek-flash" })
 */
export function availableModel(
	catalog: ModelCatalog,
	model: SessionView["model"] | undefined,
): SessionView["model"] | undefined {
	if (model === undefined) return undefined;
	const provider = catalog.providers.find((item) => item.name === model.provider);
	if (provider === undefined) return undefined;
	const exists = provider.models.some(
		(entry) => entry.id === model.model || `${provider.name}/${entry.id}` === model.model,
	);
	return exists ? { provider: provider.name, model: model.model } : undefined;
}

/**
 * 从设置与目录中解析当前配置的默认模型；配置或目录中不存在时返回 undefined。
 *
 * @param catalog 当前工作区的模型目录。
 * @param settings 应用设置快照，含 provider 与 model 配置。
 * @returns 目录中确实存在且与配置匹配的模型引用。
 */
export function configuredModel(
	catalog: ModelCatalog,
	settings: SettingsSnapshot | undefined,
): SessionView["model"] | undefined {
	const configured = settings?.config.model;
	if (configured === undefined) return undefined;
	for (const provider of catalog.providers) {
		if (settings?.config.provider !== undefined && settings.config.provider !== provider.name) continue;
		const model = provider.models.find(
			(entry) => entry.id === configured || `${provider.name}/${entry.id}` === configured,
		);
		if (model !== undefined) return { provider: provider.name, model: model.id };
	}
	return undefined;
}

/** 档位按推理强度从弱到强排序；钳位时按此序度量距离。 */
const EFFORT_ORDER: readonly SessionView["effort"][] = ["off", "minimal", "low", "medium", "high", "max"];

/**
 * 把推理强度钳到模型支持的最近档位；模型不存在或原档位已受支持时原样返回。
 *
 * 切换模型后原生效档位可能不被新模型支持（如 Max 遇到只支持 Low~High 的模型），
 * 界面会出现一个菜单里选不到的档位。按强度序取距离最近的支持档：Max→High、
 * Off→最低档；距离相同时取更弱的档位（倾向省 token）。
 *
 * @param catalog 当前工作区的模型目录。
 * @param model 目标模型引用。
 * @param effort 切换前的生效档位。
 * @returns 目标模型支持的档位。
 * @example clampEffortToModel(catalog, { provider: "m", model: "no-reasoning" }, "max") // "off"
 */
export function clampEffortToModel(
	catalog: ModelCatalog,
	model: SessionView["model"],
	effort: SessionView["effort"],
): SessionView["effort"] {
	if (model === undefined) return effort;
	const provider = catalog.providers.find((item) => item.name === model.provider);
	const entry = provider?.models.find((item) => item.id === model.model);
	if (entry === undefined) return effort;
	const configured = entry.reasoningEfforts;
	// 与推理强度菜单同一口径，判断顺序固定：显式关闭（reasoning=false）→ Off；
	// 未配置档位（旧版 reasoning=true 的配置）→ 任意档可用；档位为空数组 → Off。
	const supported: readonly SessionView["effort"][] =
		entry.reasoning === false
			? ["off"]
			: configured === undefined
				? EFFORT_ORDER
				: configured.length === 0
					? ["off"]
					: configured;
	if (supported.includes(effort)) return effort;
	const currentIndex = EFFORT_ORDER.indexOf(effort);
	let best: SessionView["effort"] = effort;
	let bestDistance = Number.POSITIVE_INFINITY;
	let bestIndex = Number.POSITIVE_INFINITY;
	for (const candidate of supported) {
		const candidateIndex = EFFORT_ORDER.indexOf(candidate);
		const distance = Math.abs(candidateIndex - currentIndex);
		// 距离相同取更弱档位
		if (distance < bestDistance || (distance === bestDistance && candidateIndex < bestIndex)) {
			best = candidate;
			bestDistance = distance;
			bestIndex = candidateIndex;
		}
	}
	return best;
}
