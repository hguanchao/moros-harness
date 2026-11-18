import type { JSX } from "react";

import { PanelIcon } from "#src/desktop/renderer/icons.tsx";

export interface TitleBarProps {
	readonly projectName?: string;
	readonly sidebarOpen: boolean;
	readonly onToggleSidebar: () => void;
}

/** 顶部标题栏；窗口控制按钮交给系统 overlay，避免自己实现拖拽/吸附语义。 */
export function TitleBar({ projectName, sidebarOpen, onToggleSidebar }: TitleBarProps): JSX.Element {
	return (
		<header className="titlebar">
			<button
				className={`icon-button titlebar-toggle ${sidebarOpen ? "is-active" : ""}`}
				aria-label={sidebarOpen ? "收起侧栏" : "展开侧栏"}
				title={sidebarOpen ? "收起侧栏" : "展开侧栏"}
				onClick={onToggleSidebar}
			>
				<PanelIcon size={16} />
			</button>
			<div className="brand">
				moros<span className="brand-badge">harness</span>
			</div>
			{projectName !== undefined ? <div className="titlebar-project">{projectName}</div> : null}
			<div className="titlebar-drag" />
		</header>
	);
}
