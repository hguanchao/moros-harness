import { describe, expect, it } from "vitest";

import {
	buildSubagentGroups,
	currentTaskText,
	formatCompletion,
	formatSubagentCounts,
	formatTodoCounts,
	subagentGroupCounts,
	todoCounts,
	todoFinished,
	todoFromArgs,
	type SubagentMember,
	type TodoItem,
} from "../src/utils/task-view.ts";

function item(content: string, status: TodoItem["status"]): TodoItem {
	return { content, status };
}

describe("todoFromArgs 任务卡解析", () => {
	it("解析合法任务列表", () => {
		expect(
			todoFromArgs({
				todos: [
					{ content: "设计", status: "completed" },
					{ content: "实现", status: "in_progress" },
					{ content: "测试", status: "pending" },
				],
			}),
		).toEqual({
			items: [item("设计", "completed"), item("实现", "in_progress"), item("测试", "pending")],
		});
	});

	it("保留非空 explanation，丢弃空白 explanation", () => {
		expect(todoFromArgs({ todos: [], explanation: "计划说明" })?.explanation).toBe("计划说明");
		expect(todoFromArgs({ todos: [], explanation: "  " })?.explanation).toBeUndefined();
	});

	it("空数组是合法的清空结果", () => {
		expect(todoFromArgs({ todos: [] })).toEqual({ items: [] });
	});

	it("超过 5 项默认折叠", () => {
		const todos = Array.from({ length: 6 }, (_, index) => ({ content: `t${index}`, status: "pending" }));
		expect(todoFromArgs({ todos })?.collapsed).toBe(true);
	});

	it("形状不合法时返回 undefined（全有或全无）", () => {
		expect(todoFromArgs({})).toBeUndefined();
		expect(todoFromArgs({ todos: "not-array" })).toBeUndefined();
		expect(todoFromArgs({ todos: [{ content: "", status: "pending" }] })).toBeUndefined();
		expect(todoFromArgs({ todos: [{ content: "x", status: "unknown" }] })).toBeUndefined();
		expect(todoFromArgs({ todos: [null] })).toBeUndefined();
		expect(todoFromArgs({ todos: [], explanation: 42 })).toBeUndefined();
	});
});

describe("todoFinished 收尾判定", () => {
	it("空表不是已收尾", () => {
		expect(todoFinished([])).toBe(false);
	});

	it("全部完成或失败为已收尾", () => {
		expect(todoFinished([item("a", "completed"), item("b", "failed")])).toBe(true);
	});

	it("存在 pending 或 in_progress 时未收尾", () => {
		expect(todoFinished([item("a", "completed"), item("b", "pending")])).toBe(false);
		expect(todoFinished([item("a", "in_progress")])).toBe(false);
	});
});

describe("任务计数与文案", () => {
	it("todoCounts 统计各状态", () => {
		expect(
			todoCounts([
				item("a", "in_progress"),
				item("b", "completed"),
				item("c", "completed"),
				item("d", "failed"),
				item("e", "pending"),
			]),
		).toEqual({ running: 1, done: 2, failed: 1, pending: 1 });
	});

	it("formatCompletion 输出 X/Y", () => {
		expect(formatCompletion([item("a", "completed"), item("b", "pending")])).toBe("1/2");
	});

	it("formatTodoCounts 省略为 0 的段", () => {
		expect(formatTodoCounts({ running: 1, done: 2, failed: 0, pending: 3 })).toBe("进行中 1 · 已完成 2 · 待办 3");
	});

	it("currentTaskText 取进行中任务", () => {
		expect(currentTaskText([item("a", "completed"), item("b", "in_progress")])).toBe("b");
		expect(currentTaskText([item("a", "completed")])).toBeUndefined();
	});
});

describe("buildSubagentGroups 子代理分组", () => {
	const member = (callId: string, status: SubagentMember["status"], tokens?: number): SubagentMember => ({
		callId,
		task: `task-${callId}`,
		status,
		...(tokens === undefined ? {} : { totalTokens: tokens }),
	});

	it("连续子代理合并成一组", () => {
		const groups = buildSubagentGroups([member("a", "done", 10), member("b", "running")]);
		expect(groups).toHaveLength(1);
		expect(groups[0]?.members.map((m) => m.callId)).toEqual(["a", "b"]);
	});

	it("null 分隔符切断分组", () => {
		const groups = buildSubagentGroups([member("a", "done"), null, member("b", "done")]);
		expect(groups).toHaveLength(2);
		expect(groups[0]?.members).toHaveLength(1);
		expect(groups[1]?.members).toHaveLength(1);
	});

	it("只有全部结束时才累计 token 合计", () => {
		const done = buildSubagentGroups([member("a", "done", 10), member("b", "done", 20)]);
		expect(done[0]?.totalTokens).toBe(30);
		const running = buildSubagentGroups([member("a", "done", 10), member("b", "running", 20)]);
		expect(running[0]?.totalTokens).toBeUndefined();
	});

	it("空序列与全 null 不产生分组", () => {
		expect(buildSubagentGroups([])).toEqual([]);
		expect(buildSubagentGroups([null, null])).toEqual([]);
	});
});

describe("subagentGroupCounts 组头计数", () => {
	it("按状态累加", () => {
		const group = {
			members: [
				{ callId: "a", task: "a", status: "running" as const },
				{ callId: "b", task: "b", status: "done" as const },
				{ callId: "c", task: "c", status: "done" as const },
				{ callId: "d", task: "d", status: "failed" as const },
			],
		};
		expect(subagentGroupCounts(group)).toEqual({ running: 1, done: 2, failed: 1 });
		expect(formatSubagentCounts(subagentGroupCounts(group))).toBe("运行中 1 · 已完成 2 · 失败 1");
	});
});
