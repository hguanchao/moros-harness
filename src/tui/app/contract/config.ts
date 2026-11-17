/** 审批策略档位；Moros Harness 的 config.approval 使用同一组值，当前不在 TUI 里提供切换入口。 */
export type ApprovalMode = "ask" | "auto" | "yolo";
/** 通知方式；未提供时按 auto 处理。 */
export type NotifyMode = "auto" | "bell" | "desktop" | "off";
/** 推理强度档位；与 Core 的 ReasoningEffort 六档一致，/effort 选择只作用于当前会话。 */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "max";

export const APPROVAL_MODES = ["ask", "auto", "yolo"] as const;
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "max"] as const;
