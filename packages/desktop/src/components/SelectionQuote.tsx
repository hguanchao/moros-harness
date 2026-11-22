import { useCallback, useEffect, useRef, useState, type JSX, type ReactNode } from "react";

import { CheckIcon, CopyIcon, QuoteIcon } from "./Icons.tsx";

interface QuoteAnchor {
	readonly text: string;
	readonly x: number;
	readonly y: number;
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
	/** 选中文本原文插入引用 chip 的回调。 */
	readonly onQuote: (text: string) => void;
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
				setAnchor({ text, x: rect.left + rect.width / 2, y: rect.top });
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
		if (text.trim().length > 0) onQuote(text);
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
