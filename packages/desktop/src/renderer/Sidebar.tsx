import { useState, type JSX } from "react";

import type { SessionMeta } from "@moros/core/session/session-manager.ts";
import { useDesktopActions } from "./actions.ts";
import { errorMessage } from "./api.ts";
import { MessagePlusIcon, SettingsIcon } from "./icons.tsx";
import { useApp } from "./state.tsx";

/** 侧栏：品牌、新建任务、项目树与会话列表；设置固定在底部图标按钮。 */
export function Sidebar({ open }: { readonly open: boolean }): JSX.Element {
	const { state, dispatch } = useApp();
	const actions = useDesktopActions();
	const [expanded, setExpanded] = useState(true);
	const { project, current } = state;

	const report = (error: unknown): void => {
		dispatch({ type: "notice", level: "error", message: errorMessage(error) });
	};

	return (
		<aside className={`sidebar ${open ? "" : "is-collapsed"}`} inert={!open} aria-hidden={!open}>
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
				</div>

				{project === undefined ? (
					<div className="side-empty">未打开项目</div>
				) : (
					<div className={`project-group ${expanded ? "is-expanded" : ""}`}>
						<button className="project-row" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
							<span className="project-name">{project.name}</span>
						</button>
						{expanded ? (
							<div className="project-tasks">
								{state.sessions.length === 0 ? <div className="side-empty">还没有会话</div> : null}
								{state.sessions.map((meta) => (
									<SessionRow
										key={meta.id}
										meta={meta}
										selected={current?.meta.id === meta.id}
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
			<div className="sidebar-footer">
				<button
					className="icon-button"
					aria-label="设置"
					title="设置"
					disabled={project === undefined}
					onClick={() => dispatch({ type: "page", page: "settings" })}
				>
					<SettingsIcon size={16} />
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
		</button>
	);
}
