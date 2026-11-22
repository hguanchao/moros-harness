/**
 * 工具调用的展示文案：把内部工具名映射为面向用户的中文动词短语。
 *
 * 参考 opencode / Codex 的做法——单工具用「动词短语」而非裸工具名，
 * 工具组用「动词 + 计数」聚合。所有映射集中在此，避免散落在渲染代码里。
 * 未知工具原样显示，保证新增工具不会因缺映射而丢失信息。
 */

/** 工具名 -> 中文动词（单工具行、组头计数共用）。 */
const TOOL_VERBS: Readonly<Record<string, string>> = {
	read: "读取",
	write: "写入",
	edit: "编辑",
	glob: "查找文件",
	grep: "搜索内容",
	bash: "运行命令",
	powershell: "运行命令",
	task: "委派子任务",
	web_fetch: "获取网页",
	present_plan: "提交计划",
	todo: "更新待办",
};

/**
 * 探索类工具：与 Codex 的 is_exploring_cell / opencode 的 search 归类一致，
 * 这些工具连续出现时组头用「探索」而非「调用」。
 */
const EXPLORE_TOOLS = new Set(["read", "glob", "grep"]);
const EDIT_TOOLS = new Set(["write", "edit"]);

/** 单个工具的中文动词；未映射的工具返回原名。 */
export function toolVerb(name: string): string {
	return TOOL_VERBS[name] ?? name;
}

/** 探索类工具判定，用于工具组文案聚合。 */
export function isExploreTool(name: string): boolean {
	return EXPLORE_TOOLS.has(name);
}

/** 编辑类工具判定，用于工具组文案聚合。 */
export function isEditTool(name: string): boolean {
	return EDIT_TOOLS.has(name);
}

/** 工具组明细：各工具的计数，键为中文动词。 */
export interface ToolCount {
	readonly verb: string;
	readonly count: number;
}

/**
 * 按中文动词聚合工具计数，保持首次出现顺序。
 * 例：[read, read, grep, bash] -> [{verb:"读取",count:2},{verb:"搜索内容",count:1},{verb:"运行命令",count:1}]
 */
export function countTools(names: readonly string[]): readonly ToolCount[] {
	const counts = new Map<string, number>();
	for (const name of names) {
		const verb = toolVerb(name);
		counts.set(verb, (counts.get(verb) ?? 0) + 1);
	}
	return [...counts].map(([verb, count]) => ({ verb, count }));
}

/**
 * 生成工具组标题（中文 verb + 计数），参考 opencode 的 activity-label。
 *
 * - 运行中：以「正在」开头
 * - 全部为探索类：「探索了 N 处」
 * - 全部为编辑类：「编辑了 N 处」
 * - 混合：取动词 + 计数，用「、」连接，如「读取 2、搜索内容 1、运行命令 1」
 */
export function describeToolGroup(names: readonly string[], running: boolean): string {
	if (names.length === 0) return running ? "正在准备工作" : "已准备工作";

	const allExplore = names.every(isExploreTool);
	if (allExplore) return running ? `正在探索 ${names.length} 处` : `探索了 ${names.length} 处`;
	const allEdit = names.every(isEditTool);
	if (allEdit) return running ? `正在编辑 ${names.length} 处` : `编辑了 ${names.length} 处`;

	const counts = countTools(names)
		.map(({ verb, count }) => `${verb} ${count}`)
		.join("、");
	return running ? `正在 ${counts}` : `${counts}`;
}
