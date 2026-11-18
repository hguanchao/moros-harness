import { useEffect, type JSX } from "react";

import { useDesktopActions } from "./hooks/actions.ts";
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
import { FolderPlusIcon, MetaIcon, XIcon } from "./components/Icons.tsx";

const isMac = navigator.platform.toLowerCase().includes("mac");

export function App(): JSX.Element {
	const { state, dispatch } = useApp();
	const actions = useDesktopActions();

	useEffect(() => {
		let cancelled = false;
		const off = window.moros.onPush((message) => dispatch({ type: "push", message }));
		void (async () => {
			try {
				const app = await call(window.moros.appState());
				const settings = await call(window.moros.settingsGet()).catch(() => undefined);
				if (cancelled) return;
				dispatch({ type: "init", app, ...(settings === undefined ? {} : { settings }) });
				if (app.project?.session !== undefined) {
					await actions.hydrate(app.project.session);
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
		if (state.project === undefined) return;
		void actions.refreshSessions().catch((error: unknown) => {
			dispatch({ type: "notice", level: "warn", message: `无法刷新会话列表：${errorMessage(error)}` });
		});
	}, [state.project?.root, state.sessionsVersion, actions.refreshSessions, dispatch]);

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
				void actions.openProjectDialog().catch((error: unknown) => {
					dispatch({ type: "notice", level: "error", message: errorMessage(error) });
				});
				return;
			}
			if (event.key.toLowerCase() === "n") {
				event.preventDefault();
				if (state.project === undefined) return;
				void actions.createSession().catch((error: unknown) => {
					dispatch({ type: "notice", level: "error", message: errorMessage(error) });
				});
			}
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [state.sidebarOpen, state.project, actions, dispatch]);

	// 设置是独立全屏视图，整窗替代主工作区
	if (state.page === "settings") {
		return (
			<>
				<SettingsApp />
				<Toasts />
			</>
		);
	}

	return (
		<div className="app" data-platform={state.app?.platform ?? (isMac ? "darwin" : "win32")}>
			<TitleBar
				sidebarOpen={state.sidebarOpen}
				onToggleSidebar={() => dispatch({ type: "sidebar", open: !state.sidebarOpen })}
			/>
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
			{state.ready && state.page === "chat" && state.project === undefined ? <Welcome /> : null}
			<Toasts />
		</div>
	);
}

function Welcome(): JSX.Element {
	const { dispatch } = useApp();
	const actions = useDesktopActions();
	return (
		<div className="welcome-layer">
			<div className="welcome">
				<div className="welcome-brand">
					<span className="welcome-brand-logo">
						<MetaIcon size={30} />
					</span>
					<h2 className="welcome-brand-name">Moros Harness</h2>
					<p className="welcome-brand-desc">轻量、本地优先的办公与编程双场景 Agent</p>
				</div>
				<button
					className="primary-button"
					onClick={() => {
						void actions.openProjectDialog().catch((error: unknown) => {
							dispatch({ type: "notice", level: "error", message: errorMessage(error) });
						});
					}}
				>
					<FolderPlusIcon size={16} />
					打开项目
				</button>
				<RecentProjects />
			</div>
		</div>
	);
}

function RecentProjects(): JSX.Element | null {
	const { state, dispatch } = useApp();
	const actions = useDesktopActions();
	if (state.app === undefined || state.app.recentProjects.length === 0) return null;
	return (
		<div className="recent-projects">
			<div className="side-label">最近项目</div>
			{state.app.recentProjects.slice(0, 6).map((project) => (
				<button
					key={project.root}
					className="recent-project"
					title={project.root}
					onClick={() => {
						void actions.openProject(project.root).catch((error: unknown) => {
							dispatch({ type: "notice", level: "error", message: errorMessage(error) });
						});
					}}
				>
					<span>{project.name}</span>
					<small>{project.root}</small>
				</button>
			))}
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
		<div className={`toast toast-${level}`}>
			<span>{message}</span>
			<button className="icon-button" aria-label="关闭" onClick={onDismiss}>
				<XIcon size={14} />
			</button>
		</div>
	);
}
