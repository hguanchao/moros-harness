import { useEffect, useRef, useState, type JSX } from "react";

import { currentTaskText, formatCompletion, todoCounts, type TodoView } from "../utils/task-view.ts";
import { ChevronDownIcon, ChevronRightIcon, ListChecksIcon } from "./Icons.tsx";
import { TodoItemList } from "./TodoCard.tsx";

/**
 * 当前未收尾任务列表的常驻面板（输入框上方）。
 * 全部完成/失败后，当前列表消失，任务卡落入对话流——与终端语义一致。
 */
export function TodoPanel({
	view,
	running,
}: {
	readonly view: TodoView | undefined;
	/** 会话是否正在运行（决定是否显示动态提示）。 */
	readonly running: boolean;
}): JSX.Element | null {
	const counts = view === undefined ? undefined : todoCounts(view.items);
	const hasActive = counts === undefined ? false : counts.running > 0;
	const defaultOpen = view?.collapsed !== true && hasActive;
	const [open, setOpen] = useState(defaultOpen);
	const manuallyToggled = useRef(false);
	useEffect(() => {
		if (!manuallyToggled.current && hasActive) setOpen(true);
	}, [hasActive]);

	if (view === undefined || counts === undefined) return null;
	const active = currentTaskText(view.items);

	return (
		<div className={`todo-panel ${open ? "is-open" : ""}`}>
			<button
				type="button"
				className="todo-panel-summary"
				onClick={() => {
					manuallyToggled.current = true;
					setOpen(!open);
				}}
			>
				<ListChecksIcon size={13} />
				<span>待办 {formatCompletion(view.items)}</span>
				{active === undefined ? null : (
					<>
						<span className="todo-panel-sep">·</span>
						<span className="todo-panel-active">正在实现 {active}</span>
					</>
				)}
				{running && hasActive ? <span className="spinner small" /> : null}
				{open ? <ChevronDownIcon size={13} /> : <ChevronRightIcon size={13} />}
			</button>
			{open ? (
				<div className="todo-panel-body">
					<TodoItemList view={view} />
				</div>
			) : null}
		</div>
	);
}
