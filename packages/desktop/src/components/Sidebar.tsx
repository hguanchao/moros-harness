import { useState, type JSX } from "react";

import type { SessionMeta } from "@moros/core/session/session-manager.ts";
import { useDesktopActions } from "../hooks/actions.ts";
import { errorMessage } from "../api/api.ts";
import { FolderIcon, FolderOpenIcon, MessagePlusIcon, SettingsIcon } from "./Icons.tsx";
import { useApp } from "../store/state.tsx";
import { workspaceRootsMatch } from "../utils/workspace.ts";

/** 侧栏：新任务草稿、未关联项目的任务与项目会话；设置固定在底部。 */
export function Sidebar({ open }: { readonly open: boolean }): JSX.Element {
	const { state, dispatch } = useApp();
	const actions = useDesktopActions();
	const [expanded, setExpanded] = useState<Readonly<Record<string, boolean>>>({});
	const platform = state.app?.platform ?? "win32";
	const taskRoot = state.app?.taskRoot;
	const sessions = state.sessions.filter((meta) => !meta.archived);
	const tasks = taskRoot === undefined ? [] : sessionsForRoot(sessions, taskRoot, platform);
	const projects = (state.app?.recentProjects ?? []).filter(
		(project) => taskRoot === undefined || !workspaceRootsMatch(project.root, taskRoot, platform),
	);

	const report = (error: unknown): void => {
		dispatch({ type: "notice", level: "error", message: errorMessage(error) });
	};
	const select = (id: string): void => {
		void actions.activateSession(id).catch(report);
	};
	const isSelected = (meta: SessionMeta): boolean =>
		state.current?.meta.id === meta.id &&
		workspaceRootsMatch(state.current.meta.projectRoot, meta.projectRoot, platform);

	return (
		<aside className={`sidebar ${open ? "" : "is-collapsed"}`} inert={!open} aria-hidden={!open}>
			<div className="brand">
				<span className="brand-name">Moros</span>
				<span className="brand-tag">Harness</span>
			</div>

			<div className="side-menu">
				<button className="menu-row" onClick={actions.newTask}>
					<MessagePlusIcon size={16} />
					<span className="menu-label">新建任务</span>
				</button>
			</div>

			<div className="sidebar-body">
				<div className="workspace-head">
					<span>任务</span>
				</div>
				<div className="task-list">
					{tasks.length === 0 ? <div className="side-empty">暂无任务</div> : null}
					{tasks.map((meta) => (
						<SessionRow key={meta.id} meta={meta} selected={isSelected(meta)} onSelect={() => select(meta.id)} />
					))}
				</div>

				<div className="workspace-head">
					<span>项目</span>
				</div>
				{projects.length === 0 ? <div className="side-empty">暂无项目</div> : null}
				{projects.map((project) => {
					const isActive =
						state.project?.target.kind === "project" && workspaceRootsMatch(state.project.root, project.root, platform);
					const isExpanded = expanded[project.root] ?? isActive;
					const items = sessionsForRoot(sessions, project.root, platform);
					return (
						<div key={project.root} className={`project-group ${isExpanded ? "is-expanded" : ""}`}>
							<button
								className="project-row"
								aria-expanded={isExpanded}
								title={project.root}
								onClick={() => setExpanded((previous) => ({ ...previous, [project.root]: !isExpanded }))}
							>
								{isExpanded ? <FolderOpenIcon size={16} /> : <FolderIcon size={16} />}
								<span className="project-name">{project.name}</span>
							</button>
							{isExpanded ? (
								<div className="project-tasks">
									{items.length === 0 ? <div className="side-empty">暂无任务</div> : null}
									{items.map((meta) => (
										<SessionRow
											key={meta.id}
											meta={meta}
											selected={isSelected(meta)}
											onSelect={() => select(meta.id)}
										/>
									))}
								</div>
							) : null}
						</div>
					);
				})}
			</div>
			<div className="sidebar-footer">
				<button
					className="settings-button"
					aria-label="设置"
					title="设置"
					disabled={!state.ready}
					onClick={() => dispatch({ type: "page", page: "settings" })}
				>
					<SettingsIcon size={16} />
					<span>设置</span>
				</button>
			</div>
		</aside>
	);
}

function sessionsForRoot(sessions: readonly SessionMeta[], root: string, platform: NodeJS.Platform): SessionMeta[] {
	return sessions
		.filter((meta) => workspaceRootsMatch(meta.projectRoot, root, platform))
		.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

function SessionRow({
	meta,
	selected,
	onSelect,
}: {
	readonly meta: SessionMeta;
	readonly selected: boolean;
	readonly onSelect: () => void;
}): JSX.Element {
	return (
		<button className={`session-row ${selected ? "is-selected" : ""}`} onClick={onSelect} title={meta.title}>
			<span className="session-title">{meta.title}</span>
		</button>
	);
}
