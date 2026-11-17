/**
 * `src/tui/kit`：元素树与组件。
 *
 * 三件事：`el()` 建树、`renderToLines()` 出整帧行、内建组件做页面。库内不出现业务字段名、
 * 产品名与中文文案；主题由调用方注入，默认值一律英文。
 *
 * 应用只允许从这个入口引用，不得相对引用 `src/` 内部文件。
 */

export { el, isElement } from "#src/tui/kit/element.ts";
export type {
	Child,
	Component,
	ComponentProps,
	ElementNode,
	ElementType,
	IntrinsicName,
	Node,
} from "#src/tui/kit/element.ts";
export { bandBlankLine, bandedLines, hangingLines, paintSegments, wrapSegments } from "#src/tui/kit/band.ts";
export type { BandGeometry, ColoredSegment, HangingOptions } from "#src/tui/kit/band.ts";
export { buttonText, Button } from "#src/tui/kit/button.ts";
export type { ButtonProps } from "#src/tui/kit/button.ts";
export { cardFinished, cardHeaderLine, cardItemLine, cardLines, cardPanelLines } from "#src/tui/kit/card.ts";
export type { CardItem, CardItemStatus, CardPanelOptions, CardProps } from "#src/tui/kit/card.ts";
export {
	Box,
	Badge,
	Divider,
	Input,
	List,
	Page,
	RawLines,
	ScrollView,
	Spacer,
	SPINNER_FRAMES,
	Spinner,
	StatusBar,
	Text,
} from "#src/tui/kit/components.ts";
export type {
	BadgeTone,
	BoxProps,
	DividerProps,
	InputProps,
	ListProps,
	ScrollViewProps,
	TextProps,
} from "#src/tui/kit/components.ts";
export { clip, fit, fitLine } from "#src/tui/kit/fit.ts";
export { inputHeight, inputMetrics, inputRowSpans } from "#src/tui/kit/input.ts";
export type { InputLineView, InputMetrics, InputRowSpan } from "#src/tui/kit/input.ts";
export { layout, measure, visibleWidth } from "#src/tui/kit/layout.ts";
export type {
	BoxLayout,
	DividerLayout,
	EmptyLayout,
	InputLayout,
	LayoutNode,
	ListLayout,
	PageLayout,
	RawLayout,
	Rect,
	ScrollLayout,
	Size,
	StatusBarLayout,
	TextAlign,
	TextLayout,
} from "#src/tui/kit/layout.ts";
export { listHeight, listItemsOf, listLines } from "#src/tui/kit/list.ts";
export type { ListItem } from "#src/tui/kit/list.ts";
export { overlayCells, overlayHit, overlayLines, placeBottomCenter } from "#src/tui/kit/overlay.ts";
export type { OverlayGeometry, OverlayPlacement } from "#src/tui/kit/overlay.ts";
export {
	MENU_MAX_VISIBLE,
	PREFIX_WIDTH,
	keepVisible,
	menuListHeight,
	menuListLines,
	moveMenuSelection,
	padEnd,
	padStart,
} from "#src/tui/kit/menu.ts";
export type { MenuListOptions, MenuListState } from "#src/tui/kit/menu.ts";
export { pageContent, pageContentLines, pageHeight, pageLines, pagePropsOf } from "#src/tui/kit/page.ts";
export type { PageAction, PageEntry, PageProps, PageSection } from "#src/tui/kit/page.ts";
export { renderToLines } from "#src/tui/kit/render.ts";
export type { RenderOptions } from "#src/tui/kit/render.ts";
export { scrollbarColumn, scrollbarThumb, scrollTopForRow } from "#src/tui/kit/scroll.ts";
export { statusBarLine, statusBarPropsOf } from "#src/tui/kit/statusbar.ts";
export type { StatusBarProps, StatusTone } from "#src/tui/kit/statusbar.ts";
export { swept } from "#src/tui/kit/sweep.ts";
export type { AnimationFrame } from "#src/tui/kit/sweep.ts";
export { tableLines, Table } from "#src/tui/kit/table.ts";
export type { TableColumn, TableOptions } from "#src/tui/kit/table.ts";
export { toastLine, toastText, Toast } from "#src/tui/kit/toast.ts";
export type { ToastProps, ToastTone } from "#src/tui/kit/toast.ts";
export { virtualWindow, VirtualList } from "#src/tui/kit/virtual.ts";
export type { VirtualListProps, VirtualWindow, VirtualWindowOptions } from "#src/tui/kit/virtual.ts";
