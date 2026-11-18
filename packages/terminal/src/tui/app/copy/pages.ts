/**
 * 整屏页文案与分节内容
 *
 * 界面文案按用途拆分，`copy.ts` 是唯一的对外入口；这里只放本段自己的词与句。
 */

// ── 整屏页 ────────────────────────────────────────────────────────────────

/** 帮助页、技能页、MCP 页与信任页的标题与说明。 */
export const PAGE = {
	helpTitle: "Moros Harness · help",
	skillsTitle: "Moros Harness · skills",
	mcpsTitle: "Moros Harness · MCP servers",
	trustTitle: "Moros Harness · workspace trust",
	planTitle: "Moros Harness · plan",
	viewerTitlePrefix: "Moros Harness · ",
	commandsSection: "Commands",
	keysSection: "Keys",
	serversSection: "Servers",
	skillsSection: "Skills",
	userSkillsSection: "User skills",
	projectSkillsSection: "Project skills",
	helpFootnote: "Run moros --help outside the interface for command-line options.",
	noSkills: "No skills yet.",
	skillsEffectNote: "Changes take effect on the next turn.",
	noMcpServers: "No MCP servers configured.",
	mcpConfigNote:
		"Configure [mcp_servers.<name>] in ~/.moros/config.toml. MCP tools require approval and run outside the workspace sandbox.",
	trustIntro: "This workspace ships files that change how Moros Harness behaves.",
	trustNote: "Trusting applies these files to the prompt; commands still run under the sandbox and approval rules.",
	trustSkipNote: "Not trusting keeps the default: nothing from this workspace is loaded.",
	trustFilesSection: "Files Moros Harness may read",
	trustSkillsSection: "Skill folders Moros Harness may load",
} as const;

/** 技能页脚注：扫描过哪些目录。 */
export function scanningDirectory(directory: string): string {
	return `Scanning ${directory}`;
}

/** 信任页的三个选项：记住、仅本次、不信任。 */
export const TRUST_LABELS = {
	full: [
		{ answer: "trust", label: "[y] Trust this workspace" },
		{ answer: "session", label: "[s] Trust for this session" },
		{ answer: "skip", label: "[n] Do not trust" },
	] as const,
	short: [
		{ answer: "trust", label: "[y] Trust" },
		{ answer: "session", label: "[s] Session" },
		{ answer: "skip", label: "[n] Skip" },
	] as const,
	minimal: [
		{ answer: "trust", label: "[y]" },
		{ answer: "session", label: "[s]" },
		{ answer: "skip", label: "[n]" },
	] as const,
} as const;

/** 帮助页的键位清单：键位在前、动作在后，一律用 `·` 分隔；一条只说一件事。 */
interface KeyHintCopy {
	readonly keys: string;
	readonly description: string;
}

export const KEY_HINTS: readonly KeyHintCopy[] = [
	{ keys: "Enter", description: "Send the prompt · queue it while a turn runs" },
	{ keys: "Shift+Enter", description: "Insert a newline without sending" },
	{ keys: "Tab", description: "Complete the selected item into the prompt" },
	{ keys: "Approval badge", description: "ASK / AUTO / YOLO shows the active approval mode for this session" },
	{ keys: "Shift+Tab", description: "Cycle the approval mode (ask → auto → yolo) for this session" },
	{ keys: "Esc", description: "Close a menu or this page, or deny an approval" },
	{ keys: "Esc", description: "Interrupt the turn · send the first queued message" },
	{ keys: "Esc twice", description: "Clear the input" },
	{ keys: "Ctrl+Z", description: "Undo the last input change · brings back a cleared draft" },
	{ keys: "Ctrl+C twice", description: "Exit the interface · a draft is cleared first" },
	{ keys: "Ctrl+P", description: "Pause or resume the running session" },
	{ keys: "Ctrl+R", description: "Roll back the previous step" },
	{ keys: "Ctrl+L", description: "Open the session list" },
	{ keys: "Ctrl+N", description: "Create and switch to a new session" },
	{ keys: "Ctrl+D twice", description: "Delete the current session" },
	{ keys: "Up / Down", description: "Prompt cursor or history, menu navigation, or page scrolling" },
	{ keys: "Left / Right", description: "Move the prompt cursor or approval selection" },
	{ keys: "Home / End", description: "Move to the start or end of the input line" },
	{ keys: "Alt+Up", description: "Take the last queued message back into the prompt" },
	{ keys: "Alt+Down", description: "Discard the last queued message" },
	{ keys: "PgUp / PgDn", description: "Scroll the conversation or this page" },
	{ keys: "Ctrl+E", description: "Expand or collapse the latest thinking or tool group" },
	{ keys: "Ctrl+G", description: "View the selected tool full-screen, or the latest long block" },
	{
		keys: "Ctrl+V",
		description: "Paste the clipboard: text inserts like a paste, an image becomes an [image: name] marker",
	},
	{ keys: "Wheel / drag", description: "Scroll the conversation · drag the scrollbar or select text to copy" },
	{ keys: "Double-click", description: "Expand or collapse thinking, tool groups, or a pasted marker" },
	{ keys: "y / a / n", description: "Answer an approval: proceed once, always allow, or deny" },
	{ keys: "d", description: "Expand or hide approval details · arrow keys scroll them" },
	{ keys: "@", description: "Complete a workspace file path; an image becomes an inline marker" },
];

/** 整屏页底部动作条的标签：动作在前，说明它做什么，不写整句。 */
export const ACTIONS = {
	select: "select",
	reconnect: "reconnect",
	healthCheck: "health check",
	close: "close",
	scroll: "scroll",
	page: "page",
	approve: "approve & implement",
	revise: "request changes",
	leave: "leave plan",
	approveShort: "approve",
	reviseShort: "revise",
	leaveShort: "leave",
	back: "back",
} as const;
