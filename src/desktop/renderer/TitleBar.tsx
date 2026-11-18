import { useEffect, type JSX } from "react";

import { call } from "#src/desktop/renderer/api.ts";
import { MaximizeIcon, MinusIcon, PanelIcon, RestoreIcon, XIcon } from "#src/desktop/renderer/icons.tsx";
import { useApp } from "#src/desktop/renderer/state.tsx";

export interface TitleBarProps {
	readonly sidebarOpen: boolean;
	readonly onToggleSidebar: () => void;
}

/** Windows 11 风格标题栏：左侧只留侧栏开关，右侧自绘最小化/最大化/关闭。 */
export function TitleBar({ sidebarOpen, onToggleSidebar }: TitleBarProps): JSX.Element {
	const { state, dispatch } = useApp();
	const isMac = state.app?.platform === "darwin";

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
