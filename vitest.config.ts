import { defineConfig } from "vitest/config";

/**
 * 全仓测试配置；测试目录镜像 src 的分层结构。
 *
 * 不配 alias：`#src/*`、`#tests/*` 由 package.json 的 imports 字段解析，vitest（vite 解析器）与
 * node 运行时共用同一套映射——两处等价配置迟早漂移，而漂移时测试通过、真实运行报错最难查。
 */
export default defineConfig({
	test: {
		environment: "node",
		include: ["tests/**/*.test.ts"],
		testTimeout: 30_000,
	},
});
