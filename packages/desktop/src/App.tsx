import { useEffect, useRef, useState, type Dispatch, type JSX, type PointerEvent as ReactPointerEvent } from "react";

import { currentNavigationEpoch, useDesktopActions } from "./hooks/actions.ts";
import { call, errorMessage } from "./api/api.ts";
import { MAX_SIDEBAR_WIDTH, MIN_SIDEBAR_WIDTH } from "./shared/contract.ts";
import { ChangesPage } from "./views/ChangesPage.tsx";
import { ChatPage } from "./views/ChatPage.tsx";
import { FilesPage } from "./views/FilesPage.tsx";
import { SessionsPage } from "./views/SessionsPage.tsx";
import { SettingsApp } from "./views/SettingsApp.tsx";
import { TracePage } from "./views/TracePage.tsx";
import { Sidebar } from "./components/Sidebar.tsx";
import { TitleBar } from "./components/TitleBar.tsx";
import { useApp, type Action } from "./store/state.tsx";
import { clampSidebarToViewport } from "./utils/layout.ts";
import { AlertIcon, InfoIcon, XIcon } from "./components/Icons.tsx";

const isMac = navigator.platform.toLowerCase().includes("mac");

export function App(): JSX.Element {
	const { state, dispatch } = useApp();
	const actions = useDesktopActions();

	useEffect(() => {
		let cancelled = false;
		const off = window.moros.onPush((message) => dispatch({ type: "push", message }));
		const epoch = currentNavigationEpoch();
		void (async () => {
			try {
				const app = await call(window.moros.appState());
				const settings = await call(window.moros.settingsGet()).catch((error: unknown) => {
					dispatch({ type: "notice", level: "warn", message: `无法加载设置：${errorMessage(error)}` });
					return undefined;
				});
				if (cancelled) return;
				const shouldRestoreSession = epoch === currentNavigationEpoch();
				dispatch({ type: "init", app, shouldRestoreSession, ...(settings === undefined ? {} : { settings }) });
				if (shouldRestoreSession && app.project?.session !== undefined) {
					await actions.hydrate(app.project.session, epoch);
				}
			} catch (error) {
				if (!cancelled) dispatch({ type: "error", message: errorMessage(error) });
			}
		})();
		return () => {
			cancelled = true;
			off();
		};
	}, [dispatch, actions.hydrate]);

	useEffect(() => {
		if (!state.ready) return;
		void actions.refreshSessions().catch((error: unknown) => {
			dispatch({ type: "notice", level: "warn", message: `无法刷新会话列表：${errorMessage(error)}` });
		});
	}, [state.ready, state.sessionsVersion, actions.refreshSessions, dispatch]);

	useEffect(() => {
		const query = window.matchMedia("(prefers-color-scheme: dark)");
		const apply = (): void => {
			const resolved = state.theme === "auto" ? (query.matches ? "dark" : "light") : state.theme;
			document.documentElement.dataset.theme = resolved;
			document.documentElement.dataset.themeChoice = state.theme;
			dispatch({ type: "resolved-theme", theme: resolved });
			void window.moros.windowSetTheme(resolved === "dark");
		};
		apply();
		if (state.theme !== "auto") return;
		query.addEventListener("change", apply);
		return () => query.removeEventListener("change", apply);
	}, [state.theme, dispatch]);

	// 侧栏宽度：渲染层即时应用，拖拽结束时由宿主持久化；覆盖 CSS 默认与响应式断点。
	useEffect(() => {
		document.documentElement.style.setProperty("--sidebar-width", `${state.sidebarWidth}px`);
	}, [state.sidebarWidth]);

	// 窗口收窄时自动收窄侧栏，为内容区保底；窗口放大不自动放宽，避免覆盖用户设定。
	useEffect(() => {
		const apply = (): void => {
			const next = clampSidebarToViewport(state.sidebarWidth, window.innerWidth, state.sidebarOpen);
			if (next === undefined) return;
			dispatch({ type: "sidebar-width", width: next });
			void call(window.moros.sidebarSetWidth(next)).catch((error: unknown) => {
				dispatch({ type: "notice", level: "warn", message: `无法保存侧栏宽度：${errorMessage(error)}` });
			});
		};
		apply();
		window.addEventListener("resize", apply);
		return () => window.removeEventListener("resize", apply);
	}, [state.sidebarWidth, state.sidebarOpen, dispatch]);

	// 界面字号：只缩放文字，图标与布局尺寸保持不变
	useEffect(() => {
		document.documentElement.style.setProperty("--ui-scale", String(state.uiFontSize / 14));
	}, [state.uiFontSize]);

	// 界面字体：外观设置选择，写到 html[data-font]，CSS 据此覆盖 --font-ui
	useEffect(() => {
		document.documentElement.dataset.font = state.settings?.config.ui.fontFamily ?? "system";
	}, [state.settings]);

	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent): void => {
			const modifier = isMac ? event.metaKey : event.ctrlKey;
			if (!modifier) return;
			if (event.key.toLowerCase() === "b") {
				event.preventDefault();
				dispatch({ type: "sidebar", open: !state.sidebarOpen });
				return;
			}
			if (event.key === ",") {
				event.preventDefault();
				dispatch({ type: "page", page: "settings" });
				return;
			}
			if (event.key.toLowerCase() === "o") {
				event.preventDefault();
				if (!state.ready) return;
				void actions.openProjectDialog().catch((error: unknown) => {
					dispatch({ type: "notice", level: "error", message: errorMessage(error) });
				});
				return;
			}
			if (event.key.toLowerCase() === "n") {
				event.preventDefault();
				actions.newTask();
			}
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [state.sidebarOpen, state.ready, actions, dispatch]);

	return (
		<div
			className="app"
			data-platform={state.app?.platform ?? (isMac ? "darwin" : "win32")}
			data-has-project={state.project?.target.kind === "project" ? "true" : "false"}
		>
			<TitleBar
				sidebarOpen={state.sidebarOpen}
				onToggleSidebar={() => dispatch({ type: "sidebar", open: !state.sidebarOpen })}
			/>
			{state.page === "settings" ? (
				<SettingsApp />
			) : (
				<div className="app-body">
					<Sidebar open={state.sidebarOpen} />
					{state.sidebarOpen ? <SidebarResizeHandle width={state.sidebarWidth} dispatch={dispatch} /> : null}
					<main className="main">
						{state.page === "chat" ? <ChatPage /> : null}
						{state.page === "files" ? <FilesPage /> : null}
						{state.page === "changes" ? <ChangesPage /> : null}
						{state.page === "trace" ? <TracePage /> : null}
						{state.page === "sessions" ? <SessionsPage /> : null}
					</main>
				</div>
			)}
			<Toasts />
		</div>
	);
}

/**
 * 侧栏右缘的拖拽手柄：拖动时即时更新宽度，松手后由宿主持久化。
 * 用 pointer capture 保证拖出手柄范围仍继续跟踪。
 */
function SidebarResizeHandle({
	width,
	dispatch,
}: {
	readonly width: number;
	readonly dispatch: Dispatch<Action>;
}): JSX.Element {
	const [dragging, setDragging] = useState(false);
	const startX = useRef(0);
	const startWidth = useRef(width);
	const latestWidth = useRef(width);

	const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
		if (event.button !== 0) return;
		event.preventDefault();
		event.currentTarget.setPointerCapture(event.pointerId);
		startX.current = event.clientX;
		startWidth.current = width;
		latestWidth.current = width;
		setDragging(true);
		document.documentElement.classList.add("is-resizing-sidebar");
	};

	const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
		if (!dragging) return;
		const next = Math.max(
			MIN_SIDEBAR_WIDTH,
			Math.min(MAX_SIDEBAR_WIDTH, startWidth.current + event.clientX - startX.current),
		);
		latestWidth.current = next;
		dispatch({ type: "sidebar-width", width: next });
	};

	const finish = (event: ReactPointerEvent<HTMLDivElement>): void => {
		if (!dragging) return;
		event.currentTarget.releasePointerCapture(event.pointerId);
		setDragging(false);
		document.documentElement.classList.remove("is-resizing-sidebar");
		void call(window.moros.sidebarSetWidth(latestWidth.current)).catch((error: unknown) => {
			dispatch({ type: "notice", level: "warn", message: `无法保存侧栏宽度：${errorMessage(error)}` });
		});
	};

	return (
		<div
			className={`sidebar-resize-handle ${dragging ? "is-dragging" : ""}`}
			role="separator"
			aria-orientation="vertical"
			aria-label="调整侧栏宽度"
			onPointerDown={onPointerDown}
			onPointerMove={onPointerMove}
			onPointerUp={finish}
			onPointerCancel={finish}
		/>
	);
}

function Toasts(): JSX.Element {
	const { state, dispatch } = useApp();
	return (
		<div className="toasts">
			{state.notices.map((notice) => (
				<Toast
					key={notice.id}
					id={notice.id}
					level={notice.level}
					message={notice.message}
					onDismiss={() => dispatch({ type: "dismiss-notice", id: notice.id })}
				/>
			))}
		</div>
	);
}

function Toast({
	id,
	level,
	message,
	onDismiss,
}: {
	readonly id: number;
	readonly level: "info" | "warn" | "error";
	readonly message: string;
	readonly onDismiss: () => void;
}): JSX.Element {
	useEffect(() => {
		const timer = window.setTimeout(onDismiss, level === "error" ? 9_000 : 5_000);
		return () => window.clearTimeout(timer);
	}, [id, level, onDismiss]);

	return (
		<div className={`toast toast-${level}`} role={level === "error" ? "alert" : "status"}>
			<span className="toast-icon">{level === "info" ? <InfoIcon size={15} /> : <AlertIcon size={15} />}</span>
			<span className="toast-message">{message}</span>
			<button className="toast-close" aria-label="关闭" onClick={onDismiss}>
				<XIcon size={13} />
			</button>
		</div>
	);
}
