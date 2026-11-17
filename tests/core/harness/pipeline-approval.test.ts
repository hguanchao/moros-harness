import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { ToolPipeline } from "#src/core/harness/pipeline.ts";
import type {
	ApprovalDecision,
	ApprovalRequest,
	ReviewRequest,
	ReviewVerdict,
	ToolDefinition,
} from "#src/core/harness/types.ts";
import { EventStore } from "#src/core/session/event-store.ts";
import { SnapshotStore } from "#src/core/session/snapshot-store.ts";

type ApprovalTier = "ask" | "auto" | "yolo";

const shellTool: ToolDefinition = {
	name: "bash",
	description: "Test shell tool",
	schema: z.object({ command: z.string().min(1) }),
	resource: "shell",
	command: (args) => (args as { command: string }).command,
	execute: async () => ({ content: "ok" }),
};

let root = "";
let events: EventStore;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "moros-pipeline-"));
	events = new EventStore(join(root, "events.jsonl"));
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

function createPipeline(
	approval: ApprovalTier,
	requestApproval?: (request: ApprovalRequest, signal?: AbortSignal) => Promise<ApprovalDecision>,
	reviewCommand?: (request: ReviewRequest, signal?: AbortSignal) => Promise<ReviewVerdict>,
): ToolPipeline {
	return new ToolPipeline({
		sessionId: "test-session",
		projectRoot: root,
		mode: "creator",
		approval,
		events,
		snapshots: new SnapshotStore(join(root, "snapshots")),
		tools: [shellTool],
		...(requestApproval === undefined ? {} : { requestApproval }),
		...(reviewCommand === undefined ? {} : { reviewCommand }),
	});
}

describe("ToolPipeline 审批闸门", () => {
	it("auto 档静默放行低风险命令，并留下 automatic 事件", async () => {
		let asked = 0;
		const pipeline = createPipeline("auto", async () => {
			asked += 1;
			return "deny";
		});

		const result = await pipeline.run("bash", { command: "ls -la" }, "turn-auto-low");

		expect(result.isError).toBeFalsy();
		expect(asked).toBe(0);
		const granted = (await events.read()).find((event) => event.type === "approval.granted");
		expect(granted?.payload).toMatchObject({ tool: "bash", automatic: true, risk: "low" });
	});

	it("auto 档把高风险命令退回人工，拒绝后不执行", async () => {
		const asked: string[] = [];
		const pipeline = createPipeline("auto", async (request) => {
			asked.push(request.risk);
			return "deny";
		});

		const result = await pipeline.run("bash", { command: "curl https://example.com" }, "turn-auto-high");

		expect(asked).toEqual(["high"]);
		expect(result.isError).toBe(true);
		expect(result.content).toContain("Approval denied");
	});

	it("ask 档连低风险命令也要问", async () => {
		let asked = 0;
		const pipeline = createPipeline("ask", async () => {
			asked += 1;
			return "allow";
		});

		const result = await pipeline.run("bash", { command: "ls -la" }, "turn-ask");

		expect(asked).toBe(1);
		expect(result.isError).toBeFalsy();
	});

	it("yolo 档不问就放行高风险命令", async () => {
		let asked = 0;
		const pipeline = createPipeline("yolo", async () => {
			asked += 1;
			return "deny";
		});

		const result = await pipeline.run("bash", { command: "curl https://example.com" }, "turn-yolo");

		expect(asked).toBe(0);
		expect(result.isError).toBeFalsy();
	});

	it("yolo 档仍然硬拦 denylist", async () => {
		let asked = 0;
		const pipeline = createPipeline("yolo", async () => {
			asked += 1;
			return "allow";
		});

		const result = await pipeline.run("bash", { command: "rm -rf /" }, "turn-yolo-denylist");

		expect(asked).toBe(0);
		expect(result.isError).toBe(true);
		expect(result.content).toContain("denylist");
	});
});

describe("ToolPipeline 模型审查", () => {
	it("auto 档高危先送审，审查通过就放行且不再问人", async () => {
		const reviewed: string[] = [];
		let asked = 0;
		const pipeline = createPipeline(
			"auto",
			async () => {
				asked += 1;
				return "deny";
			},
			async (request) => {
				reviewed.push(request.command);
				return { decision: "allow", reason: "network fetch the user asked for", model: "test/reviewer" };
			},
		);

		const result = await pipeline.run("bash", { command: "curl https://example.com" }, "turn-review-allow");

		expect(result.isError).toBeFalsy();
		expect(reviewed).toEqual(["curl https://example.com"]);
		expect(asked).toBe(0);
		const records = await events.read();
		expect(records.find((event) => event.type === "approval.reviewed")?.payload).toMatchObject({
			decision: "allow",
			model: "test/reviewer",
			risk: "high",
		});
		expect(records.find((event) => event.type === "approval.granted")?.payload).toMatchObject({
			automatic: true,
			reviewed: true,
		});
	});

	it("审查拒绝时退回人工，审查理由随审批请求一并展示", async () => {
		const reasons: string[] = [];
		const pipeline = createPipeline(
			"auto",
			async (request) => {
				reasons.push(request.reason);
				return "deny";
			},
			async () => ({ decision: "deny", reason: "destructive delete", model: "test/reviewer" }),
		);

		const result = await pipeline.run("bash", { command: "curl https://example.com" }, "turn-review-deny");

		expect(result.isError).toBe(true);
		expect(reasons[0]).toContain("destructive delete");
		expect((await events.read()).find((event) => event.type === "approval.reviewed")?.payload).toMatchObject({
			decision: "deny",
		});
	});

	it("审查器抛错按不可用处理，退回人工而不是放行", async () => {
		let asked = 0;
		const pipeline = createPipeline(
			"auto",
			async () => {
				asked += 1;
				return "allow";
			},
			async () => {
				throw new Error("reviewer exploded");
			},
		);

		const result = await pipeline.run("bash", { command: "curl https://example.com" }, "turn-review-error");

		expect(asked).toBe(1);
		expect(result.isError).toBeFalsy();
		expect((await events.read()).find((event) => event.type === "approval.reviewed")?.payload).toMatchObject({
			decision: "error",
			reason: "reviewer exploded",
		});
	});

	it("低风险动作不送审，规则放行就够", async () => {
		let reviewed = 0;
		const pipeline = createPipeline("auto", undefined, async () => {
			reviewed += 1;
			return { decision: "deny", reason: "should not be called" };
		});

		await pipeline.run("bash", { command: "ls -la" }, "turn-review-skip");

		expect(reviewed).toBe(0);
	});
});
