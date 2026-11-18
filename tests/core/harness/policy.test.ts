import { describe, expect, it } from "vitest";

import { createPolicy } from "@moros/core/harness/policy.ts";

describe("createPolicy", () => {
	it("只读档拒绝写入与命令，且不启用快照", () => {
		expect(createPolicy("standard")).toMatchObject({
			id: "standard",
			access: { read: "allow", write: "deny", shell: "deny" },
			snapshot: false,
			breakpoint: false,
		});
	});

	it("创造档允许写入，命令仍需审批，并启用快照与断点", () => {
		expect(createPolicy("creator")).toMatchObject({
			id: "creator",
			access: { read: "allow", write: "allow", shell: "approve" },
			snapshot: true,
			breakpoint: true,
		});
	});

	it("计划叠加层只返回只读策略，不改写会话模式", () => {
		expect(createPolicy("creator", true)).toMatchObject({
			id: "plan",
			access: { read: "allow", write: "deny", shell: "deny" },
			snapshot: false,
			breakpoint: false,
		});
	});
});
