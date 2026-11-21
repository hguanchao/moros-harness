import { describe, expect, it } from "vitest";

import { MAX_SIDEBAR_WIDTH, MIN_CONTENT_WIDTH, MIN_SIDEBAR_WIDTH } from "../src/shared/contract.ts";
import { clampSidebarToViewport } from "../src/utils/layout.ts";

describe("clampSidebarToViewport", () => {
	it("侧栏未超上限时不调整", () => {
		expect(clampSidebarToViewport(280, 1200, true)).toBeUndefined();
	});

	it("窗口收窄导致内容不足保底时收窄侧栏", () => {
		// 860 - 480 = 380，当前 480 需收到 380
		expect(clampSidebarToViewport(MAX_SIDEBAR_WIDTH, 860, true)).toBe(380);
	});

	it("收窄结果不低于侧栏最小宽度", () => {
		// 极端窄视口：视口 - 保底 < 最小值时，仍保证 MIN_SIDEBAR_WIDTH
		const tiny = MIN_SIDEBAR_WIDTH + MIN_CONTENT_WIDTH - 40;
		expect(clampSidebarToViewport(MAX_SIDEBAR_WIDTH, tiny, true)).toBe(MIN_SIDEBAR_WIDTH);
	});

	it("侧栏收起时不参与钳制", () => {
		expect(clampSidebarToViewport(MAX_SIDEBAR_WIDTH, 860, false)).toBeUndefined();
	});

	it("视口宽度无效时不调整", () => {
		expect(clampSidebarToViewport(MAX_SIDEBAR_WIDTH, 0, true)).toBeUndefined();
	});

	it("窗口放大不自动放宽侧栏", () => {
		// 当前 300 远小于 1440 下的上限，保持不动
		expect(clampSidebarToViewport(300, 1440, true)).toBeUndefined();
	});
});
