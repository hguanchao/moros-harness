import { useState, type JSX } from "react";

import type { SessionMeta } from "#src/core/session/session-manager.ts";
import { useDesktopActions } from "#src/desktop/renderer/actions.ts";
import { call, errorMessage } from "#src/desktop/renderer/api.ts";
import {
	ArchiveIcon,
	FolderIcon,
	FolderOpenIcon,
	FolderPlusIcon,
	MessagePlusIcon,
	MoonIcon,
	SettingsIcon,
	SunIcon,
} from "#src/desktop/renderer/icons.tsx";
import { useApp } from "#src/desktop/renderer/state.tsx";

/** 侧栏：品牌、新建任务、项目树与会话列表，工具行沿用复刻稿的 workspace-head。 */
export function Sidebar(): JSX.Element {
	const { state, dispatch } = useApp();
	const actions = useDesktopActions();
	const [expanded, setExpanded] = useState(true);
	const { project, current, page } = state;

	const report = (error: unknown): void => {
		dispatch({ type: "notice", level: "error", message: errorMessage(error) });
	};

	const openProject = (): void => {
		if (state.current?.running === true && !window.confirm("当前回合仍在运行，打开其他项目会中止它。继续？")) {
			return;
		}
		void actions.openProjectDialog().catch(report);
	};

	return (
		<aside className="sidebar">
			<div className="brand">
				<span className="brand-name">Moros</span>
				<span className="brand-tag">Harness</span>
			</div>

			<div className="sidebar-body">
				<div className="side-menu">
					<button
						className="menu-row"
						disabled={project === undefined}
						onClick={() => {
							void actions.createSession().catch(report);
						}}
					>
						<MessagePlusIcon size={16} />
						<span className="menu-label">新建任务</span>
					</button>
				</div>

				<div className="workspace-head">
					<span>项目</span>
					<div className="workspace-tools">
						<button className="icon-button" aria-label="打开项目" title="打开项目" onClick={openProject}>
							<FolderPlusIcon size={15} />
						</button>
						<button
							className="icon-button"
							aria-label="会话管理"
							title="会话管理"
							disabled={project === undefined}
							onClick={() => dispatch({ type: "page", page: "sessions" })}
						>
							<ArchiveIcon size={15} />
						</button>
						<button
							className="icon-button"
							aria-label={themeTitle(state.theme)}
							title={themeTitle(state.theme)}
							disabled={project === undefined}
							onClick={() => {
								void cycleTheme(state.theme, dispatch);
							}}
						>
							{state.theme === "dark" || (state.theme === "auto" && state.resolvedTheme === "dark") ? (
								<MoonIcon size={15} />
							) : (
								<SunIcon size={15} />
							)}
						</button>
						<button
							className="icon-button"
							aria-label="设置"
							title="设置"
							disabled={project === undefined}
							onClick={() => dispatch({ type: "page", page: "settings" })}
						>
							<SettingsIcon size={15} />
						</button>
					</div>
				</div>

				{project === undefined ? (
					<button className="project-row" onClick={openProject}>
						<FolderPlusIcon size={16} />
						<span className="project-name">打开项目</span>
					</button>
				) : (
					<div className={`project-group ${expanded ? "is-expanded" : ""}`}>
						<button className="project-row" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
							{expanded ? <FolderOpenIcon size={16} /> : <FolderIcon size={16} />}
							<span className="project-name">{project.name}</span>
						</button>
						{expanded ? (
							<div className="project-tasks">
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
						) : null}
					</div>
				)}
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
