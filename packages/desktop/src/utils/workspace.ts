import type { ProjectRef, WorkspaceTarget } from "../shared/contract.ts";

/**
 * 比较主进程已校验的目录标识，用于侧栏归组和高亮。
 * @param left 第一个真实目录路径。
 * @param right 第二个真实目录路径。
 * @param platform 主进程平台；Windows 比较忽略大小写。
 * @returns 两个展示标识是否指向同一根路径。
 * @example workspaceRootsMatch("C:\\Work", "c:/work/", "win32")
 * @remarks 只规范化展示标识，不解析符号链接，也不能用于文件权限或输入校验。
 */
export function workspaceRootsMatch(left: string, right: string, platform: NodeJS.Platform): boolean {
	return rootKey(left, platform) === rootKey(right, platform);
}

/**
 * 将草稿的可选项目关联转换为明确的执行目标，不沿用当前打开的项目。
 * @param project 用户为草稿选择的项目；null 表示未关联。
 * @returns 供主进程校验并准备的任务或项目目标。
 * @example workspaceTarget(null) // { kind: "tasks" }
 */
export function workspaceTarget(project: ProjectRef | null): WorkspaceTarget {
	return project === null ? { kind: "tasks" } : { kind: "project", root: project.root };
}

/**
 * 比较明确的工作区归属；任务根由主进程管理，不比较客户端路径。
 * @param left 已准备的工作区目标。
 * @param right 草稿希望使用的工作区目标。
 * @param platform 主进程平台。
 * @returns 两个归属是否一致。
 */
export function workspaceTargetsMatch(
	left: WorkspaceTarget,
	right: WorkspaceTarget,
	platform: NodeJS.Platform,
): boolean {
	if (left.kind !== right.kind) return false;
	if (left.kind === "tasks" || right.kind === "tasks") return true;
	return workspaceRootsMatch(left.root, right.root, platform);
}

function rootKey(root: string, platform: NodeJS.Platform): string {
	const normalized = root.replaceAll("\\", "/").replace(/\/+$/, "") || "/";
	return platform === "win32" ? normalized.toLowerCase() : normalized;
}
