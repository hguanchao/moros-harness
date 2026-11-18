import { splitCommandSegments, tokenizeCommandSegment } from "./command-text.ts";

/**
 * 会话级放行（审批卡 `a`）的作用域：从工具名与参数算出「记住什么」。
 *
 * 粒度是「shell 工具 + 命令前缀」而不是整个工具：批准过一条 `git status` 不应放行之后
 * 所有 PowerShell 命令（可能含 rm/format）。前缀取第一段可执行文件 + 首个参数，既能
 * 免掉同类命令的重复确认，又不会跨命令族扩散。非 shell 工具（write/edit）没有命令文本，
 * 仍按工具名放行。
 *
 * 管线用它做缓存键，审批卡用它做展示短词——两处必须一致，所以放在同一函数里出。
 */

/** shell 类工具名；它们的参数里有可比较的命令文本。 */
export function isShellTool(tool: string): boolean {
	return tool === "bash" || tool === "powershell";
}

export interface ApprovalScope {
	/** 缓存键：shell 工具带小写命令前缀，其余等于工具名。 */
	readonly key: string;
	/** 审批卡展示用短词：保留命令原始大小写，超长按码点截断。 */
	readonly label: string;
}

/**
 * 计算一次调用的会话级放行作用域。
 * @param tool 工具名。
 * @param args 已校验的工具参数。
 * @returns 缓存键与展示短词；命令缺失或为空时退化为工具名。
 */
export function approvalScope(tool: string, args: unknown): ApprovalScope {
	if (!isShellTool(tool)) return { key: tool, label: tool };
	const record = typeof args === "object" && args !== null ? (args as Record<string, unknown>) : {};
	const command = record["command"];
	const prefix = typeof command === "string" ? commandPrefix(command) : "";
	const label = truncate(prefix, 48);
	return label.length === 0 ? { key: tool, label: tool } : { key: `${tool}:${label.toLowerCase()}`, label };
}

/**
 * 取命令的第一段「可执行文件 + 首个参数」。
 *
 * 引号内的空白与分隔符不拆；`cd sub && command` 跳过跳目录段，让作用域落在真正的动作上。
 * 解析只求稳定与保守，不求覆盖全部 shell 语法：拆不出来时退回整条命令的前两个 token。
 */
function commandPrefix(command: string): string {
	for (const segment of splitCommandSegments(command)) {
		const tokens = tokenizeCommandSegment(segment);
		while (tokens[0] === "&" || tokens[0] === ".") tokens.shift();
		const head = tokens[0];
		if (head === undefined) continue;
		// 目录切换不是动作本身，取它后面的那段
		if (head === "cd" || head === "pushd") continue;
		return tokens.slice(0, 2).join(" ");
	}
	return "";
}

function truncate(value: string, limit: number): string {
	const chars = Array.from(value);
	return chars.length <= limit ? value : `${chars.slice(0, limit - 1).join("")}…`;
}
