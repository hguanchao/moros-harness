import type { ApprovalPrompt } from "#src/tui/app/contract/approval.ts";
import type { ApprovalAnswer } from "#src/tui/app/contract/approval.ts";
import { displayToolName, sanitizeLine } from "#src/tui/app/contract/describe.ts";
import { ACCENT_COLOR, BORDER_COLOR, PANEL_BG, RESET } from "#src/tui/app/panel/menu-panel.ts";
import {
	characterWidth,
	displayWidth,
	fitToWidth,
	graphemes,
	sanitizeForDisplay,
	truncateToWidth,
} from "#src/tui/term/index.ts";
import { THEME } from "#src/tui/app/render/theme.ts";
import { APPROVAL, PANEL, RISK_LABELS, alwaysAllowScope } from "#src/tui/app/copy/index.ts";

/**
 * 工具审批面板。
 *
 * 卡片外壳保持原有样式：居中标题嵌在横线里、全宽下边框、收起固定六行。内容行与动作行的
 * [y] 对齐而不是选中标记 ›，内容与动作之间空一行作间距。工具名独占一行，参数解析成
 * 「字段名 + 值」并缩进展示，不再把工具名和一整段 JSON 挤在一起。更长的命令、diff 与
 * 文件内容按 d 展开成可滚动详情，高度封顶给对话流留最小空间。
 */

/** 收起状态的高度：标题、工具名、参数、空行、动作、下边框。 */
export const APPROVAL_PANEL_BASE_HEIGHT = 6;
/** 展开详情时至少给对话流留出的行数。 */
const APPROVAL_MIN_MAIN_ROWS = 3;

const TITLE = PANEL.permissionRequired;
/** 选中动作前的标记，与用户提示和工具调用保持一致。 */
const ACTION_MARKER = "› ";
/** 未选中的动作用同宽空白占位，移动高亮时文字不左右跳。 */
const ACTION_SLOT = " ".repeat(displayWidth(ACTION_MARKER));
/**
 * 内容行缩进：对齐动作行里的 [y]，而不是选中标记 ›。
 *
 * 动作行先缩进两列，再让标记或同宽占位占两列，[y] 恒从「2 + 标记宽」列开始；内容行取
 * 同一起始列，高亮在动作间左右移动时对齐关系不会变。
 */
const CARD_INDENT = " ".repeat(2 + displayWidth(ACTION_MARKER));
/** 内容行缩进的显示宽度；详情折行宽度按它扣除，避免长内容溢出卡片导致终端折行。 */
const CARD_INDENT_WIDTH = displayWidth(CARD_INDENT);
/** 选中项加粗；之后必须关掉，否则后面的动作也会跟着变粗。 */
const BOLD = "\x1b[1m";
const BOLD_OFF = "\x1b[22m";

/**
 * 展开后的详情行（已按宽度折行）。
 *
 * 第一行是详情标题；后续是完整命令、diff 或文件内容。宽字符按显示列算，代码行在字符边界
 * 折行，续行与首行同缩进，避免把缩进吃掉。
 */
export function approvalPreviewLines(prompt: ApprovalPrompt, width: number): readonly string[] {
	if (prompt.preview === undefined) return [];
	const columns = Math.max(1, width);
	const bodyWidth = Math.max(1, columns - CARD_INDENT_WIDTH);
	const text = sanitizeForDisplay(prompt.preview.replace(/\r\n?/g, "\n").replace(/\t/g, "    "));
	if (text.trim().length === 0) return [];

	const lines: string[] = [`${CARD_INDENT}${fitToWidth(prompt.previewLabel ?? PANEL.details, bodyWidth)}`];
	for (const raw of text.split("\n")) {
		if (raw.length === 0) {
			lines.push("");
			continue;
		}
		if (displayWidth(raw) <= bodyWidth) {
			lines.push(`${CARD_INDENT}${raw}`);
			continue;
		}
		for (const chunk of wrapPreviewLine(raw, bodyWidth)) lines.push(`${CARD_INDENT}${chunk}`);
	}
	return lines;
}

/** 审批卡的高度：展开时最多占终端高度减三行，再长就靠滚动。 */
export function approvalPanelHeight(prompt: ApprovalPrompt, expanded: boolean, width: number, rows: number): number {
	if (!expanded) return APPROVAL_PANEL_BASE_HEIGHT;
	const preview = approvalPreviewLines(prompt, width).length;
	if (preview === 0) return APPROVAL_PANEL_BASE_HEIGHT;

	const maxHeight = Math.max(APPROVAL_PANEL_BASE_HEIGHT, Math.max(1, rows) - APPROVAL_MIN_MAIN_ROWS);
	const capacity = Math.max(0, maxHeight - APPROVAL_PANEL_BASE_HEIGHT);
	return APPROVAL_PANEL_BASE_HEIGHT + Math.min(preview, capacity);
}

/** 详情还能往下滚多少行；输入处理用它收紧滚动位置。 */
export function approvalPreviewScrollLimit(
	prompt: ApprovalPrompt,
	expanded: boolean,
	width: number,
	rows: number,
): number {
	const total = approvalPreviewLines(prompt, width).length;
	const visible = approvalPanelHeight(prompt, expanded, width, rows) - APPROVAL_PANEL_BASE_HEIGHT;
	return Math.max(0, total - visible);
}

export function renderApprovalPanel(
	width: number,
	rows: number,
	prompt: ApprovalPrompt,
	selected: ApprovalAnswer = "once",
	expanded = false,
	scrollTop = 0,
): readonly string[] {
	const columns = Math.max(1, width);
	const height = approvalPanelHeight(prompt, expanded, columns, rows);
	const detail = detailLines(columns, prompt);
	const actions = actionRow(columns, prompt, selected);

	const lines: string[] = [
		titleBorder(columns),
		toolLine(columns, prompt, detail),
		argumentLine(columns, prompt, detail),
	];

	const capacity = height - APPROVAL_PANEL_BASE_HEIGHT;
	if (capacity > 0) {
		const preview = approvalPreviewLines(prompt, columns);
		const top = Math.min(Math.max(0, scrollTop), Math.max(0, preview.length - capacity));
		for (let index = 0; index < capacity; index += 1) {
			lines.push(previewLine(columns, preview[top + index]));
		}
	}

	// 内容与动作行之间空一行作间距；动作必须是倒数第二行：input/approval.ts 用
	// panelHeight - 1 定位鼠标命中
	lines.push(styledContent("", 0, columns));
	lines.push(styledContent(`  ${actions.styled}`, 2 + actions.width, columns));
	lines.push(bottomBorder(columns));
	return lines;
}

/** 标题固定用警告色，居中嵌在横线里；卡片外壳保持既有样式。 */
function titleBorder(width: number): string {
	const label = ` ${TITLE} `;
	const labelWidth = displayWidth(label);
	if (labelWidth >= width) return `${BORDER_COLOR}${"─".repeat(width)}${RESET}`;
	const left = Math.floor((width - labelWidth) / 2);
	const right = width - labelWidth - left;
	return `${BORDER_COLOR}${"─".repeat(left)}${THEME.warning}${label}${BORDER_COLOR}${"─".repeat(right)}${RESET}`;
}

function bottomBorder(width: number): string {
	return `${BORDER_COLOR}${"─".repeat(width)}${RESET}`;
}

/** 已经带样式的行：按纯文本宽度补空格，不能再用 padEnd 量带 ANSI 的字符串。 */
function styledContent(styled: string, plainWidth: number, width: number): string {
	const padding = " ".repeat(Math.max(0, width - plainWidth));
	// 行内着色段自带的 RESET 会把面板底色一并清掉，背景从此断成补丁（真实截图复现）。
	// 每个 RESET 后重新挂上 PANEL_BG，让底色在整行连续；行尾的 RESET 收口。
	const body = styled.replaceAll(RESET, `${RESET}${PANEL_BG}`);
	return `${PANEL_BG}${body}${padding}${RESET}`;
}

interface ApprovalArgument {
	/** JSON 参数里的字段名；解析不出来时省略 */
	readonly key: string | undefined;
	/** 字段值或原始摘要，已压成一行 */
	readonly value: string;
}

interface DetailLines {
	readonly tool: string;
	readonly argument: ApprovalArgument;
}

/**
 * 解析审批参数。
 *
 * summary 常见形状是「工具名 · { "command": "..." }」：先去掉与工具名重复的前缀，
 * 再把剩下的 JSON 拆成字段，界面就能显示 `command  Get-ChildItem ...`，而不是一整段
 * 带花括号和转义引号的 JSON。解析失败时原样展示，不猜格式。
 */
function approvalArgument(prompt: ApprovalPrompt): ApprovalArgument {
	const raw = compact(prompt.summary ?? prompt.detail);
	const duplicate = `${sanitizeLine(prompt.tool).toLowerCase()} · `;
	const body = (raw.toLowerCase().startsWith(duplicate) ? raw.slice(duplicate.length) : raw).trim();
	if (body.startsWith("{") && body.endsWith("}")) {
		try {
			const parsed: unknown = JSON.parse(body);
			if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
				const [key, value] = Object.entries(parsed as Record<string, unknown>)[0] ?? [];
				if (key !== undefined) {
					return {
						key: sanitizeLine(key),
						value: typeof value === "string" ? sanitizeLine(value) : (JSON.stringify(value) ?? String(value)),
					};
				}
			}
		} catch {
			// 不是合法 JSON：按原文展示
		}
	}
	return { key: undefined, value: body.length > 0 ? body : PANEL.noArguments };
}

/**
 * 工具名独占一行，用强调色；风险徽标右对齐在同一行。
 *
 * 徽标只是提示，不参与布局决策：宽度不够（窄终端、长工具名）时整块让位给工具名，
 * 而不是把工具名截断——看不清在批什么比看不到风险等级更糟。
 */
function toolLine(width: number, prompt: ApprovalPrompt, detail: DetailLines): string {
	const text = `${CARD_INDENT}${detail.tool}`;
	const badge = riskBadge(prompt.risk);
	const plain = displayWidth(text);
	if (badge === undefined) return styledContent(`${ACCENT_COLOR}${text}${RESET}`, plain, width);
	const gap = width - plain - displayWidth(badge.text) - CARD_INDENT_WIDTH;
	if (gap < 2) return styledContent(`${ACCENT_COLOR}${text}${RESET}`, plain, width);
	const styled = `${ACCENT_COLOR}${text}${RESET}${" ".repeat(gap)}${badge.color}${badge.text}${RESET}`;
	return styledContent(styled, width - CARD_INDENT_WIDTH, width);
}

/** 风险徽标：high 用错误色、medium 用警告色；low 与未知等级不显示。 */
function riskBadge(risk: string): { readonly text: string; readonly color: string } | undefined {
	const text = RISK_LABELS[risk];
	if (text === undefined) return undefined;
	return { text, color: risk === "high" ? THEME.error : THEME.warning };
}

/**
 * 参数行：字段名弱化、值用正文色，与 [y] 对齐缩进。
 *
 * 值按剩余宽度截断，超长部分靠 d 展开看全文；不让一整段 JSON 溢出卡片导致终端折行。
 */
function argumentLine(width: number, prompt: ApprovalPrompt, detail: DetailLines): string {
	const { key, value } = detail.argument;
	const prefix = `${CARD_INDENT}${key === undefined ? "" : `${key}  `}`;
	const limit = Math.max(1, width - displayWidth(prefix));
	const shown = truncateToWidth(value, limit);
	const styled = `${THEME.textSubtle}${prefix}${RESET}${detailColor(prompt)}${shown}${RESET}`;
	return styledContent(styled, displayWidth(prefix) + displayWidth(shown), width);
}

function detailColor(prompt: ApprovalPrompt): string {
	return prompt.tool === "edit" || prompt.tool === "write" ? THEME.path : THEME.textPrimary;
}

/** 工具展示名与解析后的参数。 */
function detailLines(width: number, prompt: ApprovalPrompt): DetailLines {
	// 工具名来自模型，先清控制字符并截断，避免长名把整行撑出卡片
	const maxTool = Math.max(1, Math.floor(width / 3));
	const tool = fitToWidth(sanitizeLine(displayToolName(prompt.tool)), maxTool);
	return { tool, argument: approvalArgument(prompt) };
}

/** 详情区的单行：diff 的增删用成功/失败色，其余用正文副色。行内容已带 CARD_INDENT 缩进。 */
function previewLine(width: number, line: string | undefined): string {
	if (line === undefined) return styledContent("", 0, width);
	const head = line.trimStart();
	const color = head.startsWith("+ ")
		? THEME.success
		: head.startsWith("- ")
			? THEME.error
			: head.startsWith("@@")
				? THEME.textSubtle
				: THEME.textSecondary;
	return styledContent(`${color}${line}${RESET}`, displayWidth(line), width);
}

/** 代码行按字符边界折行，保留缩进；与按词折行的说明文字不同。 */
function wrapPreviewLine(text: string, width: number): readonly string[] {
	const lines: string[] = [];
	let line = "";
	let used = 0;
	for (const char of graphemes(text)) {
		const charWidth = characterWidth(char);
		if (used + charWidth > width && line.length > 0) {
			lines.push(line);
			line = "";
			used = 0;
		}
		line += char;
		used += charWidth;
	}
	lines.push(line);
	return lines;
}

interface ActionOption {
	readonly action: ApprovalAnswer;
	readonly label: string;
}

interface ActionRow {
	readonly styled: string;
	readonly width: number;
}

/**
 * 动作行。
 *
 * 先按宽度从“带完整范围”到“只有按键”逐级退化，避免窄终端下拒绝键被截掉；再把当前选中
 * 的动作高亮加粗。只有选中项前面显示 ›，未选中项用同宽空白占位。
 */
function actionRow(width: number, prompt: ApprovalPrompt, selected: ApprovalAnswer): ActionRow {
	const options = layoutActions(width, prompt);
	const plain = options.map((option) => option.label).join("   ");
	// 最窄档位里标签不带选中标记，未选中项也不能再占两列槽位，否则拒绝键仍会被挤出屏幕
	const bare = options.every((option) => !option.label.startsWith(ACTION_MARKER));
	const slot = bare ? "" : ACTION_SLOT;
	const styled = options
		.map((option) => {
			if (option.action !== selected) {
				const label = option.label.startsWith(ACTION_MARKER) ? option.label.slice(ACTION_MARKER.length) : option.label;
				return `${slot}${label}`;
			}
			// 拒绝用危险色，其余用强调色：选到拒绝时一眼能看出这是危险动作
			const color = option.action === "deny" ? THEME.error : ACCENT_COLOR;
			return `${BOLD}${color}${option.label}${BOLD_OFF}${THEME.textPrimary}`;
		})
		.join("   ");
	return { styled, width: displayWidth(plain) };
}

/** 动作行里某一列对应的动作；列从 0 起算，用于鼠标命中。 */
export function approvalActionAt(width: number, prompt: ApprovalPrompt, column: number): ApprovalAnswer | undefined {
	const options = layoutActions(Math.max(1, width), prompt);
	const bare = options.every((option) => !option.label.startsWith(ACTION_MARKER));
	let start = bare ? 0 : 2;
	for (const option of options) {
		const end = start + displayWidth(option.label);
		if (column >= start && column < end) return option.action;
		start = end + 3;
	}
	return undefined;
}

/**
 * 「记住」动作的说明：Core 的 allow-session 按「工具 + 命令前缀」（shell）或工具名放行，
 * 句子因此以这个作用域为范围。
 *
 * 范围来自 broker（与 Core 同源的 approvalScope），可能夹带转义序列，
 * 必须先和详情走同一套清洗，否则审批卡本身就能被命令内容改写屏幕。
 */
function alwaysScope(prompt: ApprovalPrompt): string | undefined {
	if (prompt.saveShort === undefined) return undefined;
	const short = sanitizeLine(prompt.saveShort).trim();
	return short.length === 0 ? undefined : short;
}

/** 记住档对全部工具一视同仁：说明本会话内放行的是哪个工具，不承诺只限单个文件。 */
function alwaysText(prompt: ApprovalPrompt): string | undefined {
	const scope = alwaysScope(prompt);
	if (scope === undefined) return undefined;
	return alwaysAllowScope(scope);
}

function layoutActions(width: number, prompt: ApprovalPrompt): readonly ActionOption[] {
	const available = width - 2;
	const once: ActionOption = { action: "once", label: `${ACTION_MARKER}[y] ${APPROVAL.proceed}` };
	const deny: ActionOption = { action: "deny", label: `${ACTION_MARKER}[n] ${APPROVAL.deny}` };
	const rowWidth = (options: readonly ActionOption[]): number =>
		displayWidth(options.map((option) => option.label).join("   "));

	const remember = alwaysText(prompt);
	if (remember === undefined) {
		const full = [once, deny];
		return rowWidth(full) <= available
			? full
			: [
					{ action: "once", label: `${ACTION_MARKER}[y] ${APPROVAL.proceedShort}` },
					{ action: "deny", label: `${ACTION_MARKER}[n] ${APPROVAL.denyShort}` },
				];
	}

	const full = [once, { action: "always" as const, label: `${ACTION_MARKER}[a] ${remember}` }, deny];
	if (rowWidth(full) <= available) return full;

	const compact: readonly ActionOption[] = [
		{ action: "once", label: `${ACTION_MARKER}[y] ${APPROVAL.proceedShort}` },
		{ action: "always" as const, label: `${ACTION_MARKER}[a] ${APPROVAL.alwaysShort}` },
		{ action: "deny", label: `${ACTION_MARKER}[n] ${APPROVAL.denyShort}` },
	];
	if (rowWidth(compact) <= available) return compact;

	const shortest: readonly ActionOption[] = [
		{ action: "once", label: "[y]" },
		{ action: "always", label: "[a]" },
		{ action: "deny", label: "[n]" },
	];
	return shortest;
}

/** 参数是格式化过的 JSON 或命令文本，压成一行才能放进固定高度的面板。 */
function compact(detail: string): string {
	const oneLine = sanitizeLine(detail).replace(/\s+/g, " ").trim();
	return oneLine.length > 0 ? oneLine : PANEL.noArguments;
}
