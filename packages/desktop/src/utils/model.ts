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
