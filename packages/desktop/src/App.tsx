import { useEffect, type JSX } from "react";

import { currentNavigationEpoch, useDesktopActions } from "./hooks/actions.ts";
import { call, errorMessage } from "./api/api.ts";
import { ChangesPage } from "./views/ChangesPage.tsx";
import { ChatPage } from "./views/ChatPage.tsx";
import { FilesPage } from "./views/FilesPage.tsx";
import { SessionsPage } from "./views/SessionsPage.tsx";
import { SettingsApp } from "./views/SettingsApp.tsx";
import { TracePage } from "./views/TracePage.tsx";
import { Sidebar } from "./components/Sidebar.tsx";
import { TitleBar } from "./components/TitleBar.tsx";
import { useApp } from "./store/state.tsx";
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

	// 界面字号：只缩放文字，图标与布局尺寸保持不变
	useEffect(() => {
		document.documentElement.style.setProperty("--ui-scale", String(state.uiFontSize / 14));
	}, [state.uiFontSize]);

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
