import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { ToolPipeline } from "@moros/core/harness/pipeline.ts";
import type {
	ApprovalDecision,
	ApprovalRequest,
	ReviewRequest,
	ReviewVerdict,
	ToolDefinition,
} from "@moros/core/harness/types.ts";
import { EventStore } from "@moros/core/session/event-store.ts";
import { SnapshotStore } from "@moros/core/session/snapshot-store.ts";

const mcpTool: ToolDefinition = {
	name: "mcp__fixture__write",
	description: "[MCP fixture] write something",
	schema: z.record(z.string(), z.unknown()),
	parameters: { type: "object", properties: { text: { type: "string" } } },
	resource: "shell",
	risk: { level: "high", rule: "mcp-tool" },
	execute: async () => ({ content: "ok" }),
};

let root = "";
let events: EventStore;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "moros-mcp-pipeline-"));
	events = new EventStore(join(root, "events.jsonl"));
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

function createPipeline(options: {
	approval: "ask" | "auto" | "yolo";
	plan?: boolean;
	requestApproval?: (request: ApprovalRequest, signal?: AbortSignal) => Promise<ApprovalDecision>;
	reviewCommand?: (request: ReviewRequest, signal?: AbortSignal) => Promise<ReviewVerdict>;
}): ToolPipeline {
	return new ToolPipeline({
		sessionId: "test-session",
		projectRoot: root,
		mode: "creator",
		approval: options.approval,
		events,
		snapshots: new SnapshotStore(join(root, "snapshots")),
		tools: [mcpTool],
		...(options.plan === true ? { plan: true } : {}),
		...(options.requestApproval ? { requestApproval: options.requestApproval } : {}),
		...(options.reviewCommand ? { reviewCommand: options.reviewCommand } : {}),
	});
}

describe("MCP 工具经过统一管控管线", () => {
	it("ask 档弹出审批，风险固定为 high", async () => {
		const risks: string[] = [];
		const pipeline = createPipeline({
			approval: "ask",
			requestApproval: async (request) => {
				risks.push(request.risk);
				return "allow";
			},
		});

		const result = await pipeline.run(mcpTool.name, { text: "hi" }, "turn-mcp-ask");

		expect(result.isError).toBeFalsy();
		expect(risks).toEqual(["high"]);
		const granted = (await events.read()).find((event) => event.type === "approval.granted");
		expect(granted?.payload).toMatchObject({ tool: mcpTool.name, risk: "high" });
	});

	it("计划模式直接拒绝，不问人也不执行", async () => {
		let asked = 0;
		const pipeline = createPipeline({
			approval: "ask",
			plan: true,
			requestApproval: async () => {
				asked += 1;
				return "allow";
			},
		});

		const result = await pipeline.run(mcpTool.name, { text: "hi" }, "turn-mcp-plan");

		expect(asked).toBe(0);
		expect(result.isError).toBe(true);
		expect(result.content).toContain("not allowed");
	});

	it("auto 档把 MCP 调用送审查，并把参数交给审查者", async () => {
		const reviewed: ReviewRequest[] = [];
		let asked = 0;
		const pipeline = createPipeline({
			approval: "auto",
			requestApproval: async () => {
				asked += 1;
				return "deny";
			},
			reviewCommand: async (request) => {
				reviewed.push(request);
				return { decision: "allow", reason: "fixture write is safe" };
			},
		});

		const result = await pipeline.run(mcpTool.name, { text: "hi" }, "turn-mcp-auto");

		expect(result.isError).toBeFalsy();
		expect(asked).toBe(0);
		expect(reviewed[0]).toMatchObject({
			tool: mcpTool.name,
			command: "",
			risk: { level: "high", rule: "mcp-tool" },
			args: { text: "hi" },
		});
	});
});
