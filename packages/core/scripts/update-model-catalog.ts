/**
 * 从 models.dev 生成本地模型元数据快照。
 *
 * 用法：pnpm --filter @moros/core update-model-catalog
 * 输出：src/config/model-catalog/snapshot.ts
 */
import { writeFile } from "node:fs/promises";

import { parseCatalog } from "../src/config/model-catalog/metadata.ts";

const SOURCE_URL = "https://models.dev/api.json";
const OUTPUT = new URL("../src/config/model-catalog/snapshot.ts", import.meta.url);

async function main(): Promise<void> {
	const response = await fetch(SOURCE_URL);
	if (!response.ok) throw new Error(`下载 models.dev 目录失败：HTTP ${response.status}`);
	const payload: unknown = await response.json();
	const catalog = parseCatalog(payload);
	const count = Object.keys(catalog).length;
	if (count === 0) throw new Error("models.dev 目录解析结果为空");

	const body = [
		"/**",
		" * models.dev 模型元数据快照，由 `pnpm --filter @moros/core update-model-catalog` 生成。",
		" * 请勿手动编辑；更新数据源后重新运行脚本。",
		" */",
		'import type { ModelCatalog } from "./metadata.ts";',
		"",
		`export const bundledModelCatalog: ModelCatalog = ${JSON.stringify(catalog, null, "\t")};`,
		"",
	].join("\n");
	await writeFile(OUTPUT, body, "utf8");
	console.log(`已生成快照：${count} 个模型 → ${OUTPUT.pathname}`);
}

await main();
