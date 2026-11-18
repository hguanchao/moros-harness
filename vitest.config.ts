import { defineConfig } from "vitest/config";

/**
 * 全仓测试配置；测试目录镜像 packages 的分层结构。
 *
 * 不配 alias：跨包导入走 pnpm workspace 包名（@moros/core 等），由 pnpm 软链解析；包内与
 * 测试用相对路径。vitest（vite 解析器）与 node 运行时共用同一套解析规则，避免两处等价配置漂移。
 */
export default defineConfig({
	test: {
		environment: "node",
		include: ["tests/**/*.test.ts"],
		testTimeout: 30_000,
	},
});
