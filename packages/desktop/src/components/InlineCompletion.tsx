import { Fragment, useEffect, useRef, type CSSProperties, type JSX } from "react";
import { createPortal } from "react-dom";

import type { TriggerToken } from "../utils/inline-completion.ts";
import { FileIcon, InfoIcon, SlidersIcon, SparklesIcon } from "./Icons.tsx";

export interface CompletionOption {
	readonly value: string;
	readonly label: string;
	readonly description?: string;
	/** 命令菜单的分组标题（命令 / 技能 / MCP 连接器）；缺省不分段。 */
	readonly group?: string;
	/** 选中后插入的 chip 类型；缺省按 trigger 推断（/命令、@文件、$技能）。 */
	readonly kind?: "command" | "skill" | "mcp";
}

export type CompletionTrigger = "/" | "@" | "$";

/**
 * 行内补全浮层：由 Composer 根据光标处 trigger token 显示，位置由 token 的屏幕矩形决定。
 * 键盘导航（↑↓/Enter/Tab/Esc）由 Composer 处理，本组件只负责渲染与鼠标点击。
 */
export function InlineCompletion({
	trigger,
	token,
	options,
	activeIndex,
	rect,
	onSelect,
	onHover,
}: {
	readonly trigger: CompletionTrigger;
	readonly token: TriggerToken;
	readonly options: readonly CompletionOption[];
	readonly activeIndex: number;
	/** 触发片段的屏幕矩形（getBoundingClientRect）。 */
	readonly rect: { left: number; bottom: number; top: number };
	readonly onSelect: (index: number) => void;
	readonly onHover: (index: number) => void;
}): JSX.Element {
	const activeRef = useRef<HTMLDivElement | null>(null);
	// 方向键切换候选时把高亮项滚进可视区，否则长列表里用户看不到选择变化。
	useEffect(() => {
		activeRef.current?.scrollIntoView({ block: "nearest" });
	}, [activeIndex]);
	// 命令菜单用参考图排版：更宽、带分组标题、每行「/命令 + 说明」同行。
	const isCommandMenu = trigger === "/";
	const width = isCommandMenu
		? Math.min(Math.max(rect.left + 16, 600), window.innerWidth - 16)
		: Math.min(Math.max(rect.left + 16, 260), window.innerWidth - 16);
	const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
	const spaceBelow = window.innerHeight - rect.bottom - 12;
	const spaceAbove = rect.top - 12;
	const openUp = spaceBelow < 240 && spaceAbove > spaceBelow;
	const maxHeight = Math.max(140, Math.min(300, (openUp ? spaceAbove : spaceBelow) - 8));
	const position: CSSProperties = openUp
		? { left, bottom: window.innerHeight - rect.top + 4, width, maxHeight }
		: { left, top: rect.bottom + 4, width, maxHeight };

	return createPortal(
		<div className="inline-completion" style={position} role="listbox" aria-label={`${trigger} 补全`}>
			{/* 列表单独滚动，底部提示作为兄弟节点固定在底部，不随列表滚动。 */}
			<div className="completion-list">
				{options.length === 0 ? (
					<div className="completion-empty">无匹配结果</div>
				) : (
					options.map((option, index) => {
						// 命令菜单按 group 分段：每组第一项前插入分组标题。
						const groupHeader =
							isCommandMenu && option.group !== undefined && option.group !== options[index - 1]?.group ? (
								<div className="completion-group-label" key={`group-${option.group}`}>
									{option.group}
								</div>
							) : null;
						return (
							<Fragment key={option.value}>
								{groupHeader}
								<div
									ref={index === activeIndex ? activeRef : undefined}
									role="option"
									aria-selected={index === activeIndex}
									className={`completion-option ${isCommandMenu ? "is-command" : ""} ${index === activeIndex ? "is-active" : ""}`}
									onMouseEnter={() => onHover(index)}
									onMouseDown={(event) => event.preventDefault()}
									onClick={() => onSelect(index)}
								>
									{isCommandMenu ? (
										<>
											<span className="completion-command-label">{option.label}</span>
											{option.description === undefined ? null : (
												<span className="completion-desc">{option.description}</span>
											)}
										</>
									) : (
										<>
											<span className="completion-icon">{iconFor(trigger)}</span>
											<span className="completion-text">
												<span className="completion-label">{option.label}</span>
												{option.description === undefined ? null : (
													<span className="completion-desc">{option.description}</span>
												)}
											</span>
										</>
									)}
								</div>
							</Fragment>
						);
					})
				)}
			</div>
			{isCommandMenu ? (
				<div className="completion-hint">
					<InfoIcon size={12} />
					<span>输入内容以搜索命令、技能或 MCP 连接器</span>
				</div>
			) : null}
		</div>,
		document.body,
	);
}

function iconFor(trigger: CompletionTrigger): JSX.Element {
	switch (trigger) {
		case "/":
			return <SlidersIcon size={13} />;
		case "@":
			return <FileIcon size={13} />;
		case "$":
			return <SparklesIcon size={13} />;
	}
}
