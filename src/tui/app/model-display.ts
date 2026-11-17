import type { ModelCatalog } from "#src/core/index.ts";

/**
 * 页脚展示的模型标签：优先使用注册表里的 name，未配置时退回模型 id。
 *
 * 页脚只有一行，展示 provider/model 会把名称挤掉；provider 已由模型面板与配置承担，
 * 这里只给出模型本身的识别名。未选择模型时返回固定说明，由调用方原样渲染。
 */
export function selectedModelLabel(
	catalog: ModelCatalog,
	selected: { readonly provider: string; readonly model: string } | undefined,
): string {
	if (selected === undefined) return "no model configured";
	const provider = catalog.providers.find((entry) => entry.name === selected.provider);
	const model = provider?.models.find((entry) => entry.id === selected.model);
	return model?.name ?? selected.model;
}
