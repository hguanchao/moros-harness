import { describe, expect, it } from "vitest";

import { resolveToolDetail, shouldCollapseTrail, shouldKeepIntermediateReply } from "../src/utils/work-steps.ts";

describe("工作步骤展示详细度", () => {
	it("minimal 只显示工具名与状态，不展开详情", () => {
		expect(resolveToolDetail("minimal")).toEqual({
			showSummary: false,
			defaultOpenDetail: false,
			showRawEvent: false,
		});
	});

	it("standard 显示摘要但详情默认收起", () => {
		expect(resolveToolDetail("standard")).toEqual({
			showSummary: true,
			defaultOpenDetail: false,
			showRawEvent: false,
		});
	});

	it("detailed 详情默认展开", () => {
		expect(resolveToolDetail("detailed")).toEqual({
			showSummary: true,
			defaultOpenDetail: true,
			showRawEvent: false,
		});
	});

	it("full 额外显示原始事件标识", () => {
		expect(resolveToolDetail("full")).toEqual({
			showSummary: true,
			defaultOpenDetail: true,
			showRawEvent: true,
		});
	});
});

describe("工作步骤自动收起时机", () => {
	const scenarios = [
		{ isActive: true, hasRunningTool: false, label: "活跃回合" },
		{ isActive: false, hasRunningTool: false, label: "已完成回合" },
		{ isActive: true, hasRunningTool: true, label: "工具执行中" },
	] as const;

	it("never 任何场景都不收起", () => {
		for (const ctx of scenarios) {
			expect(shouldCollapseTrail("never", ctx)).toBe(false);
		}
	});

	it("afterAnswer 仅在回合离开活跃态后收起（默认行为）", () => {
		expect(shouldCollapseTrail("afterAnswer", { isActive: true, hasRunningTool: false })).toBe(false);
		expect(shouldCollapseTrail("afterAnswer", { isActive: false, hasRunningTool: false })).toBe(true);
	});

	it("immediately 与 afterToolCall 在无在飞工具时收起", () => {
		expect(shouldCollapseTrail("immediately", { isActive: true, hasRunningTool: false })).toBe(true);
		expect(shouldCollapseTrail("afterToolCall", { isActive: false, hasRunningTool: false })).toBe(true);
	});

	it("immediately 与 afterToolCall 在工具执行中保持平铺，不隐藏进行中的步骤", () => {
		expect(shouldCollapseTrail("immediately", { isActive: true, hasRunningTool: true })).toBe(false);
		expect(shouldCollapseTrail("afterToolCall", { isActive: true, hasRunningTool: true })).toBe(false);
	});
});

describe("收起后显示的回复", () => {
	it("all 保留全部中间回复", () => {
		expect(shouldKeepIntermediateReply("all", { isLast: false })).toBe(true);
		expect(shouldKeepIntermediateReply("all", { isLast: true })).toBe(true);
	});

	it("last 仅保留最后一条中间回复", () => {
		expect(shouldKeepIntermediateReply("last", { isLast: false })).toBe(false);
		expect(shouldKeepIntermediateReply("last", { isLast: true })).toBe(true);
	});

	it("key 当前等同 last，避免启发式误判", () => {
		expect(shouldKeepIntermediateReply("key", { isLast: false })).toBe(false);
		expect(shouldKeepIntermediateReply("key", { isLast: true })).toBe(true);
	});

	it("none 不保留任何中间回复", () => {
		expect(shouldKeepIntermediateReply("none", { isLast: false })).toBe(false);
		expect(shouldKeepIntermediateReply("none", { isLast: true })).toBe(false);
	});
});
