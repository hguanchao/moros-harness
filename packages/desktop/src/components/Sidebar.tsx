import { useEffect, useRef, useState, type JSX, type ReactNode } from "react";
import { createPortal } from "react-dom";

import type { SessionMeta } from "@moros/core/session/session-manager.ts";
import type { ProjectRef, WorkspaceTarget } from "../shared/contract.ts";
import { useDesktopActions } from "../hooks/actions.ts";
import { call, errorMessage } from "../api/api.ts";
import {
	AlertIcon,
	ArchiveIcon,
	CheckIcon,
	CopyIcon,
	FolderIcon,
	FolderOpenIcon,
	FolderPlusIcon,
	ListChevronsDownUpIcon,
	ListChevronsUpDownIcon,
	ListChecksIcon,
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
import { groupByTarget, type BatchEntry } from "../utils/batch.ts";
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
	/** 菜单锚点：触发按钮的视口矩形，菜单经 portal 渲染到 body 后据此定位，避开侧栏折叠容器的 overflow 裁剪。 */
	const [menuAnchor, setMenuAnchor] = useState<DOMRect | undefined>(undefined);
	const [copiedRoot, setCopiedRoot] = useState<string | undefined>(undefined);
	const copyTimer = useRef<number | undefined>(undefined);
	const [renaming, setRenaming] = useState<{ meta: SessionMeta; target: WorkspaceTarget; title: string } | undefined>(
		undefined,
	);
	// 批量模式：selection 保存当前勾选的会话归属，key 为会话 id；进入时预选触发菜单的那一行。
	const [batchMode, setBatchMode] = useState(false);
	const [selection, setSelection] = useState<ReadonlyMap<string, WorkspaceTarget>>(new Map());
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

	// 批量模式的候选集与下方渲染同源：任务根会话 + 各项目会话，每个 id 只归属一处。
	const visibleTargets = new Map<string, WorkspaceTarget>();
	if (taskRoot !== undefined) {
		for (const meta of tasks) visibleTargets.set(meta.id, { kind: "tasks" });
	}
	for (const project of projects) {
		const target: WorkspaceTarget = { kind: "project", root: project.root };
		for (const meta of orderedForRoot(sessions, project.root, platform, pinned)) {
			visibleTargets.set(meta.id, target);
		}
	}
	// 只保留仍然可见的会话，避免外部变更导致对已消失的 id 执行操作。
	const selectedEntries: BatchEntry[] = [];
	for (const [id, target] of selection) {
		if (visibleTargets.has(id)) selectedEntries.push({ id, target: visibleTargets.get(id) ?? target });
	}
	const allSelected = visibleTargets.size > 0 && selectedEntries.length === visibleTargets.size;

	useEffect(() => () => window.clearTimeout(copyTimer.current), []);

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
		console.error(`[moros] ${errorMessage(error)}`);
	};
	const mutate = async (action: () => Promise<unknown>, _success?: string): Promise<boolean> => {
		try {
			await action();
			dispatch({ type: "sessions-changed" });
			return true;
		} catch (error) {
			report(error);
			return false;
		}
	};

	const exitBatchMode = (): void => {
		setBatchMode(false);
		setSelection(new Map());
	};
	const toggleSelected = (id: string, target: WorkspaceTarget): void => {
		setSelection((previous) => {
			const next = new Map(previous);
			if (next.has(id)) next.delete(id);
			else next.set(id, target);
			return next;
		});
	};
	const toggleAllSelected = (): void => {
		setSelection(allSelected ? new Map() : new Map(visibleTargets));
	};

	// 归档为单条 IPC，按归属分组后并行发出；删除 IPC 本身支持批量，同样按归属分组以通过根校验。
	const runBatchArchive = async (entries: readonly BatchEntry[]): Promise<void> => {
		const groups = groupByTarget(entries);
		const ok = await mutate(async () => {
			for (const group of groups.values()) {
				await Promise.all(group.ids.map((id) => call(window.moros.sessionsArchiveInTarget(id, true, group.target))));
			}
		}, `已归档 ${entries.length} 项`);
		if (ok) exitBatchMode();
	};
	const runBatchDelete = async (entries: readonly BatchEntry[]): Promise<void> => {
		const confirmed = await confirm({
			title: "批量删除会话",
			message: `删除选中的 ${entries.length} 个会话？该操作不可恢复。`,
			confirmLabel: "删除",
			danger: true,
		});
		if (!confirmed) return;
		const groups = groupByTarget(entries);
		const ok = await mutate(async () => {
			for (const group of groups.values()) {
				await call(window.moros.sessionsDeleteInTarget(group.ids, group.target));
			}
		}, `已删除 ${entries.length} 项`);
		if (ok) exitBatchMode();
	};

	// 批量模式中 Escape 退出，避免与菜单的 Escape 关闭逻辑冲突（菜单关闭只改 openMenu）。
	useEffect(() => {
		if (!batchMode) return;
		const onKeyDown = (event: KeyboardEvent): void => {
			if (event.key === "Escape") {
				setBatchMode(false);
				setSelection(new Map());
			}
		};
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, [batchMode]);

	const toggleMenu = (key: MenuKey, button: HTMLButtonElement): void => {
		if (openMenu === key) {
			setOpenMenu(undefined);
			return;
		}
		setMenuAnchor(button.getBoundingClientRect());
		setOpenMenu(key);
	};
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
		const isChecked = selection.has(meta.id);
		const isPinned = pinned.includes(meta.id);
		// 行内活状态按优先级：执行中 > 等待审批 > 置顶标记
		const runState = state.runStates[meta.id];
		const isRunning = runState === "running";
		const isPaused = runState === "paused";
		const slotStatus = isRunning ? "运行中" : isPaused ? "等待审批" : isPinned ? "已置顶" : undefined;
		return (
			<div
				className={`sidebar-row ${selected ? "is-selected" : ""} ${batchMode && isChecked ? "is-checked" : ""}`}
				key={meta.id}
			>
				<button
					className="row-main session-row"
					aria-pressed={batchMode ? isChecked : undefined}
					onClick={() => (batchMode ? toggleSelected(meta.id, rowTarget.target) : select(meta.id))}
				>
					{/* 批量模式显示勾选框；否则单一图标槽：执行中转圈 / 待审批警示 / 置顶图钉，标题列始终对齐 */}
					{batchMode ? (
						<span className={`batch-checkbox ${isChecked ? "is-checked" : ""}`} aria-hidden="true">
							{isChecked ? <CheckIcon size={13} strokeWidth={3} /> : null}
						</span>
					) : (
						<span
							className={`row-icon-slot ${isRunning ? "session-running" : ""} ${isPaused ? "session-paused" : ""}`}
							aria-hidden={slotStatus === undefined}
							{...(slotStatus === undefined
								? {}
								: { role: "status", "aria-label": slotStatus, "data-tooltip": slotStatus })}
						>
							{isRunning ? (
								<span className="spinner small" />
							) : isPaused ? (
								<AlertIcon size={14} />
							) : isPinned ? (
								<PinIcon size={14} />
							) : null}
						</span>
					)}
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
					data-tooltip="操作"
					onPointerDown={(event) => event.stopPropagation()}
					onClick={(event) => toggleMenu(menuKey, event.currentTarget)}
				>
					<MoreIcon size={14} />
				</button>
				{openMenu === menuKey ? (
					<RowMenu anchor={menuAnchor}>
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
						<div className="row-menu-separator" role="separator" />
						<MenuItem
							icon={<ListChecksIcon size={14} />}
							label="批量操作"
							onClick={() => {
								setOpenMenu(undefined);
								setBatchMode(true);
								setSelection(new Map([[meta.id, rowTarget.target]]));
							}}
						/>
					</RowMenu>
				) : null}
			</div>
		);
	};

	return (
		<aside
			className={`sidebar ${open ? "" : "is-collapsed"} ${batchMode ? "is-batch-mode" : ""}`}
			inert={!open}
			aria-hidden={!open}
		>
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
						data-tooltip="新建任务"
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
							data-tooltip={allProjectsExpanded ? "收起所有项目任务" : "展开所有项目任务"}
							disabled={projects.length === 0}
							onClick={toggleAllProjects}
						>
							{allProjectsExpanded ? <ListChevronsDownUpIcon size={14} /> : <ListChevronsUpDownIcon size={14} />}
						</button>
						<button
							className="group-add"
							aria-label="添加项目"
							data-tooltip="添加项目"
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
									data-tooltip={project.root}
									onClick={() => setExpanded((previous) => ({ ...previous, [project.root]: !isExpanded }))}
								>
									{isExpanded ? <FolderOpenIcon size={16} /> : <FolderIcon size={16} />}
									<span className="project-name">{project.name}</span>
								</button>
								<button
									className="project-add"
									aria-label={`在 ${project.name} 中新建任务`}
									data-tooltip="在项目中新建任务"
									onClick={() => actions.newTaskInProject(projectRef)}
								>
									<MessagePlusIcon size={14} />
								</button>
								<button
									className="row-menu-trigger"
									aria-label={`${project.name} 操作`}
									aria-haspopup="menu"
									aria-expanded={openMenu === menuKey}
									data-tooltip="操作"
									onPointerDown={(event) => event.stopPropagation()}
									onClick={(event) => toggleMenu(menuKey, event.currentTarget)}
								>
									<MoreIcon size={14} />
								</button>
								{openMenu === menuKey ? (
									<RowMenu anchor={menuAnchor}>
										<MenuItem
											icon={<FolderOpenIcon size={14} />}
											label="打开文件夹"
											onClick={() => {
												setOpenMenu(undefined);
												void mutate(() => call(window.moros.openProjectFolder(project.root)));
											}}
										/>
										<MenuItem
											icon={copiedRoot === project.root ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
											label={copiedRoot === project.root ? "已复制" : "复制路径"}
											onClick={() => {
												void call(window.moros.copyProjectPath(project.root)).then(() => {
													setCopiedRoot(project.root);
													window.clearTimeout(copyTimer.current);
													copyTimer.current = window.setTimeout(() => {
														setCopiedRoot(undefined);
														setOpenMenu(undefined);
													}, 900);
												}, report);
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
							<div className={`project-tasks ${isExpanded ? "is-expanded" : ""}`}>
								{/* 内容常驻挂载（折叠时 visibility 隐藏），grid-rows 过渡才有高度动画 */}
								<div className="project-tasks-inner">
									{items.length === 0 ? <div className="side-empty">暂无任务</div> : null}
									{items.map((meta) => sessionRow(meta, { target, project: projectRef }, `project:${project.root}`))}
								</div>
							</div>
						</div>
					);
				})}
			</div>
			<div className="sidebar-footer">
				{batchMode ? (
					<div className="batch-bar">
						<label className="batch-select-all">
							<input type="checkbox" aria-label="全选" checked={allSelected} onChange={toggleAllSelected} />
							<span>全选</span>
						</label>
						<span className="batch-count">已选 {selectedEntries.length} 项</span>
						<div className="batch-actions">
							<button className="batch-action" data-tooltip="取消批量操作" onClick={exitBatchMode}>
								<XIcon size={14} />
							</button>
							<button
								className="batch-action"
								data-tooltip="归档所选"
								disabled={selectedEntries.length === 0}
								onClick={() => void runBatchArchive(selectedEntries)}
							>
								<ArchiveIcon size={14} />
							</button>
							<button
								className="batch-action is-danger"
								data-tooltip="删除所选"
								disabled={selectedEntries.length === 0}
								onClick={() => void runBatchDelete(selectedEntries)}
							>
								<TrashIcon size={14} />
							</button>
						</div>
					</div>
				) : (
					<button
						className="settings-button"
						aria-label="设置"
						disabled={!state.ready}
						onClick={() => dispatch({ type: "page", page: "settings" })}
					>
						<SettingsIcon size={16} />
						<span>设置</span>
					</button>
				)}
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

function RowMenu({
	anchor,
	children,
}: {
	/** 触发按钮的视口矩形；菜单渲染到 body 后据此定位。 */
	readonly anchor: DOMRect | undefined;
	readonly children: ReactNode;
}): JSX.Element {
	// 菜单挂在 body 而非侧栏的折叠容器内，避免 overflow:hidden 裁掉下方菜单项。
	// 定位用 fixed + 触发按钮矩形，超出视口底部时向上翻转。
	const menuRef = useRef<HTMLDivElement>(null);
	const [style, setStyle] = useState<{ top: number; left: number }>({ top: -9999, left: -9999 });
	useEffect(() => {
		if (anchor === undefined || menuRef.current === null) return;
		const menu = menuRef.current;
		const gap = 4;
		const rightAligned = anchor.right - menu.offsetWidth;
		const left = Math.max(8, rightAligned);
		const below = anchor.bottom + gap;
		const top =
			below + menu.offsetHeight > window.innerHeight ? Math.max(8, anchor.top - menu.offsetHeight - gap) : below;
		setStyle({ top, left });
	}, [anchor]);
	return createPortal(
		<div
			ref={menuRef}
			className="row-menu menu-portal"
			role="menu"
			style={style}
			onPointerDown={(event) => event.stopPropagation()}
			onClick={(event) => event.stopPropagation()}
		>
			{children}
		</div>,
		document.body,
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
