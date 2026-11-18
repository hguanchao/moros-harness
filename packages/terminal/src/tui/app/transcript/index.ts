/**
 * 对话流渲染的公共入口。
 *
 * 具体实现按职责拆在 transcript/ 下：类型、样式、模型操作、详情排版、工具行、子代理、
 * 视图构建与滚动各自独立。外部（含测试）仍从这里取用，避免调用方依赖内部文件布局。
 */

export {
	appendToolLine,
	attachToolFailure,
	attachToolResult,
	collapseToolGroups,
	describeToolLine,
	findToolByCallId,
	findTopLevelToolByCallId,
	hasRunningSubagent,
	isSubagentCall,
	takeToolForFailure,
	toggleLastExpandable,
} from "./model.ts";
export {
	highlightSelection,
	orderedSelection,
	selectionPoint,
	selectionRange,
	selectionSpans,
	selectionText,
	stripTerminalStyles,
	visibleTextWidth,
} from "./selection.ts";
export { scrollbarColumn, scrollbarThumb, scrollTopForRow } from "./scroll.ts";
export {
	buildTranscriptView,
	forgetStreamingMarkdown,
	measureTranscriptView,
	planHeaderInView,
	renderTranscriptView,
	subagentFailureRowInView,
	subagentGroupHeaderInView,
	thinkingBlockInView,
	thinkingHeaderInView,
	todoHeaderInView,
	toolBlockInView,
	toolGroupHeaderInView,
	toolHeaderInView,
	transcriptMetrics,
} from "./view.ts";
export type { SelectionPoint, SelectionRegion } from "./selection.ts";
export { PLAIN_LINE_META } from "./types.ts";
export type {
	LineMeta,
	PromptRange,
	SubagentRunView,
	TranscriptLine,
	TranscriptMarkdown,
	TranscriptMetrics,
	TranscriptNote,
	TranscriptPlan,
	TranscriptSubagentGroup,
	TranscriptThinking,
	TranscriptTool,
	TranscriptToolGroup,
	TranscriptTurn,
	TranscriptView,
} from "./types.ts";
