import type { Mode } from "./types.ts";

export interface PolicyProfile {
	/** 策略标识：两种模式，或计划模式的只读叠加层 */
	readonly id: Mode | "plan";
	readonly sandboxPathLock: true;
	readonly access: Readonly<Record<"read" | "write" | "shell", "allow" | "approve" | "deny">>;
	readonly snapshot: boolean;
	readonly breakpoint: boolean;
	readonly toolRateLimit: {
		readonly maxConsecutiveFailures: number;
	};
}

const SHARED_POLICY = {
	sandboxPathLock: true,
	toolRateLimit: { maxConsecutiveFailures: 5 },
} as const;

/** 标准模式与创造模式共用执行管线，仅以策略数据表达行为差异。 */
export const POLICY_PROFILES: Readonly<Record<Mode, PolicyProfile>> = {
	standard: {
		...SHARED_POLICY,
		id: "standard",
		access: { read: "allow", write: "deny", shell: "deny" },
		snapshot: false,
		breakpoint: false,
	},
	creator: {
		...SHARED_POLICY,
		id: "creator",
		access: { read: "allow", write: "allow", shell: "approve" },
		snapshot: true,
		breakpoint: true,
	},
};

/** 计划模式叠加层：只读闸门（write/shell 直接拒绝）、不快照、无断点。 */
const PLAN_OVERLAY = {
	...SHARED_POLICY,
	access: { read: "allow", write: "deny", shell: "deny" } as const,
	snapshot: false,
	breakpoint: false,
};

/**
 * 根据模式与计划模式计算有效策略。
 *
 * 审批档位（ask/auto/yolo）不进入策略表：它决定「要不要问」，由管线按命令风险分级
 * 逐次判定，与「能不能做」正交。denylist 也不随档位降级，三档一律硬拦截（见 pipeline.ts）。
 * @param mode 会话模式。
 * @param plan 是否叠加计划模式的只读闸门。
 * @returns 本次工具调用生效的策略档案。
 */
export function createPolicy(mode: Mode, plan = false): PolicyProfile {
	if (plan) return { id: "plan", ...PLAN_OVERLAY };
	return POLICY_PROFILES[mode];
}
