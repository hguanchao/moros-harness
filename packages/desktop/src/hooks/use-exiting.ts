import { useEffect, useRef, useState } from "react";

/**
 * 离场动画状态：跟踪列表中被移除的条目，在收起动画播完（约 200ms）后再真正卸载，
 * 让「删除即消失」变成有过渡的收起。
 *
 * 清理按批次幂等执行（不依赖 effect cleanup），快速连续移除不会遗留幽灵条目。
 * @param items 当前可见条目列表。
 * @param keyOf 条目稳定唯一键；建议传模块级常量函数，避免每次渲染重跑 effect。
 * @returns 已移除但仍在播放离场动画的条目；调用方与 items 去重后合并渲染。
 */
export function useExitingItems<T>(items: readonly T[], keyOf: (item: T) => string): readonly T[] {
	const [exiting, setExiting] = useState<readonly T[]>([]);
	const knownRef = useRef(items);
	useEffect(() => {
		const keys = new Set(items.map(keyOf));
		const removed = knownRef.current.filter((item) => !keys.has(keyOf(item)));
		knownRef.current = items;
		if (removed.length === 0) return;
		setExiting((current) => [...current, ...removed]);
		const removedKeys = new Set(removed.map(keyOf));
		const timer = setTimeout(() => {
			setExiting((current) => current.filter((item) => !removedKeys.has(keyOf(item))));
		}, 200);
	}, [items, keyOf]);
	const currentKeys = new Set(items.map(keyOf));
	return exiting.filter((item) => !currentKeys.has(keyOf(item)));
}
