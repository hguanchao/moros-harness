import { createMarkdownRenderer } from "../../kit/markdown/entry.ts";
import { THEME } from "./theme.ts";

/**
 * 助手回复的 Markdown 排版。
 *
 * 实现与语法高亮在 `src/tui/kit/markdown`（可选入口，`marked` / `highlight.js` 只在
 * 那里引用）。这里只把本应用的调色板绑进去，渲染器创建一次复用。
 */
const renderer = createMarkdownRenderer(THEME);

export function renderMarkdown(text: string, width: number): readonly string[] {
	return renderer(text, width);
}
