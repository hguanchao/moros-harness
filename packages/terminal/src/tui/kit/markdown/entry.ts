/**
 * `src/tui/kit/markdown`：需要额外依赖的内容渲染。
 *
 * 单独一个入口：`marked`、`lowlight` 与 `highlight.js` 只有在这里才被引用，核心入口不带
 * 它们。要用 Markdown 或代码高亮的调用方显式引用这个子路径。
 */

export { createMarkdownRenderer } from "./markdown.ts";
export { diffLines } from "./diff.ts";
export type { DiffOptions } from "./diff.ts";
export { highlightCode } from "./syntax.ts";
export type { SyntaxLines, SyntaxSegment, SyntaxToken } from "./syntax.ts";
export { syntaxColor } from "./syntax-style.ts";
