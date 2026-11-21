import { useEffect, useRef, useState, type JSX, type ReactNode } from "react";
import { createPortal } from "react-dom";

import type { SessionMeta } from "@moros/core/session/session-manager.ts";
import type { ProjectRef, WorkspaceTarget } from "../shared/contract.ts";
import { useDesktopActions } from "../hooks/actions.ts";
import { call, errorMessage } from "../api/api.ts";
import {
	AlertIcon,
	ArchiveIcon,
	CopyIcon,
	FolderIcon,
	FolderOpenIcon,
	FolderPlusIcon,
	ListChevronsDownUpIcon,
	ListChevronsUpDownIcon,
	MessagePlusIcon,
	MoreIcon,
	PencilIcon,
	PinIcon,
	PinOffIcon,
	SettingsIcon,
	TrashIcon,
	XIcon,
} from "./Icons.tsx";
import { useConfirm } from "./ConfirmDialog.tsx";
import { useApp } from "../store/state.tsx";
import { relativeTime } from "../utils/format.ts";
import { workspaceRootsMatch } from "../utils/workspace.ts";

type MenuKey = string;

interface RowTarget {
	readonly target: WorkspaceTarget;
	/** 明确项目归属；任务根为 null。 */
	readonly project: ProjectRef | null;
}

/** 侧栏：新任务草稿、未关联项目的任务与项目会话；设置固定在底部。 */
export function Sidebar({ open }: { readonly open: boolean }): JSX.Element {
	const { state, dispatch } = useApp();
	const { confirm } = useConfirm();
	const actions = useDesktopActions();
	const [expanded, setExpanded] = useState<Readonly<Record<string, boolean>>>({});
	const [openMenu, setOpenMenu] = useState<MenuKey | undefined>(undefined);
	const [renaming, setRenaming] = useState<{ meta: SessionMeta; target: WorkspaceTarget; title: string } | undefined>(
		undefined,
	);
	const platform = state.app?.platform ?? "win32";
	const taskRoot = state.app?.taskRoot;
	const sessions = state.sessions.filter((meta) => !meta.archived);
	const pinned = state.pinnedSessionIds;
	const tasks = taskRoot === undefined ? [] : orderedForRoot(sessions, taskRoot, platform, pinned);
	const projects = (state.app?.recentProjects ?? []).filter(
		(project) => taskRoot === undefined || !workspaceRootsMatch(project.root, taskRoot, platform),
	);
	// 项目默认跟随当前活动项目展开；显式切换过的项目以 expanded 为准。
	const isProjectExpanded = (root: string): boolean => {
		const isActive =
			state.project?.target.kind === "project" && workspaceRootsMatch(state.project.root, root, platform);
		return expanded[root] ?? isActive;
	};
	const allProjectsExpanded = projects.length > 0 && projects.every((project) => isProjectExpanded(project.root));
	const toggleAllProjects = (): void => {
		const next = !allProjectsExpanded;
		const nextExpanded = { ...expanded };
		for (const project of projects) nextExpanded[project.root] = next;
		setExpanded(nextExpanded);
	};

	useEffect(() => {
		if (openMenu === undefined) return;
		const close = (): void => setOpenMenu(undefined);
		const onKeyDown = (event: KeyboardEvent): void => {
			if (event.key === "Escape") close();
		};
		document.addEventListener("pointerdown", close);
		document.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("pointerdown", close);
			document.removeEventListener("keydown", onKeyDown);
		};
	}, [openMenu]);

	const report = (error: unknown): void => {
		dispatch({ type: "notice", level: "error", message: errorMessage(error) });
	};
	const mutate = async (action: () => Promise<unknown>, success?: string): Promise<boolean> => {
		try {
			await action();
			dispatch({ type: "sessions-changed" });
			if (success !== undefined) dispatch({ type: "notice", level: "info", message: success });
			return true;
		} catch (error) {
			report(error);
			return false;
		}
	};

	const toggleMenu = (key: MenuKey): void => setOpenMenu((current) => (current === key ? undefined : key));
	const select = (id: string): void => {
		// 已选中的会话不再重复激活，避免重复拉取事件与刷新导致闪烁。
		if (state.current?.meta.id === id) return;
		void actions.activateSession(id).catch(report);
	};

	const sessionRow = (meta: SessionMeta, rowTarget: RowTarget, keyPrefix: string): JSX.Element => {
		const menuKey = `${keyPrefix}:${meta.id}`;
		const selected =
			state.current?.meta.id === meta.id &&
			workspaceRootsMatch(state.current.meta.projectRoot, meta.projectRoot, platform);
		const isPinned = pinned.includes(meta.id);
		// 行内活状态按优先级：执行中 > 等待审批 > 置顶标记
		const runState = state.runStates[meta.id];
		const isRunning = runState === "running";
		const isPaused = runState === "paused";
		const slotStatus = isRunning ? "运行中" : isPaused ? "等待审批" : isPinned ? "已置顶" : undefined;
		return (
			<div className={`sidebar-row ${selected ? "is-selected" : ""}`} key={meta.id}>
				<button className="row-main session-row" onClick={() => select(meta.id)}>
					{/* 单一图标槽：执行中转圈 / 待审批警示 / 置顶图钉，标题列始终对齐 */}
					<span
						className={`row-icon-slot ${isRunning ? "session-running" : ""} ${isPaused ? "session-paused" : ""}`}
						aria-hidden={slotStatus === undefined}
						{...(slotStatus === undefined ? {} : { role: "status", "aria-label": slotStatus, title: slotStatus })}
					>
						{isRunning ? (
							<span className="spinner small" />
						) : isPaused ? (
							<AlertIcon size={14} />
						) : isPinned ? (
							<PinIcon size={14} />
						) : null}
					</span>
					<MarqueeTitle title={meta.title} />
				</button>
				<span className="row-trailing">
					<span className="session-time">{relativeTime(meta.updatedAt)}</span>
				</span>
				<button
					className="row-menu-trigger"
					aria-label={`${meta.title} 操作`}
					aria-haspopup="menu"
					aria-expanded={openMenu === menuKey}
					title="操作"
					onPointerDown={(event) => event.stopPropagation()}
					onClick={() => toggleMenu(menuKey)}
				>
					<MoreIcon size={14} />
				</button>
				{openMenu === menuKey ? (
					<RowMenu>
						<MenuItem
							icon={<PencilIcon size={14} />}
							label="重命名"
							onClick={() => {
								setOpenMenu(undefined);
								setRenaming({ meta, target: rowTarget.target, title: meta.title });
							}}
						/>
						<MenuItem
							icon={isPinned ? <PinOffIcon size={14} /> : <PinIcon size={14} />}
							label={isPinned ? "取消置顶" : "置顶"}
							onClick={() => {
								setOpenMenu(undefined);
								void mutate(() => call(window.moros.sessionPin(meta.id, !isPinned)));
							}}
						/>
						<MenuItem
							icon={<ArchiveIcon size={14} />}
							label={meta.archived ? "取消归档" : "归档"}
							onClick={() => {
								setOpenMenu(undefined);
								void mutate(
									() => call(window.moros.sessionsArchiveInTarget(meta.id, !meta.archived, rowTarget.target)),
									meta.archived ? "已取消归档" : "已归档",
								);
							}}
						/>
						<MenuItem
							icon={<TrashIcon size={14} />}
							label="删除"
							danger
							onClick={async () => {
								setOpenMenu(undefined);
								const confirmed = await confirm({
									title: "删除会话",
									message: `删除会话「${meta.title}」？该操作不可恢复。`,
									confirmLabel: "删除",
									danger: true,
								});
								if (!confirmed) return;
								void mutate(() => call(window.moros.sessionsDeleteInTarget([meta.id], rowTarget.target)), "会话已删除");
							}}
						/>
					</RowMenu>
				) : null}
			</div>
		);
	};

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
					<button
						className="group-add"
						aria-label="在任务中新建任务"
						title="新建任务"
						onClick={() => actions.newTaskInProject(null)}
					>
						<MessagePlusIcon size={14} />
					</button>
				</div>
				<div className="task-list">
					{tasks.length === 0 ? <div className="side-empty">暂无任务</div> : null}
					{tasks.map((meta) => sessionRow(meta, { target: { kind: "tasks" }, project: null }, "session"))}
				</div>

				<div className="workspace-head">
					<span>项目</span>
					<div className="workspace-head-actions">
						<button
							className="group-add"
							aria-label={allProjectsExpanded ? "收起所有项目任务" : "展开所有项目任务"}
							title={allProjectsExpanded ? "收起所有项目任务" : "展开所有项目任务"}
							disabled={projects.length === 0}
							onClick={toggleAllProjects}
						>
							{allProjectsExpanded ? <ListChevronsDownUpIcon size={14} /> : <ListChevronsUpDownIcon size={14} />}
						</button>
						<button
							className="group-add"
							aria-label="添加项目"
							title="添加项目"
							onClick={() => void actions.openProjectDialog().catch(report)}
						>
							<FolderPlusIcon size={14} />
						</button>
					</div>
				</div>
				{projects.length === 0 ? <div className="side-empty">暂无项目</div> : null}
				{projects.map((project) => {
					const target: WorkspaceTarget = { kind: "project", root: project.root };
					const projectRef: ProjectRef = { root: project.root, name: project.name };
					const isExpanded = isProjectExpanded(project.root);
					const items = orderedForRoot(sessions, project.root, platform, pinned);
					const menuKey = `project:${project.root}`;
					return (
						<div key={project.root} className={`project-group ${isExpanded ? "is-expanded" : ""}`}>
							<div className="sidebar-row project-line">
								<button
									className="row-main project-row"
									aria-expanded={isExpanded}
									title={project.root}
									onClick={() => setExpanded((previous) => ({ ...previous, [project.root]: !isExpanded }))}
								>
									{isExpanded ? <FolderOpenIcon size={16} /> : <FolderIcon size={16} />}
									<span className="project-name">{project.name}</span>
								</button>
								<button
									className="project-add"
									aria-label={`在 ${project.name} 中新建任务`}
									title="在项目中新建任务"
									onClick={() => actions.newTaskInProject(projectRef)}
								>
									<MessagePlusIcon size={14} />
								</button>
								<button
									className="row-menu-trigger"
									aria-label={`${project.name} 操作`}
									aria-haspopup="menu"
									aria-expanded={openMenu === menuKey}
									title="操作"
									onPointerDown={(event) => event.stopPropagation()}
									onClick={() => toggleMenu(menuKey)}
								>
									<MoreIcon size={14} />
								</button>
								{openMenu === menuKey ? (
									<RowMenu>
										<MenuItem
											icon={<FolderOpenIcon size={14} />}
											label="打开文件夹"
											onClick={() => {
												setOpenMenu(undefined);
												void mutate(() => call(window.moros.openProjectFolder(project.root)));
											}}
										/>
										<MenuItem
											icon={<CopyIcon size={14} />}
											label="复制路径"
											onClick={() => {
												setOpenMenu(undefined);
												void mutate(() => call(window.moros.copyProjectPath(project.root)));
											}}
										/>
										<MenuItem
											icon={<XIcon size={14} />}
											label="从侧栏移除"
											danger
											onClick={() => {
												setOpenMenu(undefined);
												void mutate(async () => {
													const recent = await call(window.moros.forgetProject(project.root));
													dispatch({ type: "recent-projects", projects: recent });
												}, "已从侧栏移除");
											}}
										/>
									</RowMenu>
								) : null}
							</div>
							<div className="project-tasks">
								{isExpanded && items.length === 0 ? <div className="side-empty">暂无任务</div> : null}
								{isExpanded
									? items.map((meta) => sessionRow(meta, { target, project: projectRef }, `project:${project.root}`))
									: null}
							</div>
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

			{renaming !== undefined ? (
				<InlineRename
					title={renaming.title}
					onCancel={() => setRenaming(undefined)}
					onSave={(title) => {
						const { meta, target } = renaming;
						setRenaming(undefined);
						void mutate(() => call(window.moros.sessionsRenameInTarget(meta.id, title, target)), "已重命名");
					}}
				/>
			) : null}
		</aside>
	);
}

/**
 * 任务标题：空间足够时静态显示；溢出时鼠标悬停向左滚动，展示完整标题。
 * 只有溢出时渲染第二份文本用于无缝循环，短标题没有动画开销。
 */
function MarqueeTitle({ title }: { readonly title: string }): JSX.Element {
	const containerRef = useRef<HTMLSpanElement>(null);
	const [overflowing, setOverflowing] = useState(false);
	const [scrolling, setScrolling] = useState(false);
	const timer = useRef<number | undefined>(undefined);

	useEffect(() => {
		const container = containerRef.current;
		const text = container?.querySelector<HTMLElement>(".session-title-text");
		if (container === null || text === undefined || text === null) return;
		// 内层文本自适应内容宽度，用它的宽度与可见容器比较判断是否溢出。
		const measure = (): void => setOverflowing(text.scrollWidth > container.clientWidth + 1);
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(container);
		return () => observer.disconnect();
	}, [title]);

	// 悬停 0.5 秒后开始滚动；移出立即停止。
	const onEnter = (): void => {
		if (!overflowing) return;
		timer.current = window.setTimeout(() => setScrolling(true), 500);
	};
	const onLeave = (): void => {
		if (timer.current !== undefined) window.clearTimeout(timer.current);
		setScrolling(false);
	};
	useEffect(
		() => () => {
			if (timer.current !== undefined) window.clearTimeout(timer.current);
		},
		[],
	);

	return (
		<span
			ref={containerRef}
			className={`session-title ${overflowing ? "is-marquee" : ""} ${scrolling ? "is-scrolling" : ""}`}
			onMouseEnter={onEnter}
			onMouseLeave={onLeave}
		>
			<span className="session-title-track">
				<span className="session-title-text">{title}</span>
				{overflowing ? (
					<span className="session-title-text" aria-hidden="true">
						{title}
					</span>
				) : null}
			</span>
		</span>
	);
}

/** 组内先按置顶顺序，再按更新时间排列；置顶只在所属组内生效。 */
function orderedForRoot(
	sessions: readonly SessionMeta[],
	root: string,
	platform: NodeJS.Platform,
	pinned: readonly string[],
): SessionMeta[] {
	return sessions
		.filter((meta) => workspaceRootsMatch(meta.projectRoot, root, platform))
		.sort((left, right) => {
			const leftPinned = pinned.indexOf(left.id);
			const rightPinned = pinned.indexOf(right.id);
			if (leftPinned !== -1 && rightPinned !== -1) return leftPinned - rightPinned;
			if (leftPinned !== -1) return -1;
			if (rightPinned !== -1) return 1;
			return right.updatedAt.localeCompare(left.updatedAt);
		});
}

function RowMenu({ children }: { readonly children: ReactNode }): JSX.Element {
	return (
		<div
			className="row-menu"
			role="menu"
			onPointerDown={(event) => event.stopPropagation()}
			onClick={(event) => event.stopPropagation()}
		>
			{children}
		</div>
	);
}

function MenuItem({
	icon,
	label,
	onClick,
	danger = false,
}: {
	readonly icon: ReactNode;
	readonly label: string;
	readonly onClick: () => void;
	readonly danger?: boolean;
}): JSX.Element {
	return (
		<button className={`row-menu-item ${danger ? "is-danger" : ""}`} role="menuitem" onClick={onClick}>
			{icon}
			<span>{label}</span>
		</button>
	);
}

function InlineRename({
	title,
	onSave,
	onCancel,
}: {
	readonly title: string;
	readonly onSave: (title: string) => void;
	readonly onCancel: () => void;
}): JSX.Element {
	const [value, setValue] = useState(title);
	const inputRef = useRef<HTMLInputElement>(null);
	useEffect(() => {
		inputRef.current?.focus();
		inputRef.current?.select();
	}, []);
	const commit = (): void => {
		const trimmed = value.trim();
		if (trimmed.length === 0 || trimmed === title) return onCancel();
		onSave(trimmed);
	};
	return createPortal(
		<div className="modal-backdrop" onClick={onCancel}>
			<div className="rename-dialog" role="dialog" aria-label="重命名任务" onClick={(event) => event.stopPropagation()}>
				<div className="modal-head">
					<h2>重命名任务</h2>
					<button className="icon-button" aria-label="关闭" onClick={onCancel}>
						<XIcon size={16} />
					</button>
				</div>
				<input
					ref={inputRef}
					className="text-input"
					value={value}
					onChange={(event) => setValue(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === "Enter") commit();
						if (event.key === "Escape") onCancel();
					}}
				/>
				<div className="modal-actions">
					<button className="ghost-button" onClick={onCancel}>
						取消
					</button>
					<button className="primary-button" onClick={commit}>
						保存
					</button>
				</div>
			</div>
		</div>,
		document.body,
	);
}
