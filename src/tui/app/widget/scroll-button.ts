import { displayWidth } from "#src/tui/term/index.ts";
import { buttonText, overlayHit, placeBottomCenter, type OverlayPlacement } from "#src/tui/kit/index.ts";
import { THEME } from "#src/tui/app/render/theme.ts";

/**
 * 对话流底部居中的置底按钮。
 *
 * 只在上滚离开底部时出现：用一行高的浮层盖住对话流最后一行中部，不占布局高度，因此不需要
 * 改动任何高度与行号计算。位置、命中区与按钮配色都在 `src/tui/kit`，这里只给标签与主题。
 */

/** 符号两侧各留两列内边距：单行小目标用鼠标很难点中，胶囊要做得比符号本身宽。 */
const LABEL = "  ▼  ";
/** 命中区在按钮左右各放宽一列，让这个窄小的目标更好点中。 */
const HIT_SLOP = 1;

interface ScrollButtonPlacement extends OverlayPlacement {
	/** 已带颜色转义的整段文本 */
	readonly text: string;
}

/**
 * 按钮的位置；终端放不下时返回 undefined。
 *
 * 宽度按显示宽度算，符号或内边距换成宽字符也不会把右侧顶到滚动条上。居中只在滚动条左侧的
 * 正文区里算：整行居中会让按钮往右偏半列，紧贴滚动条反而看不出是浮层。highlighted 只换符号
 * 颜色，位置与命中区不变，因此指针在按钮上移动时不会因为宽度变化而闪。
 */
export function scrollButtonPlacement(
	width: number,
	height: number,
	highlighted = false,
): ScrollButtonPlacement | undefined {
	const placed = placeBottomCenter({
		columns: width,
		rows: height,
		labelWidth: displayWidth(LABEL),
		hitSlop: HIT_SLOP,
	});
	if (placed === undefined) return undefined;
	return { ...placed, text: buttonText({ label: LABEL, focused: highlighted }, THEME) };
}

/** 命中的屏幕坐标是否落在按钮上；行列都从 1 起算，右边界不含。 */
export function scrollButtonHit(placement: ScrollButtonPlacement, row: number, column: number): boolean {
	return overlayHit(placement, row, column);
}
