/**
 * 界面文案的唯一出处。
 *
 * 只放「会显示给人看的词与句」：状态行、对话流标记、面板与整页文字。排版（颜色、宽度、
 * 折行）留在各自模块，这里只负责措辞，改一处即可全文一致。
 *
 * 组合句一律走各段里的构造函数：调用方只传变量，不自己拼词，避免同一件事出现两种说法。
 *
 * 612 行按用途拆到 `copy/` 下，这里只做 re-export：45 个调用方仍按 `copy.js` 引用，
 * 不需要知道文案分了几段。
 */

export * from "#src/tui/app/copy/status.ts";
export * from "#src/tui/app/copy/errors.ts";
export * from "#src/tui/app/copy/attachments.ts";
export * from "#src/tui/app/copy/transcript.ts";
export * from "#src/tui/app/copy/panels.ts";
export * from "#src/tui/app/copy/pages.ts";
export * from "#src/tui/app/copy/commands.ts";
export * from "#src/tui/app/copy/notify.ts";
