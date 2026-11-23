/**
 * 行内补全纯函数：从光标回扫 trigger（/ @ $）片段、过滤候选、写回格式化。
 *
 * 移植自终端 TUI（menu-panel.ts / file-menu.ts / skill-menu.ts / panels.ts），
 * 只处理普通 JS 值，零 TUI/主题依赖，便于桌面端单测。
 */

/** 光标所在的 trigger 片段。 */
export interface TriggerToken {
	readonly start: number;
	readonly end: number;
	/** 触发符到光标之间的已输入内容。 */
	readonly query: string;
	/** `/` 命令后可选的说明文字（命令名之后的非空白内容）；其他 trigger 不填。 */
	readonly args?: string;
}

/**
 * 从光标处回扫触发符圈出的补全片段。
 *
 * 只有 trigger 位于行首或空白之后才命中（`name@example.com`、`${x}` 不触发）。
 * 光标可停在片段中间；`end` 按 endOfToken 向后扩展，供整段替换。
 */
export function findTriggerToken(
	text: string,
	cursor: number,
	trigger: string,
	endOfToken: (char: string) => boolean,
	validateQuery?: (query: string) => boolean,
): TriggerToken | undefined {
	const position = Math.min(Math.max(0, cursor), text.length);
	if (position === 0) return undefined;

	let start = position - 1;
	while (start > 0 && !/\s/.test(text[start - 1] ?? "")) start -= 1;
	if (text[start] !== trigger) return undefined;

	const query = text.slice(start + 1, position);
	if (validateQuery !== undefined && !validateQuery(query)) return undefined;

	let end = position;
	while (end < text.length && endOfToken(text[end] ?? "")) end += 1;
	return { start, end, query };
}

/** `@` 片段：任意非空白字符算内容，遇空白终止。 */
export function findAtToken(text: string, cursor: number): TriggerToken | undefined {
	return findTriggerToken(text, cursor, "@", (char) => !/\s/.test(char));
}

/** `$` 片段：只吃技能名安全字符，避免把标点/`${}` 当技能名。 */
export function findSkillToken(text: string, cursor: number): TriggerToken | undefined {
	return findTriggerToken(
		text,
		cursor,
		"$",
		(char) => /[A-Za-z0-9_-]/.test(char),
		(query) => /^[A-Za-z0-9_-]*$/.test(query),
	);
}

/**
 * `/` 命令片段：`/` + 命令名，其后可跟可选说明（如 `/review 审查 API 代码`）。
 * 命令名只吃字母；命令名后的内容作为 args（review 用它限定审查范围）。
 * token 覆盖整行内命令名与说明（end 到行尾），选中命令时整段替换成 chip。
 * 纯 "/" 或 "/ " 仍显示命令列表；无命令名且尾部空白多于一个空格时视为普通文本。
 */
export function findSlashToken(text: string, cursor: number): TriggerToken | undefined {
	const position = Math.min(Math.max(0, cursor), text.length);
	if (position === 0) return undefined;
	// 命令与说明不跨行：只看光标所在行。
	const lineStart = text.lastIndexOf("\n", position - 1) + 1;
	const lineBreak = text.indexOf("\n", position);
	const lineEnd = lineBreak < 0 ? text.length : lineBreak;
	const line = text.slice(lineStart, lineEnd);
	const match = /(?:^|\s)\/([A-Za-z]*)(?:\s+([\s\S]*))?$/.exec(line);
	if (match === null) return undefined;
	const slashOffset = match[0].startsWith("/") ? 0 : 1;
	const start = lineStart + (match.index ?? 0) + slashOffset;
	// 光标必须在斜杠之后，否则只是普通文本（例如光标在命令前）。
	if (start >= position) return undefined;
	const nameEnd = lineStart + (match.index ?? 0) + slashOffset + 1 + (match[1] ?? "").length;
	// query 取光标前的命令名部分；光标已在说明里时用完整命令名过滤。
	const query = line.slice(start - lineStart + 1, Math.min(position - lineStart, nameEnd - lineStart));
	const args = (match[2] ?? "").trim();
	// 没有命令名时只容忍一个尾随空格（用户敲 "/" 后手滑），再多就是普通文本。
	if (query.length === 0 && text.slice(start + 1, position).length > 1) return undefined;
	// end 收拢到行尾，但不吃尾随空白，避免选中命令时把段末空格一起吞掉。
	let end = lineEnd;
	while (end > position && /\s/.test(text[end - 1] ?? "")) end -= 1;
	return { start, end, query, args };
}

const FILE_LIMIT = 200;
const SKILL_LIMIT = 100;

/**
 * 过滤文件清单：文件名前缀 > 路径前缀 > 文件名包含 > 路径包含，
 * 同档按命中位置、路径长度、字典序排。输入为 `/` 分隔的相对路径。
 */
export function filterFiles(files: readonly string[], query: string, limit = FILE_LIMIT): readonly string[] {
	const needle = query.toLowerCase();
	if (needle.length === 0) return files.slice(0, limit);

	const scored: { path: string; score: number; index: number; length: number }[] = [];
	for (const path of files) {
		const lower = path.toLowerCase();
		const index = lower.indexOf(needle);
		if (index < 0) continue;
		const slash = lower.lastIndexOf("/");
		const name = slash < 0 ? lower : lower.slice(slash + 1);
		const score = name.startsWith(needle) ? 0 : lower.startsWith(needle) ? 1 : name.includes(needle) ? 2 : 3;
		scored.push({ path, score, index, length: path.length });
	}
	scored.sort(
		(left, right) =>
			left.score - right.score ||
			left.index - right.index ||
			left.length - right.length ||
			left.path.localeCompare(right.path),
	);
	return scored.slice(0, limit).map((entry) => entry.path);
}

/** 技能候选的最小结构（SkillSummary 兼容）。 */
export interface SkillCandidate {
	readonly name: string;
	readonly description: string;
}

/** 过滤技能：名称前缀 > 名称包含 > 描述包含，同档保持原序。 */
export function filterSkills<T extends SkillCandidate>(
	skills: readonly T[],
	query: string,
	limit = SKILL_LIMIT,
): readonly T[] {
	const needle = query.toLowerCase();
	if (needle.length === 0) return skills.slice(0, limit);

	const scored: { skill: T; score: number }[] = [];
	for (const skill of skills) {
		const name = skill.name.toLowerCase();
		const description = skill.description.toLowerCase();
		const score = name.startsWith(needle) ? 0 : name.includes(needle) ? 1 : description.includes(needle) ? 2 : -1;
		if (score >= 0) scored.push({ skill, score });
	}
	scored.sort((left, right) => left.score - right.score);
	return scored.slice(0, limit).map((entry) => entry.skill);
}

/** MCP 连接器候选的最小结构。 */
export interface ConnectorCandidate {
	readonly name: string;
	readonly description: string;
}

/** 过滤 MCP 连接器：名称前缀 > 名称包含 > 描述包含，同档保持原序。 */
export function filterConnectors<T extends ConnectorCandidate>(connectors: readonly T[], query: string): readonly T[] {
	const needle = query.toLowerCase();
	if (needle.length === 0) return connectors;

	const scored: { connector: T; score: number }[] = [];
	for (const connector of connectors) {
		const name = connector.name.toLowerCase();
		const score = name.startsWith(needle)
			? 0
			: name.includes(needle)
				? 1
				: connector.description.toLowerCase().includes(needle)
					? 2
					: -1;
		if (score >= 0) scored.push({ connector, score });
	}
	scored.sort((left, right) => left.score - right.score);
	return scored.map((entry) => entry.connector);
}

/** 命令候选的最小结构。 */
export interface CommandCandidate {
	readonly name: string;
	readonly description: string;
	readonly hidden?: boolean;
}

/**
 * 过滤命令：命令名前缀命中优先；前缀为空才用描述命中；
 * hidden 命令仅在完整输入命令名时可见。
 */
export function filterCommands<T extends CommandCandidate>(commands: readonly T[], query: string): readonly T[] {
	const needle = query.toLowerCase();
	const visible = (command: T): boolean => command.hidden !== true || command.name.toLowerCase() === needle;
	const prefixMatches = commands.filter((command) => visible(command) && command.name.toLowerCase().startsWith(needle));
	if (prefixMatches.length > 0) return prefixMatches;
	return commands.filter(
		(command) =>
			visible(command) &&
			!command.name.toLowerCase().startsWith(needle) &&
			command.description.toLowerCase().includes(needle),
	);
}

/** `@` 引用写回：含空格的路径加引号。 */
export function formatFileReference(path: string): string {
	return /\s/.test(path) ? `@"${path}"` : `@${path}`;
}

/** `$` 技能写回。 */
export function formatSkillReference(name: string): string {
	return `$${name}`;
}

/** 从输入文本中移除 trigger 片段（含触发符），返回新文本与新光标位置。 */
export function removeTriggerText(text: string, token: TriggerToken): { text: string; cursor: number } {
	return { text: text.slice(0, token.start) + text.slice(token.end), cursor: token.start };
}
