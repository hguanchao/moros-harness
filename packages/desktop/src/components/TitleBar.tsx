import { useEffect, type JSX } from "react";

import { call, errorMessage } from "../api/api.ts";
import { useDesktopActions } from "../hooks/actions.ts";
import {
	ArrowLeftIcon,
	ArrowRightIcon,
	MaximizeIcon,
	MinusIcon,
	PanelIcon,
	RestoreIcon,
	SearchIcon,
	XIcon,
} from "./Icons.tsx";
import { useApp } from "../store/state.tsx";

export interface TitleBarProps {
	readonly sidebarOpen: boolean;
	readonly onToggleSidebar: () => void;
}

/** Windows 11 风格标题栏：左侧侧栏开关与前进/后退/搜索占位（设置页隐藏），右侧自绘窗口控制。 */
export function TitleBar({ sidebarOpen, onToggleSidebar }: TitleBarProps): JSX.Element {
	const { state, dispatch } = useApp();
	const actions = useDesktopActions();
	const isMac = state.app?.platform === "darwin";
	// 设置页是独立视图，不参与会话历史，隐藏整组导航按钮。
	const inSettings = state.page === "settings";
	const canGoBack = state.historyIndex > 0;
	const canGoForward = state.historyIndex < state.history.length - 1;
	const report = (error: unknown): void => {
		dispatch({ type: "notice", level: "error", message: errorMessage(error) });
	};

	useEffect(() => {
		void call(window.moros.windowState())
			.then((windowState) => {
				dispatch({ type: "push", message: { type: "window-state", state: windowState } });
			})
			.catch(() => undefined);
	}, [dispatch]);

	return (
		<header
			className="titlebar"
			onDoubleClick={(event) => {
				if ((event.target as HTMLElement).closest("button") !== null) return;
				void window.moros.windowToggleMaximize();
			}}
		>
			<div className="titlebar-left">
				<button
					className={`titlebar-toggle ${sidebarOpen ? "is-active" : ""}`}
					aria-label={sidebarOpen ? "收起侧栏" : "展开侧栏"}
					title={sidebarOpen ? "收起侧栏" : "展开侧栏"}
					onClick={onToggleSidebar}
				>
					<PanelIcon size={16} />
				</button>
				{inSettings ? null : (
					<div className="titlebar-nav">
						<button
							className="titlebar-action"
							aria-label="后退"
							title="后退"
							disabled={!canGoBack}
							onClick={() => void actions.goBack().catch(report)}
						>
							<ArrowLeftIcon size={16} />
						</button>
						<button
							className="titlebar-action"
							aria-label="前进"
							title="前进"
							disabled={!canGoForward}
							onClick={() => void actions.goForward().catch(report)}
						>
							<ArrowRightIcon size={16} />
						</button>
						<button className="titlebar-action" aria-label="搜索" title="搜索（即将推出）" disabled>
							<SearchIcon size={16} />
						</button>
					</div>
				)}
			</div>
			{isMac ? null : (
				<div className="caption-group">
					<button
						className="caption"
						aria-label="最小化"
						title="最小化"
						onClick={() => void window.moros.windowMinimize()}
					>
						<MinusIcon size={14} />
					</button>
					<button
						className="caption"
						aria-label={state.windowMaximized ? "向下还原" : "最大化"}
						title={state.windowMaximized ? "向下还原" : "最大化"}
						onClick={() => void window.moros.windowToggleMaximize()}
					>
						{state.windowMaximized ? <RestoreIcon size={14} /> : <MaximizeIcon size={14} />}
					</button>
					<button
						className="caption caption-close"
						aria-label="关闭"
						title="关闭"
						onClick={() => void window.moros.windowClose()}
					>
						<XIcon size={14} />
					</button>
				</div>
			)}
		</header>
	);
}
