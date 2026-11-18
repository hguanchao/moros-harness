import { resolve } from "node:path";

import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";

/**
 * 桌面端构建配置。
 *
 * CLI/TUI 仍由 Node 直接运行 TS，不经过这里；桌面端必须把 main/preload/renderer
 * 分别打包。main 与 preload 强制 CJS：preload 在 sandbox 下不能加载 ESM，
 * 统一输出 `.cjs` 可以让窗口配置保持 `sandbox: true`。
 */
export default defineConfig({
	main: {
		plugins: [externalizeDepsPlugin()],
		build: {
			rollupOptions: {
				input: { index: resolve(__dirname, "src/desktop/main/index.ts") },
				output: { format: "cjs", entryFileNames: "[name].cjs" },
			},
		},
	},
	preload: {
		plugins: [externalizeDepsPlugin()],
		build: {
			rollupOptions: {
				input: { index: resolve(__dirname, "src/desktop/preload/index.ts") },
				output: { format: "cjs", entryFileNames: "[name].cjs" },
			},
		},
	},
	renderer: {
		root: resolve(__dirname, "src/desktop/renderer"),
		base: "./",
		plugins: [react()],
		build: {
			rollupOptions: {
				input: { index: resolve(__dirname, "src/desktop/renderer/index.html") },
			},
		},
	},
});
