import { describe, expect, it } from "vitest";

import type { ApprovalPrompt } from "#src/tui/app/contract/approval.ts";
import { renderApprovalPanel } from "#src/tui/app/panel/approval-panel.ts";

function prompt(risk: string): ApprovalPrompt {
	return { tool: "bash", risk, detail: 'bash · { "command": "curl https://example.com" }' };
}

describe("renderApprovalPanel 风险徽标", () => {
	it("high 风险在工具名同行标出 HIGH RISK", () => {
		const lines = renderApprovalPanel(80, 24, prompt("high"));
		expect(lines.some((line) => line.includes("HIGH RISK"))).toBe(true);
	});

	it("medium 风险标出 MEDIUM RISK，low 不显示徽标", () => {
		expect(renderApprovalPanel(80, 24, prompt("medium")).some((line) => line.includes("MEDIUM RISK"))).toBe(true);
		expect(renderApprovalPanel(80, 24, prompt("low")).some((line) => line.includes("RISK"))).toBe(false);
	});

	it("窄终端放不下徽标时让位给工具名，而不是截断工具名", () => {
		const lines = renderApprovalPanel(18, 24, prompt("high"));
		expect(lines.some((line) => line.includes("HIGH RISK"))).toBe(false);
		expect(lines.some((line) => line.toLowerCase().includes("bash"))).toBe(true);
	});
});
