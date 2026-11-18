import { describe, expect, it } from "vitest";

import type { EventRecord } from "@moros/core/events/schema.ts";
import { buildTrace } from "../src/main/trace.ts";

function event(seq: number, type: EventRecord["type"], payload: unknown, ts?: string): EventRecord {
	return {
		seq,
		ts: ts ?? `2026-11-18T10:00:${String(seq).padStart(2, "0")}.000Z`,
		type,
		payload,
	} as unknown as EventRecord;
}

describe("buildTrace", () => {
	it("按回合聚合模型、工具、审批、文件与子代理步骤", () => {
		const events: EventRecord[] = [
			event(1, "user.input", { text: "检查一下项目" }),
			event(2, "llm.request", { endpoint: "chat-completions", model: "mock-model", messageCount: 2 }),
			event(3, "tool.call", { tool: "bash", args: { command: "ls" }, toolCallId: "tool-1" }),
			event(4, "approval.requested", {
				id: "approval-1",
				tool: "bash",
				args: { command: "ls" },
				reason: "requires approval",
				risk: "high",
			}),
			event(5, "approval.granted", {
				id: "approval-1",
				tool: "bash",
				risk: "high",
				decisionMs: 25,
			}),
			event(6, "tool.result", {
				tool: "bash",
				result: "README.md",
				isError: false,
				toolCallId: "tool-1",
				elapsedMs: 12,
			}),
			event(7, "llm.response", {
				text: "看完了",
				toolCalls: [],
				usage: { inputTokens: 10, outputTokens: 2 },
				stopReason: "end_turn",
			}),
			event(8, "file.changed", {
				path: "notes\\hello.txt",
				op: "create",
				before: null,
				after: "snapshot",
				snapshotId: "snapshot-1",
			}),
			event(9, "rollback.done", { scope: "step", files: ["notes\\hello.txt"] }),
			event(10, "subagent.started", { toolCallId: "task-1", task: "整理摘要" }),
			event(11, "subagent.finished", {
				toolCallId: "task-1",
				steps: 3,
				totalTokens: 120,
				durationMs: 800,
				ok: true,
				paused: false,
				preview: "摘要完成",
			}),
			event(12, "error", { kind: "llm", message: "临时错误", recoverable: true }),
		];

		const turns = buildTrace(events);
		expect(turns).toHaveLength(1);
		const turn = turns[0];
		expect(turn?.prompt).toBe("检查一下项目");
		const steps = turn?.steps ?? [];

		const llm = steps.find((step) => step.kind === "llm" && step.title.includes("mock-model"));
		expect(llm?.status).toBe("ok");
		expect(llm?.durationMs).toBe(5_000);

		const tool = steps.find((step) => step.kind === "tool");
		expect(tool?.status).toBe("ok");
		expect(tool?.durationMs).toBe(12);

		const approval = steps.find((step) => step.kind === "approval" && step.title.includes("bash"));
		expect(approval?.status).toBe("ok");
		expect(approval?.durationMs).toBe(25);

		const file = steps.find((step) => step.kind === "file" && step.title.startsWith("create"));
		expect(file?.title).toContain("notes/hello.txt");
		const rollback = steps.find((step) => step.kind === "file" && step.title.startsWith("Rollback"));
		expect(rollback?.result).toBe("notes/hello.txt");

		const subagent = steps.find((step) => step.kind === "subagent");
		expect(subagent?.status).toBe("ok");
		expect(subagent?.result).toContain("3 steps");

		const error = steps.find((step) => step.kind === "error");
		expect(error?.status).toBe("error");
		expect(error?.result).toBe("临时错误");
	});

	it("第二个 user.input 开启新回合，且工具按 toolCallId 归位", () => {
		const events: EventRecord[] = [
			event(1, "user.input", { text: "第一轮" }),
			event(2, "tool.call", { tool: "read", args: { path: "a.txt" }, toolCallId: "call-a" }),
			event(3, "tool.result", {
				tool: "read",
				result: "alpha",
				isError: false,
				toolCallId: "call-a",
				elapsedMs: 3,
			}),
			event(4, "user.input", { text: "第二轮" }),
			event(5, "tool.call", { tool: "read", args: { path: "b.txt" }, toolCallId: "call-b" }),
		];

		const turns = buildTrace(events);
		expect(turns.map((turn) => turn.prompt)).toEqual(["第一轮", "第二轮"]);
		expect(turns[0]?.steps[0]?.status).toBe("ok");
		expect(turns[1]?.steps[0]?.status).toBe("running");
	});

	it("空会话没有轨迹", () => {
		expect(buildTrace([])).toEqual([]);
	});
});
