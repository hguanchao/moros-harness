import { useEffect, useLayoutEffect, useRef, useState, type JSX } from "react";
import { createPortal } from "react-dom";

interface TooltipAnchor {
	readonly text: string;
	readonly left: number;
	readonly right: number;
	readonly top: number;
	readonly bottom: number;
}

const GAP = 8;
const EDGE = 8;
/** 鼠标悬停到显示提示的延迟；避免掠过时闪烁。键盘聚焦仍即时显示。 */
const SHOW_DELAY_MS = 400;

/**
 * 全局 Tooltip 宿主：用事件委托监听所有带 data-tooltip 的元素，
 * 在悬停/键盘聚焦时于其附近渲染气泡，替代浏览器原生 title。
 * 挂载一次即可覆盖整个应用，元素被 portal 或动态渲染也无需逐个绑定。
 */
export function TooltipHost(): JSX.Element | null {
	const [anchor, setAnchor] = useState<TooltipAnchor | undefined>(undefined);
	const bubbleRef = useRef<HTMLDivElement>(null);
	const timer = useRef<number | undefined>(undefined);
	const activeTarget = useRef<HTMLElement | undefined>(undefined);

	useEffect(() => {
		const findTarget = (node: EventTarget | null): HTMLElement | undefined => {
			if (!(node instanceof Element)) return undefined;
			return node.closest<HTMLElement>("[data-tooltip]") ?? undefined;
		};
		const clearTimer = (): void => {
			if (timer.current !== undefined) {
				window.clearTimeout(timer.current);
				timer.current = undefined;
			}
		};
		const hide = (): void => {
			clearTimer();
			activeTarget.current = undefined;
			setAnchor(undefined);
		};
		/** 目标是否仍挂在文档里且可见；脱离 DOM（如双击重命名把 h2 换成 input）时不再定位。 */
		const isTargetValid = (target: HTMLElement): boolean => target.isConnected && target.getClientRects().length > 0;
		/** 悬停：先取消旧计时，延迟后再显示，避免划过时逐个弹出。 */
		const scheduleShow = (target: HTMLElement): void => {
			const text = target.dataset.tooltip;
			if (text === undefined || text.length === 0) return;
			if (activeTarget.current === target && timer.current === undefined) return;
			clearTimer();
			activeTarget.current = target;
			timer.current = window.setTimeout(() => {
				timer.current = undefined;
				// 延迟期间目标可能已被替换/移除，此时其矩形为 0 导致气泡跑到左上角。
				if (!isTargetValid(target)) {
					hide();
					return;
				}
				const rect = target.getBoundingClientRect();
				setAnchor({ text, left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom });
			}, SHOW_DELAY_MS);
		};
		/** 键盘聚焦：无障碍场景下即时显示。 */
		const showNow = (target: HTMLElement): void => {
			const text = target.dataset.tooltip;
			if (text === undefined || text.length === 0 || !isTargetValid(target)) return;
			clearTimer();
			activeTarget.current = target;
			const rect = target.getBoundingClientRect();
			setAnchor({ text, left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom });
		};

		const onOver = (event: PointerEvent): void => {
			if (event.pointerType === "touch") return;
			const target = findTarget(event.target);
			if (target !== undefined) scheduleShow(target);
		};
		const onOut = (event: PointerEvent): void => {
			const target = findTarget(event.target);
			const related = findTarget(event.relatedTarget);
			if (target !== undefined && related !== target) hide();
		};
		const onMove = (event: PointerEvent): void => {
			// 移到另一个带提示的元素时，重新计时显示对应的提示。
			if (event.pointerType === "touch") return;
			const target = findTarget(event.target);
			if (target === undefined || target === activeTarget.current) return;
			scheduleShow(target);
		};
		const onFocusIn = (event: FocusEvent): void => {
			const target = findTarget(event.target);
			if (target !== undefined) showNow(target);
		};
		const onFocusOut = (event: FocusEvent): void => {
			const target = findTarget(event.target);
			const related = findTarget(event.relatedTarget);
			if (target !== undefined && related !== target) hide();
		};

		// 已显示的提示若其目标被移除（切换页面、双击重命名等），立即隐藏。
		const observer = new MutationObserver(() => {
			const target = activeTarget.current;
			if (target !== undefined && !target.isConnected) hide();
		});
		observer.observe(document.body, { childList: true, subtree: true });

		document.addEventListener("pointerover", onOver);
		document.addEventListener("pointermove", onMove);
		document.addEventListener("pointerout", onOut);
		document.addEventListener("focusin", onFocusIn);
		document.addEventListener("focusout", onFocusOut);
		window.addEventListener("blur", hide);
		window.addEventListener("scroll", hide, true);
		return () => {
			clearTimer();
			observer.disconnect();
			document.removeEventListener("pointerover", onOver);
			document.removeEventListener("pointermove", onMove);
			document.removeEventListener("pointerout", onOut);
			document.removeEventListener("focusin", onFocusIn);
			document.removeEventListener("focusout", onFocusOut);
			window.removeEventListener("blur", hide);
			window.removeEventListener("scroll", hide, true);
		};
	}, []);

	// 气泡挂载后测量自身尺寸，据此把水平位置钳制在视口内、垂直方向决定上下翻转。
	useLayoutEffect(() => {
		if (anchor === undefined || bubbleRef.current === null) return;
		const bubble = bubbleRef.current;
		const viewportWidth = window.innerWidth;
		const viewportHeight = window.innerHeight;
		const width = bubble.offsetWidth;
		const height = bubble.offsetHeight;
		// 目标矩形为 0（已从 DOM 移除）时不定位，避免气泡飞到左上角。
		if (anchor.right <= anchor.left || anchor.bottom <= anchor.top) return;
		const center = (anchor.left + anchor.right) / 2;
		// 水平：以触发元素中心对齐，左右各留出 EDGE，超界则钳制。
		const left = Math.min(Math.max(center - width / 2, EDGE), Math.max(EDGE, viewportWidth - width - EDGE));
		// 垂直：下方空间不足则翻到上方，再不足则钳制到视口内。
		const below = anchor.bottom + GAP;
		const placeAbove = below + height > viewportHeight && anchor.top - GAP - height >= EDGE;
		const top = placeAbove
			? anchor.top - GAP - height
			: Math.min(below, Math.max(EDGE, viewportHeight - height - EDGE));
		bubble.style.left = `${left}px`;
		bubble.style.top = `${top}px`;
		bubble.classList.toggle("is-above", placeAbove);
		bubble.classList.toggle("is-below", !placeAbove);
	}, [anchor]);

	if (anchor === undefined) return null;
	return createPortal(
		<div ref={bubbleRef} className="ui-tooltip" role="tooltip" style={{ top: -9999, left: -9999 }}>
			{anchor.text}
		</div>,
		document.body,
	);
}
