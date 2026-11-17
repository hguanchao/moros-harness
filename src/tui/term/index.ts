/**
 * `src/tui/term`：终端底座。
 *
 * 只含四类能力——转义序列、文本度量与折行、整帧屏幕写入、输入解码——以及主题的类型契约。
 * 这里不出现布局、组件、焦点管理与任何业务概念；配色取值由应用注入。
 *
 * 应用只允许从这个入口引用，不得相对引用 `src/` 内部文件。
 */

export * from "#src/tui/term/ansi.ts";
export * from "#src/tui/term/color.ts";
export * from "#src/tui/term/keys.ts";
export * from "#src/tui/term/output.ts";
export * from "#src/tui/term/screen.ts";
export * from "#src/tui/term/text.ts";
export * from "#src/tui/term/theme.ts";
