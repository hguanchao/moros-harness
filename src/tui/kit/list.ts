import { displayWidth, truncateToWidth, type Theme } from "#src/tui/term/index.ts";

/**
 * 列表面板。
 *
 * 上下两条整宽横线、中间若干条目行；条目不折行，超出宽度截断。选中项由 `selected` 或
 * `cursor` 决定，悬停只改底色不改选中——指针停在哪与键盘选中哪是两件事。
 *
 * 「最多显示几行」由调用方给：它取决于终端高度与输入框占位，属应用几何而不是列表自身。
 */

/** 一条列表项。 */
export interface ListItem {
	/** 主名称：命令名、模型名、会话标题 */
	readonly name: string;
	/** 右侧说明；放不下时优先牺牲它 */
	readonly description?: string;
	/** 是否选中；省略时按 `cursor` 判断 */
	readonly selected?: boolean;
	/** 指针是否停在它上面；只影响底色 */
	readonly hovered?: boolean;
	/** 不可用项：灰显，不响应选择 */
	readonly disabled?: boolean;
}

/** 选中行前缀宽度；未选中用等宽空白占位，正文因此对齐。 */
const PREFIX_BLANK = "   ";
const PREFIX_WIDTH = 3;
/** 名称与说明之间留两列。 */
const GAP = "  ";
/** 名称列最宽到这里为止；再长就截断，免得说明被挤得读不了。 */
const NAME_MAX = 14;
/** 名称右侧至少留这么多列给说明，否则说明整段不画。 */
const MIN_DESCRIPTION = 8;
/** 顶边右侧固定的横线数，数量标签不会顶到最右。 */
const TAIL_DASHES = 4;

/** 列表占用的行数：上下横线各一行，中间是可见条目（或一行空态）。 */
export function listHeight(itemCount: number, visible?: number, hasEmpty = false): number {
	if (itemCount === 0) return hasEmpty ? 3 : 2;
	const shown = Math.min(itemCount, Math.max(1, visible ?? itemCount));
	return shown + 2;
}

/**
 * 从容器的 props 里取出条目。
 *
 * 只认 `{ name }` 形状：字符串条目会被当成只有名称的项，其余字段类型不对就忽略——列表是
 * 展示层，不该因为调用方传了半个对象就整体崩掉。
 */
export function listItemsOf(props: Readonly<Record<string, unknown>>): readonly ListItem[] {
	const value = props["items"];
	if (!Array.isArray(value)) return [];
	const items: ListItem[] = [];
	for (const entry of value) {
		if (typeof entry === "string") {
			items.push({ name: entry });
			continue;
		}
		if (typeof entry !== "object" || entry === null) continue;
		const record = entry as Record<string, unknown>;
		const name = record["name"];
		if (typeof name !== "string") continue;
		items.push({
			name,
			...(typeof record["description"] === "string" ? { description: record["description"] } : {}),
			...(record["selected"] === true ? { selected: true } : {}),
			...(record["hovered"] === true ? { hovered: true } : {}),
			...(record["disabled"] === true ? { disabled: true } : {}),
		});
	}
	return items;
}

/**
 * 画一个列表面板。
 *
 * @param node 列表内容与滚动状态
 * @param width 面板总列宽
 * @param theme 取边框、正文、选中与悬停色
 */
export function listLines(
	node: {
		readonly items: readonly ListItem[];
		readonly cursor: number;
		readonly scrollTop?: number | undefined;
		readonly visible?: number | undefined;
		readonly empty?: string | undefined;
		readonly countLabel?: string | undefined;
	},
	width: number,
	theme: Theme,
): readonly string[] {
	const columns = Math.max(0, width);
	const label = node.countLabel ?? countLabelOf(node);
	const rule = topRule(columns, label, theme);
	const bottom = `${theme.border}${"─".repeat(columns)}${theme.reset}`;

	if (node.items.length === 0) {
		const empty = node.empty === undefined ? undefined : emptyLine(node.empty, columns, theme);
		return empty === undefined ? [rule, bottom] : [rule, empty, bottom];
	}

	const visible = Math.min(node.items.length, Math.max(1, node.visible ?? node.items.length));
	const top = keepVisible(node.scrollTop ?? 0, node.cursor, node.items.length, visible);
	const rows: string[] = [];
	for (let offset = 0; offset < visible; offset += 1) {
		const index = top + offset;
		const item = node.items[index];
		if (item === undefined) break;
		rows.push(rowOf(item, index === node.cursor, columns, theme));
	}
	return [rule, ...rows, bottom];
}

/** 默认数量标签：超出可见行时显示「当前位置/总数」，否则只显示总数。 */
function countLabelOf(node: {
	readonly items: readonly ListItem[];
	readonly cursor: number;
	readonly visible?: number | undefined;
}): string {
	const total = node.items.length;
	const visible = node.visible ?? total;
	if (total === 0) return "0";
	return total > visible ? `${Math.min(node.cursor + 1, total)}/${total}` : String(total);
}

/** 顶边：左侧长横线 + 数量标签 + 右侧短横线。 */
function topRule(width: number, label: string, theme: Theme): string {
	const text = ` ${label} `;
	const textWidth = displayWidth(text);
	if (width <= textWidth + 1) return `${theme.border}${"─".repeat(width)}${theme.reset}`;
	const tail = Math.min(TAIL_DASHES, Math.max(0, width - textWidth));
	const left = Math.max(0, width - textWidth - tail);
	return `${theme.border}${"─".repeat(left)}${theme.reset}${theme.textSubtle}${text}${theme.reset}${theme.border}${"─".repeat(tail)}${theme.reset}`;
}

/** 单行条目：前缀、名称、说明，补白到整宽。 */
function rowOf(item: ListItem, cursor: boolean, width: number, theme: Theme): string {
	const selected = item.selected ?? cursor;
	const markerColor = item.disabled ? theme.textDisabled : selected ? theme.accent : theme.textPrimary;
	const nameColor = item.disabled ? theme.textDisabled : selected ? theme.selectedText : theme.textPrimary;
	const descriptionColor = item.disabled ? theme.textDisabled : theme.textSecondary;

	// 名称与说明抢同一行：先保名称，剩余宽度不够说明时整段不画，不留半截省略号
	const description = item.description ?? "";
	const nameRoom = Math.max(0, width - PREFIX_WIDTH - (description.length > 0 ? GAP.length : 0));
	const name = truncateToWidth(item.name, Math.min(NAME_MAX, nameRoom));
	const room = width - PREFIX_WIDTH - displayWidth(name) - (description.length > 0 ? GAP.length : 0);
	const shownDescription = description.length > 0 && room >= MIN_DESCRIPTION ? truncateToWidth(description, room) : "";

	// 标记着色、两侧留白不着色：留白染上颜色会把整行的底色拉成一条
	const marker = selected ? ` ${markerColor}›${theme.reset} ` : PREFIX_BLANK;
	const body = `${nameColor}${name}${theme.reset}${shownDescription.length === 0 ? "" : `${GAP}${descriptionColor}${shownDescription}${theme.reset}`}`;
	const used =
		PREFIX_WIDTH +
		displayWidth(name) +
		(shownDescription.length === 0 ? 0 : GAP.length + displayWidth(shownDescription));
	const line = `${marker}${body}${" ".repeat(Math.max(0, width - used))}`;
	// 悬停底色要盖住整行（含补白），所以套在最后而不是逐段包
	return item.hovered === true ? `${theme.hoverBg}${line}${theme.reset}` : line;
}

/** 空态行：面板保留，说明是「没匹配」而不是列表坏了。 */
function emptyLine(text: string, width: number, theme: Theme): string {
	const body = truncateToWidth(`  ${text}`, Math.max(0, width));
	return `${theme.textSubtle}${body}${theme.reset}${" ".repeat(Math.max(0, width - displayWidth(body)))}`;
}

/** 让光标始终落在可见窗口内。 */
function keepVisible(scrollTop: number, cursor: number, itemCount: number, visible: number): number {
	const shown = Math.min(Math.max(0, itemCount), visible);
	const maxTop = Math.max(0, itemCount - shown);
	const top = Math.min(Math.max(0, scrollTop), maxTop);
	if (cursor < top) return cursor;
	if (cursor >= top + shown) return cursor - shown + 1;
	return top;
}
