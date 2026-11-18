import type { JSX } from "react";

import type { SessionMeta } from "#src/core/session/session-manager.ts";
import { useDesktopActions } from "#src/desktop/renderer/actions.ts";
import { call, errorMessage } from "#src/desktop/renderer/api.ts";
import { relativeTime } from "#src/desktop/renderer/format.ts";
import {
	ArchiveIcon,
	DiffIcon,
	FolderIcon,
	FolderPlusIcon,
	ListTreeIcon,
	MessageIcon,
	MoonIcon,
	PlusIcon,
	SettingsIcon,
	SunIcon,
} from "#src/desktop/renderer/icons.tsx";
import { useApp } from "#src/desktop/renderer/state.tsx";

export function Sidebar(): JSX.Element {
	const { state, dispatch } = useApp();
	const actions = useDesktopActions();
	const { project, current, page } = state;

	const report = (error: unknown): void => {
		dispatch({ type: "notice", level: "error", message: errorMessage(error) });
	};

	return (
		<aside className="sidebar">
			<div className="sidebar-header">
				<button
					className="new-task"
					disabled={project === undefined}
					onClick={() => {
						void actions.createSession().catch(report);
					}}
				>
					<PlusIcon size={16} />
					新建任务
				</button>
				<nav className="side-nav">
					<NavButton
						active={page === "files"}
						icon={<FolderIcon size={15} />}
						label="文件"
						onClick={() => dispatch({ type: "page", page: "files" })}
					/>
					<NavButton
						active={page === "changes"}
						icon={<DiffIcon size={15} />}
						label="变更"
						onClick={() => dispatch({ type: "page", page: "changes" })}
					/>
					<NavButton
						active={page === "trace"}
						icon={<ListTreeIcon size={15} />}
						label="轨迹"
						onClick={() => dispatch({ type: "page", page: "trace" })}
					/>
					<NavButton
						active={page === "sessions"}
						icon={<ArchiveIcon size={15} />}
						label="会话"
						onClick={() => dispatch({ type: "page", page: "sessions" })}
					/>
					<NavButton
						active={page === "settings"}
						icon={<SettingsIcon size={15} />}
						label="设置"
						onClick={() => dispatch({ type: "page", page: "settings" })}
					/>
				</nav>
			</div>

			<div className="sidebar-scroll">
				<div className="side-section-title">
					<span>任务</span>
					{state.sessions.length > 0 ? <small>{state.sessions.length}</small> : null}
				</div>
				<div className="session-list">
					{state.sessions.length === 0 ? <div className="side-empty">还没有会话</div> : null}
					{state.sessions.map((meta) => (
						<SessionRow
							key={meta.id}
							meta={meta}
							selected={page === "chat" && current?.meta.id === meta.id}
							running={state.runStates[meta.id] === "running"}
							onSelect={() => {
								void actions.activateSession(meta.id).catch(report);
							}}
						/>
					))}
				</div>
			</div>

			<div className="sidebar-footer">
				<button
					className="project-button"
					title={project?.root ?? "打开项目"}
					onClick={() => {
						if (state.current?.running === true && !window.confirm("当前回合仍在运行，打开其他项目会中止它。继续？")) {
							return;
						}
						void actions.openProjectDialog().catch(report);
					}}
				>
					<FolderIcon size={15} />
					<span className="project-name">{project?.name ?? "打开项目"}</span>
					<FolderPlusIcon size={14} className="project-action" />
				</button>
				<button
					className="icon-button"
					title={themeTitle(state.theme)}
					aria-label={themeTitle(state.theme)}
					onClick={() => {
						void cycleTheme(state.theme, dispatch);
					}}
				>
					{state.theme === "dark" ? (
						<MoonIcon size={15} />
					) : state.theme === "light" ? (
						<SunIcon size={15} />
					) : state.resolvedTheme === "dark" ? (
						<MoonIcon size={15} />
					) : (
						<SunIcon size={15} />
					)}
				</button>
			</div>
		</aside>
	);
}

function SessionRow({
	meta,
	selected,
	running,
	onSelect,
}: {
	readonly meta: SessionMeta;
	readonly selected: boolean;
	readonly running: boolean;
	readonly onSelect: () => void;
}): JSX.Element {
	return (
		<button className={`session-row ${selected ? "is-selected" : ""}`} onClick={onSelect} title={meta.title}>
			<span className={`session-dot ${running ? "is-running" : ""}`} />
			<span className="session-title">{meta.title}</span>
			<span className="session-time">{relativeTime(meta.updatedAt)}</span>
		</button>
	);
}

function NavButton({
	active,
	icon,
	label,
	onClick,
}: {
	readonly active: boolean;
	readonly icon: JSX.Element;
	readonly label: string;
	readonly onClick: () => void;
}): JSX.Element {
	return (
		<button className={`nav-row ${active ? "is-active" : ""}`} onClick={onClick}>
			{icon}
			<span>{label}</span>
		</button>
	);
}

function themeTitle(theme: "auto" | "light" | "dark"): string {
	if (theme === "auto") return "主题：跟随系统";
	if (theme === "light") return "主题：浅色";
	return "主题：深色";
}

async function cycleTheme(
	current: "auto" | "light" | "dark",
	dispatch: ReturnType<typeof useApp>["dispatch"],
): Promise<void> {
	const next = current === "auto" ? "light" : current === "light" ? "dark" : "auto";
	try {
		const settings = await call(window.moros.settingsUpdate({ ui: { theme: next } }));
		dispatch({ type: "settings", settings });
	} catch (error) {
		dispatch({ type: "notice", level: "error", message: errorMessage(error) });
	}
}
