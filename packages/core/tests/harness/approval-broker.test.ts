import { describe, expect, it } from "vitest";

import { createApprovalBroker } from "@moros/core/harness/approval-broker.ts";
import type { ApprovalRequest } from "@moros/core/harness/types.ts";

function request(id: string): ApprovalRequest {
	return {
		id,
		tool: "bash",
		args: { command: "ls" },
		reason: "low risk",
		risk: "low",
	};
}

describe("ApprovalBroker.allowSession", () => {
	it("只放行指定会话的挂起审批，其它会话保持挂起", async () => {
		const broker = createApprovalBroker({ timeoutMs: 0 });
		const a = broker.request(request("a"), undefined, "session-a");
		const b = broker.request(request("b"), undefined, "session-b");

		broker.allowSession("session-a");

		await expect(a).resolves.toBe("allow");
		expect(broker.pendingAll()).toHaveLength(1);
		expect(broker.current()?.id).toBe("b");

		broker.allowSession("session-b");
		await expect(b).resolves.toBe("allow");
		expect(broker.pendingAll()).toHaveLength(0);
	});

	it("对没有挂起审批的会话调用是空操作", () => {
		const broker = createApprovalBroker({ timeoutMs: 0 });
		expect(() => broker.allowSession("no-such-session")).not.toThrow();
		expect(broker.pendingAll()).toHaveLength(0);
	});
});
