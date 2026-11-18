/**
 * `src/tui/kit`：元素树与组件。
 *
 * 三件事：`el()` 建树、`renderToLines()` 出整帧行、内建组件做页面。库内不出现业务字段名、
 * 产品名与中文文案；主题由调用方注入，默认值一律英文。
 *
 * 应用只允许从这个入口引用，不得相对引用 `src/` 内部文件。
 */

export { el, isElement } from "./element.ts";
export type { Child, Component, ComponentProps, ElementNode, ElementType, IntrinsicName, Node } from "./element.ts";
export { bandBlankLine, bandedLines, hangingLines, paintSegments, wrapSegments } from "./band.ts";
export type { BandGeometry, ColoredSegment, HangingOptions } from "./band.ts";
export { buttonText, Button } from "./button.ts";
export type { ButtonProps } from "./button.ts";
export { cardFinished, cardHeaderLine, cardItemLine, cardLines, cardPanelLines } from "./card.ts";
export type { CardItem, CardItemStatus, CardPanelOptions, CardProps } from "./card.ts";
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
} from "./components.ts";
export type {
	BadgeTone,
	BoxProps,
	DividerProps,
	InputProps,
	ListProps,
	ScrollViewProps,
	TextProps,
} from "./components.ts";
export { clip, fit, fitLine } from "./fit.ts";
export { inputHeight, inputMetrics, inputRowSpans } from "./input.ts";
export type { InputLineView, InputMetrics, InputRowSpan } from "./input.ts";
export { layout, measure, visibleWidth } from "./layout.ts";
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
} from "./layout.ts";
export { listHeight, listItemsOf, listLines } from "./list.ts";
export type { ListItem } from "./list.ts";
export { overlayCells, overlayHit, overlayLines, placeBottomCenter } from "./overlay.ts";
export type { OverlayGeometry, OverlayPlacement } from "./overlay.ts";
export {
	MENU_MAX_VISIBLE,
	PREFIX_WIDTH,
	keepVisible,
	menuListHeight,
	menuListLines,
	moveMenuSelection,
	padEnd,
	padStart,
} from "./menu.ts";
export type { MenuListOptions, MenuListState } from "./menu.ts";
export { pageContent, pageContentLines, pageHeight, pageLines, pagePropsOf } from "./page.ts";
export type { PageAction, PageEntry, PageProps, PageSection } from "./page.ts";
export { renderToLines } from "./render.ts";
export type { RenderOptions } from "./render.ts";
export { scrollbarColumn, scrollbarThumb, scrollTopForRow } from "./scroll.ts";
export { statusBarLine, statusBarPropsOf } from "./statusbar.ts";
export type { StatusBarProps, StatusTone } from "./statusbar.ts";
export { swept } from "./sweep.ts";
export type { AnimationFrame } from "./sweep.ts";
export { tableLines, Table } from "./table.ts";
export type { TableColumn, TableOptions } from "./table.ts";
export { toastLine, toastText, Toast } from "./toast.ts";
export type { ToastProps, ToastTone } from "./toast.ts";
export { virtualWindow, VirtualList } from "./virtual.ts";
export type { VirtualListProps, VirtualWindow, VirtualWindowOptions } from "./virtual.ts";
