import { MAX_SIDEBAR_WIDTH, MIN_CONTENT_WIDTH, MIN_SIDEBAR_WIDTH } from "../shared/contract.ts";

/**
 * 窗口收窄时把侧栏宽度钳制到能为内容区保底的范围。
 *
 * 侧栏展开时，内容区可用宽度 = 视口宽度 - 侧栏宽度，需不低于 MIN_CONTENT_WIDTH。
 * 因此侧栏上限 = 视口宽度 - MIN_CONTENT_WIDTH，再与拖拽范围取交集。
 * 窗口放大时不主动放宽侧栏（返回 undefined），避免覆盖用户手动设定的宽度。
 *
 * @param sidebarWidth 当前侧栏宽度（px）。
 * @param viewportWidth 当前窗口内容区宽度（px）。
 * @param sidebarOpen 侧栏是否展开；收起时宽度为 0，无需钳制。
 * @returns 需要收窄到的新宽度；无需调整时返回 undefined。
 * @example clampSidebarToViewport(480, 860, true) // 380（860 - 480 保底，收到上限）
 */
export function clampSidebarToViewport(
	sidebarWidth: number,
	viewportWidth: number,
	sidebarOpen: boolean,
): number | undefined {
	if (!sidebarOpen || viewportWidth <= 0) return undefined;
	const maxAllowed = Math.min(MAX_SIDEBAR_WIDTH, viewportWidth - MIN_CONTENT_WIDTH);
	const upper = Math.max(MIN_SIDEBAR_WIDTH, maxAllowed);
	if (sidebarWidth <= upper) return undefined;
	return Math.max(MIN_SIDEBAR_WIDTH, Math.min(upper, sidebarWidth));
}
