import type { WorkspaceTarget } from "../shared/contract.ts";

/** 一条待批量处理的目标：会话 id 与其明确归属。 */
export interface BatchEntry {
	readonly id: string;
	readonly target: WorkspaceTarget;
}

/** 同一归属下的会话分组，供单次 IPC 调用使用。 */
export interface BatchGroup {
	readonly target: WorkspaceTarget;
	readonly ids: string[];
}

/**
 * 将工作区归属转换为稳定的分组键；客户端路径直接取自同一数据源，无需平台规范化。
 * @param target 已明确的工作区归属。
 * @returns `"tasks"` 或 `"project:<root>"`。
 * @example targetKey({ kind: "project", root: "D:/work" }) // "project:D:/work"
 */
export function targetKey(target: WorkspaceTarget): string {
	return target.kind === "tasks" ? "tasks" : `project:${target.root}`;
}

/**
 * 按工作区归属对会话分组；核心层会校验会话归属必须匹配目标，跨根批量必须先分组再调用。
 * @param entries 待处理的会话及其归属。
 * @returns 分组键到会话 id 列表的映射；同一 id 在组内去重，重复出现只保留一次。
 */
export function groupByTarget(entries: readonly BatchEntry[]): ReadonlyMap<string, BatchGroup> {
	const groups = new Map<string, BatchGroup>();
	for (const entry of entries) {
		const key = targetKey(entry.target);
		const group = groups.get(key);
		if (group === undefined) {
			groups.set(key, { target: entry.target, ids: [entry.id] });
		} else if (!group.ids.includes(entry.id)) {
			// 同一会话可能在选择集中重复出现，去重避免重复归档/删除。
			group.ids.push(entry.id);
		}
	}
	return groups;
}
