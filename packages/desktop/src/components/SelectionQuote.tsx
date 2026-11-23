import { useCallback, useEffect, useRef, useState, type JSX, type ReactNode } from "react";

import { CheckIcon, CopyIcon, QuoteIcon } from "./Icons.tsx";

/** 选区在其所属消息正文内的字符偏移与来源消息 seq。 */
export interface QuoteSpan {
	readonly start: number;
	readonly end: number;
	readonly sourceSeq?: number;
}

interface QuoteAnchor {
	readonly text: string;
	readonly x: number;
	readonly y: number;
	readonly span?: QuoteSpan;
}

/**
 * 计算 range 起点/终点相对 root 的纯文本字符偏移。
 * 用 Range.cloneRange 从 root 开头选到目标点，取 toString 长度（与 UTF-16 偏移一致）。
 */
function offsetWithin(root: Element, node: Node, nodeOffset: number): number {
	const range = document.createRange();
	range.selectNodeContents(root);
	try {
		range.setEnd(node, nodeOffset);
	} catch {
		return 0;
	}
	return range.toString().length;
}

/**
 * 划词引用：监听容器内文本选区，浮出「引用」按钮，点击后把选中文本作为
 * 引用 chip 插入输入框（DeepSeek 式；发送时才格式化为 `> ` 引用块）。
 *
 * - 只有落在容器内的非空选区才显示按钮；
 * - 点击时用 Selection.toString() 冻结文本快照（与主流一致，流式 delta 不回写）；
 * - 点击后立即清除选区并隐藏浮层。
 */
export function SelectionQuote({
	onQuote,
	children,
}: {
	/** 选中文本原文插入引用 chip 的回调；span 尽量带上，取不到则省略。 */
	readonly onQuote: (text: string, span?: QuoteSpan) => void;
	readonly children: ReactNode;
}): JSX.Element {
	const containerRef = useRef<HTMLDivElement>(null);
	const [anchor, setAnchor] = useState<QuoteAnchor | undefined>(undefined);
	const [copied, setCopied] = useState(false);
	const copiedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

	const hide = useCallback(() => {
		setAnchor(undefined);
		setCopied(false);
	}, []);

	useEffect(
		() => () => {
			if (copiedTimer.current !== undefined) clearTimeout(copiedTimer.current);
		},
		[],
	);

	useEffect(() => {
		const container = containerRef.current;
		if (container === null) return;

		const onMouseUp = (): void => {
			// 延迟一帧，让浏览器完成选区更新。
			requestAnimationFrame(() => {
				const selection = window.getSelection();
				if (selection === null || selection.isCollapsed || selection.rangeCount === 0) {
					hide();
					return;
				}
				const range = selection.getRangeAt(0);
				// 选区必须完整落在容器内。
				if (!container.contains(range.commonAncestorContainer)) {
					hide();
					return;
				}
				const text = selection.toString();
				if (text.trim().length === 0) {
					hide();
					return;
				}
				const rect = range.getBoundingClientRect();
				// 找最近的 [data-message-seq] 祖先作为偏移基准与来源消息。
				const startNode = range.startContainer;
				const startElement = startNode instanceof Element ? startNode : startNode.parentElement;
				const messageEl = startElement?.closest<HTMLElement>("[data-message-seq]") ?? null;
				let span: QuoteSpan | undefined;
				if (messageEl !== null) {
					span = {
						start: offsetWithin(messageEl, range.startContainer, range.startOffset),
						end: offsetWithin(messageEl, range.endContainer, range.endOffset),
						...(messageEl.dataset.messageSeq === undefined ? {} : { sourceSeq: Number(messageEl.dataset.messageSeq) }),
					};
				}
				setAnchor({ text, x: rect.left + rect.width / 2, y: rect.top, ...(span === undefined ? {} : { span }) });
			});
		};

		const onKeyDown = (event: KeyboardEvent): void => {
			if (event.key === "Escape") hide();
		};

		container.addEventListener("mouseup", onMouseUp);
		document.addEventListener("keydown", onKeyDown);
		window.addEventListener("scroll", hide, true);
		return () => {
			container.removeEventListener("mouseup", onMouseUp);
			document.removeEventListener("keydown", onKeyDown);
			window.removeEventListener("scroll", hide, true);
		};
	}, [hide]);

	const handleQuote = (): void => {
		if (anchor === undefined) return;
		// 传原文快照；格式化为 `> ` 引用块由 Composer 在发送时完成。
		const text = anchor.text;
		window.getSelection()?.removeAllRanges();
		hide();
		if (text.trim().length > 0) onQuote(text, anchor.span);
	};

	const handleCopy = (): void => {
		if (anchor === undefined) return;
		const text = anchor.text;
		void navigator.clipboard.writeText(text).then(() => {
			setCopied(true);
			if (copiedTimer.current !== undefined) clearTimeout(copiedTimer.current);
			copiedTimer.current = setTimeout(() => setCopied(false), 2_000);
		});
		window.getSelection()?.removeAllRanges();
		hide();
	};

	return (
		<div className="selection-quote-host" ref={containerRef}>
			{children}
			{anchor === undefined ? null : (
				<div className="selection-toolbar" style={{ left: anchor.x, top: anchor.y }}>
					<button
						type="button"
						className="selection-toolbar-button"
						aria-label="引用选中内容"
						onMouseDown={(event) => event.preventDefault()}
						onClick={handleQuote}
					>
						<QuoteIcon size={12} />
						引用
					</button>
					<span className="selection-toolbar-sep" />
					<button
						type="button"
						className="selection-toolbar-button"
						aria-label="复制选中内容"
						onMouseDown={(event) => event.preventDefault()}
						onClick={handleCopy}
					>
						{copied ? <CheckIcon size={12} /> : <CopyIcon size={12} />}
						复制
					</button>
				</div>
			)}
		</div>
	);
}
