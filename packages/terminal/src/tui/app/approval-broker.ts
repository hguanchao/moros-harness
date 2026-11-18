/**
 * 审批队列已下沉到 Core 统一持有；这里只保留 TUI 的导入路径。
 */
export {
	createApprovalBroker,
	type ApprovalAnswer,
	type ApprovalBroker,
	type ApprovalBrokerOptions,
	type ApprovalPrompt,
} from "@moros/core/harness/approval-broker.ts";
