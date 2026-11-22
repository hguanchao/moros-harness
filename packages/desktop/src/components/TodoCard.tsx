import { useEffect, useRef, useState, type JSX } from "react";

import { formatCompletion, formatTodoCounts, todoCounts, type TodoView } from "../utils/task-view.ts";
import {
	CheckIcon,
	ChevronDownIcon,
	ChevronRightIcon,
	CircleCheckIcon,
	CircleXIcon,
	ClockIcon,
	ListChecksIcon,
} from "./Icons.tsx";

function statusIcon(status: string): JSX.Element {
	switch (status) {
		case "in_progress":
			return <ClockIcon size={12} />;
		case "completed":
			return <CircleCheckIcon size={12} />;
		case "failed":
			return <CircleXIcon size={12} />;
		default:
			return <CheckIcon size={12} />;
	}
}

/** 逐条任务清单（对话流任务卡与底部面板共用）。 */
export function TodoItemList({ view }: { readonly view: TodoView }): JSX.Element {
	return (
		<div className="todo-items">
			{view.items.map((item, index) => (
				<div className={`todo-item status-${item.status}`} key={`${index}-${item.content}`}>
					<span className="todo-item-icon">{statusIcon(item.status)}</span>
					<span className="todo-item-text">{item.content}</span>
				</div>
			))}
		</div>
	);
}

/**
 * 对话流中的收尾任务卡：任务全部完成/失败后落进对话流，常驻可见。
 * 有 in_progress 项时默认展开，用户手动折叠后不被重渲染打回。
 */
export function TodoCard({ view }: { readonly view: TodoView }): JSX.Element {
	const counts = todoCounts(view.items);
	const hasActive = counts.running > 0;
	const defaultOpen = view.collapsed !== true && hasActive;
	const [open, setOpen] = useState(defaultOpen);
	const manuallyToggled = useRef(false);
	useEffect(() => {
		if (!manuallyToggled.current && hasActive) setOpen(true);
	}, [hasActive]);

	return (
		<div className={`todo-card ${open ? "is-open" : ""}`}>
			<button
				type="button"
				className="todo-card-head"
				onClick={() => {
					manuallyToggled.current = true;
					setOpen(!open);
				}}
			>
				<ListChecksIcon size={13} />
				<span className="todo-card-title">待办</span>
				<span className="todo-card-progress">{formatCompletion(view.items)}</span>
				<span className="todo-card-counts">{formatTodoCounts(counts)}</span>
				{open ? <ChevronDownIcon size={13} /> : <ChevronRightIcon size={13} />}
			</button>
			{open ? <TodoItemList view={view} /> : null}
		</div>
	);
}
