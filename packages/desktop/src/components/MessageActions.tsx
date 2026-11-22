import { useEffect, useRef, useState, type JSX } from "react";

import type { FeedbackRating } from "../utils/message-actions.ts";
import { CheckIcon, ClockIcon, CopyIcon, ThumbsDownIcon, ThumbsUpIcon } from "./Icons.tsx";

/** 消息时间：显示时分秒（HH:mm:ss），与 ZCode 一致。 */
function formatClock(iso: string | undefined): string {
	if (iso === undefined) return "";
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return "";
	return date.toLocaleTimeString("zh-CN", { hour12: false });
}

/**
 * 每条最终回答下方的操作栏：复制 / 点赞 / 点踩 / 时间戳。
 *
 * 引用改为划词浮层（SelectionQuote），不在此栏中。
 * 反馈状态由外部（事件流还原）传入，组件本身不保存；点击只发出回调，由宿主写入事件流。
 */
export function MessageActions({
	text,
	timestamp,
	rating,
	canFeedback,
	onFeedback,
	disabled = false,
}: {
	readonly text: string;
	readonly timestamp?: string;
	readonly rating?: FeedbackRating;
	/** 是否可反馈（需要对应的 llm.response 事件 seq；流式 live 块为 false）。 */
	readonly canFeedback: boolean;
	readonly onFeedback: (rating: "up" | "down" | "none") => void;
	readonly disabled?: boolean;
}): JSX.Element {
	const [copied, setCopied] = useState(false);
	const copiedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

	useEffect(
		() => () => {
			if (copiedTimer.current !== undefined) clearTimeout(copiedTimer.current);
		},
		[],
	);

	const handleCopy = (): void => {
		if (disabled || text.length === 0) return;
		void navigator.clipboard.writeText(text).then(() => {
			setCopied(true);
			if (copiedTimer.current !== undefined) clearTimeout(copiedTimer.current);
			copiedTimer.current = setTimeout(() => setCopied(false), 2_000);
		});
	};

	const handleFeedback = (next: "up" | "down"): void => {
		if (disabled || !canFeedback) return;
		// 点击当前已选中的档位表示撤销。
		onFeedback(rating === next ? "none" : next);
	};

	return (
		<div className={`message-actions ${disabled ? "is-disabled" : ""}`}>
			{canFeedback ? (
				<>
					<button
						type="button"
						className={`icon-button ${rating === "up" ? "is-active-up" : ""}`}
						aria-label="点赞"
						data-tooltip={rating === "up" ? "取消点赞" : "点赞"}
						disabled={disabled}
						onClick={() => handleFeedback("up")}
					>
						<ThumbsUpIcon size={12} />
					</button>
					<button
						type="button"
						className={`icon-button ${rating === "down" ? "is-active-down" : ""}`}
						aria-label="点踩"
						data-tooltip={rating === "down" ? "取消点踩" : "点踩"}
						disabled={disabled}
						onClick={() => handleFeedback("down")}
					>
						<ThumbsDownIcon size={12} />
					</button>
				</>
			) : null}
			<button
				type="button"
				className="icon-button"
				aria-label="复制消息"
				data-tooltip={copied ? "已复制" : "复制"}
				disabled={disabled}
				onClick={handleCopy}
			>
				{copied ? <CheckIcon size={12} /> : <CopyIcon size={12} />}
			</button>
			{timestamp === undefined ? null : (
				<span className="message-time" data-tooltip={new Date(timestamp).toLocaleString("zh-CN")}>
					<ClockIcon size={11} />
					{formatClock(timestamp)}
				</span>
			)}
		</div>
	);
}
