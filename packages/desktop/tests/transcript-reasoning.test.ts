import { describe, expect, it } from "vitest";

import type { EventRecord } from "@moros/core/events/schema.ts";
import type { LiveState } from "../src/shared/contract.ts";
import { buildTimeline } from "../src/components/Transcript.tsx";

const emptyLive: LiveState = {
	running: false,
	paused: false,
	text: "",
	reasoning: "",
	toolOutputs: {},
};

function response(reasoning: string | undefined, text = ""): EventRecord {
	return {
		seq: 2,
		ts: "2026-11-21T16:10:12.248Z",
		corr: "test",
		type: "llm.response",
		payload: {
			text,
			toolCalls: [],
			usage: { inputTokens: 0, outputTokens: 0 },
			stopReason: "done",
			...(reasoning === undefined ? {} : { reasoning }),
		},
	};
}

describe("buildTimeline 推理块净化", () => {
	it("纯空白 reasoning（单个空格）不生成推理块", () => {
		const turns = buildTimeline([response(" ")], emptyLive, {});
		const assistant = turns.flatMap((turn) => turn.blocks).find((block) => block.kind === "assistant");
		expect(assistant).toBeUndefined();
	});

	it("含换行/制表符的 reasoning 同样视为空白", () => {
		const turns = buildTimeline([response("\n\t ")], emptyLive, {});
		expect(turns.flatMap((turn) => turn.blocks).some((block) => block.kind === "assistant")).toBe(false);
	});

	it("有实质内容的 reasoning 正常保留", () => {
		const turns = buildTimeline([response("先看一下项目结构")], emptyLive, {});
		const assistant = turns.flatMap((turn) => turn.blocks).find((block) => block.kind === "assistant");
		expect(assistant).toMatchObject({ kind: "assistant", reasoning: "先看一下项目结构" });
	});

	it("纯空白 reasoning 但正文非空时，正文块仍保留且不带 reasoning", () => {
		const turns = buildTimeline([response(" ", "完成")], emptyLive, {});
		const assistant = turns.flatMap((turn) => turn.blocks).find((block) => block.kind === "assistant");
		expect(assistant).toMatchObject({ kind: "assistant", text: "完成" });
		expect(assistant).not.toHaveProperty("reasoning");
	});

	it("live 状态纯空白 reasoning 不单独生成回合", () => {
		const live: LiveState = { ...emptyLive, reasoning: " " };
		expect(buildTimeline([], live, {})).toHaveLength(0);
	});
});

describe("buildTimeline 回合并时长", () => {
	function userInput(ts: string): EventRecord {
		return { seq: 1, ts, type: "user.input", payload: { text: "任务" } };
	}

	it("用首末事件时间戳计算回合时长", () => {
		const events: EventRecord[] = [
			userInput("2026-11-21T16:10:00.000Z"),
			{ ...response(undefined, "完成"), seq: 2, ts: "2026-11-21T16:11:59.000Z" },
		];
		const turns = buildTimeline(events, emptyLive, {});
		expect(turns[0]?.durationMs).toBe(119_000);
	});

	it("单事件回合时长为 0", () => {
		const turns = buildTimeline([userInput("2026-11-21T16:10:00.000Z")], emptyLive, {});
		expect(turns[0]?.durationMs).toBe(0);
	});
});

describe("buildTimeline 错误块始终可见", () => {
	function userInput(ts: string): EventRecord {
		return { seq: 1, ts, type: "user.input", payload: { text: "任务" } };
	}

	it("error 事件生成 error 色调的 notice 块", () => {
		const events: EventRecord[] = [
			userInput("2026-11-21T16:10:00.000Z"),
			{
				seq: 2,
				ts: "2026-11-21T16:10:01.000Z",
				type: "error",
				payload: { kind: "llm", message: "请求失败", recoverable: true },
			},
			{ ...response(undefined, "完成"), seq: 3, ts: "2026-11-21T16:10:02.000Z" },
		];
		const blocks = buildTimeline(events, emptyLive, {}).flatMap((turn) => turn.blocks);
		expect(blocks).toContainEqual({ kind: "notice", tone: "error", text: "请求失败" });
	});

	it("limit.blocked 事件生成 error 色调的 notice 块", () => {
		const events: EventRecord[] = [
			userInput("2026-11-21T16:10:00.000Z"),
			{
				seq: 2,
				ts: "2026-11-21T16:10:01.000Z",
				type: "limit.blocked",
				payload: { message: "命令被拦截" },
			},
		];
		const blocks = buildTimeline(events, emptyLive, {}).flatMap((turn) => turn.blocks);
		expect(blocks).toContainEqual({ kind: "notice", tone: "error", text: "命令被拦截" });
	});
});

describe("buildTimeline 模型切换分隔线", () => {
	function userInput(seq: number, ts: string): EventRecord {
		return { seq, ts, type: "user.input", payload: { text: "任务" } };
	}
	function modelChanged(seq: number, ts: string, from: string, to: string, appliesNextTurn: boolean): EventRecord {
		return {
			seq,
			ts,
			type: "model.changed",
			payload: { from, to, fromModel: `p/${from}`, toModel: `p/${to}`, appliesNextTurn },
		};
	}

	it("空闲切换立即显示分隔线，连续切换只保留最后一条", () => {
		const events: EventRecord[] = [
			userInput(1, "2026-11-21T16:10:00.000Z"),
			modelChanged(2, "2026-11-21T16:10:01.000Z", "A", "B", false),
			modelChanged(3, "2026-11-21T16:10:02.000Z", "B", "C", false),
		];
		const blocks = buildTimeline(events, emptyLive, {}).flatMap((turn) => turn.blocks);
		const dividers = blocks.filter((block) => block.kind === "divider");
		expect(dividers).toHaveLength(1);
		expect(dividers[0]).toMatchObject({ kind: "divider", text: "模型已从 B 更改为 C" });
	});

	it("运行中切换延后到下一轮发送后显示", () => {
		const events: EventRecord[] = [
			userInput(1, "2026-11-21T16:10:00.000Z"),
			modelChanged(2, "2026-11-21T16:10:01.000Z", "A", "B", true),
			userInput(3, "2026-11-21T16:11:00.000Z"),
		];
		const turns = buildTimeline(events, emptyLive, {});
		// 第一轮没有分隔线，第二轮开头才出现。
		expect(turns[0]?.blocks.some((block) => block.kind === "divider")).toBe(false);
		expect(turns[1]?.blocks[0]).toMatchObject({ kind: "divider", text: "模型已从 A 更改为 B" });
	});

	it("运行中连续切换只显示最后一条，且延后到下一轮", () => {
		const events: EventRecord[] = [
			userInput(1, "2026-11-21T16:10:00.000Z"),
			modelChanged(2, "2026-11-21T16:10:01.000Z", "A", "B", true),
			modelChanged(3, "2026-11-21T16:10:02.000Z", "B", "C", true),
			userInput(4, "2026-11-21T16:11:00.000Z"),
		];
		const turns = buildTimeline(events, emptyLive, {});
		const dividers = turns.flatMap((turn) => turn.blocks).filter((block) => block.kind === "divider");
		expect(dividers).toHaveLength(1);
		expect(dividers[0]).toMatchObject({ kind: "divider", text: "模型已从 B 更改为 C" });
		expect(turns[1]?.blocks[0]).toMatchObject({ kind: "divider" });
	});

	it("运行中切换但尚无下一轮时不显示分隔线", () => {
		const events: EventRecord[] = [
			userInput(1, "2026-11-21T16:10:00.000Z"),
			modelChanged(2, "2026-11-21T16:10:01.000Z", "A", "B", true),
		];
		const blocks = buildTimeline(events, emptyLive, {}).flatMap((turn) => turn.blocks);
		expect(blocks.some((block) => block.kind === "divider")).toBe(false);
	});
});

describe("buildTimeline 任务列表与子代理", () => {
	function todoCall(seq: number, todos: readonly { content: string; status: string }[]): EventRecord {
		return {
			seq,
			ts: "2026-11-21T16:10:00.000Z",
			type: "tool.call",
			payload: { tool: "todo", args: { todos }, toolCallId: `todo-${seq}` },
		};
	}

	function subagentStarted(seq: number, callId: string, task: string): EventRecord {
		return {
			seq,
			ts: "2026-11-21T16:10:00.000Z",
			type: "subagent.started",
			payload: { toolCallId: callId, task },
		};
	}

	function subagentFinished(seq: number, callId: string): EventRecord {
		return {
			seq,
			ts: "2026-11-21T16:10:05.000Z",
			type: "subagent.finished",
			payload: {
				toolCallId: callId,
				steps: 3,
				totalTokens: 1200,
				durationMs: 5000,
				ok: true,
				paused: false,
				preview: "done",
			},
		};
	}

	it("todo 工具调用生成 TodoBlock", () => {
		const events = [
			todoCall(1, [
				{ content: "设计", status: "completed" },
				{ content: "实现", status: "in_progress" },
			]),
		];
		const blocks = buildTimeline(events, emptyLive, {}).flatMap((turn) => turn.blocks);
		const todo = blocks.find((block) => block.kind === "todo");
		expect(todo).toMatchObject({ kind: "todo", finished: false, seq: 1 });
		expect(todo).not.toHaveProperty("result");
	});

	it("todo 全部完成标记为 finished", () => {
		const events = [todoCall(1, [{ content: "实现", status: "completed" }])];
		const blocks = buildTimeline(events, emptyLive, {}).flatMap((turn) => turn.blocks);
		expect(blocks.find((block) => block.kind === "todo")).toMatchObject({ kind: "todo", finished: true });
	});

	it("todo 工具结果不产生普通工具行", () => {
		const events: EventRecord[] = [
			todoCall(1, [{ content: "实现", status: "in_progress" }]),
			{
				seq: 2,
				ts: "2026-11-21T16:10:01.000Z",
				type: "tool.result",
				payload: { tool: "todo", result: "Task list updated (1 tasks).", isError: false, toolCallId: "todo-1" },
			},
		];
		const blocks = buildTimeline(events, emptyLive, {}).flatMap((turn) => turn.blocks);
		expect(blocks.some((block) => block.kind === "tool")).toBe(false);
		expect(blocks.filter((block) => block.kind === "todo")).toHaveLength(1);
	});

	it("形状不合法的 todo 回退为普通工具行", () => {
		const events: EventRecord[] = [
			{
				seq: 1,
				ts: "2026-11-21T16:10:00.000Z",
				type: "tool.call",
				payload: { tool: "todo", args: { todos: "bad" }, toolCallId: "todo-bad" },
			},
		];
		const blocks = buildTimeline(events, emptyLive, {}).flatMap((turn) => turn.blocks);
		expect(blocks.find((block) => block.kind === "tool")).toMatchObject({ name: "todo" });
	});

	it("subagent 事件在工具块上挂 subagent 元数据", () => {
		const events = [subagentStarted(1, "call-a", "调查登录逻辑"), subagentFinished(2, "call-a")];
		const blocks = buildTimeline(events, emptyLive, {}).flatMap((turn) => turn.blocks);
		const tool = blocks.find((block) => block.kind === "tool");
		expect(tool).toMatchObject({ kind: "tool", name: "task" });
		expect((tool as { subagent?: unknown }).subagent).toMatchObject({
			task: "调查登录逻辑",
			status: "done",
			steps: 3,
			totalTokens: 1200,
		});
	});
});
