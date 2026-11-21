import { useEffect, useState, type JSX, type ReactNode } from "react";

import type { EventRecord } from "@moros/core/events/schema.ts";
import type { SessionMeta } from "@moros/core/session/session-manager.ts";
import { useDesktopActions } from "../hooks/actions.ts";
import { PageHeader } from "../components/PageHeader.tsx";
import { call, errorMessage } from "../api/api.ts";
import { firstLine, relativeTime } from "../utils/format.ts";
import {
	ArchiveIcon,
	DownloadIcon,
	ForkIcon,
	RefreshIcon,
	SearchIcon,
	TrashIcon,
	XIcon,
} from "../components/Icons.tsx";
import { useConfirm } from "../components/ConfirmDialog.tsx";
import { useApp } from "../store/state.tsx";

export function SessionsPage(): JSX.Element {
	const { state, dispatch } = useApp();
	const { confirm } = useConfirm();
	const actions = useDesktopActions();
	const [items, setItems] = useState<readonly SessionMeta[]>([]);
	const [query, setQuery] = useState("");
	const [includeArchived, setIncludeArchived] = useState(false);
	const [nextCursor, setNextCursor] = useState<number | undefined>(undefined);
	const [loading, setLoading] = useState(false);
	const [renaming, setRenaming] = useState<{ id: string; title: string } | undefined>(undefined);
	const [replay, setReplay] = useState<{ meta: SessionMeta; events: readonly EventRecord[] } | undefined>(undefined);
	const version = state.sessionsVersion;

	useEffect(() => {
		let cancelled = false;
		setLoading(true);
		void (async () => {
			try {
				const page = await call(
					window.moros.sessionsList({
						limit: 100,
						...(query.trim().length === 0 ? {} : { query: query.trim() }),
						includeArchived,
					}),
				);
				if (!cancelled) {
					setItems(page.items);
					setNextCursor(page.nextCursor);
				}
			} catch (error) {
				if (!cancelled) dispatch({ type: "notice", level: "error", message: errorMessage(error) });
			} finally {
				if (!cancelled) setLoading(false);
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [query, includeArchived, version, dispatch]);

	const loadMore = async (): Promise<void> => {
		if (nextCursor === undefined) return;
		try {
			const page = await call(
				window.moros.sessionsList({
					limit: 100,
					cursor: nextCursor,
					...(query.trim().length === 0 ? {} : { query: query.trim() }),
					includeArchived,
				}),
			);
			setItems((existing) => [...existing, ...page.items]);
			setNextCursor(page.nextCursor);
		} catch (error) {
			dispatch({ type: "notice", level: "error", message: errorMessage(error) });
		}
	};

	const mutate = async (action: () => Promise<unknown>, success?: string): Promise<boolean> => {
		try {
			await action();
			dispatch({ type: "sessions-changed" });
			if (success !== undefined) dispatch({ type: "notice", level: "info", message: success });
			return true;
		} catch (error) {
			dispatch({ type: "notice", level: "error", message: errorMessage(error) });
			return false;
		}
	};

	return (
		<div className="sessions-page">
			<PageHeader
				title="会话"
				subtitle="归档、回放、分叉与导出；与 TUI 共享同一份会话目录。"
				actions={
					<button
						className="ghost-button"
						onClick={() => {
							void actions.refreshSessions();
							dispatch({ type: "sessions-changed" });
						}}
					>
						<RefreshIcon size={14} />
						刷新
					</button>
				}
			/>

			<div className="sessions-toolbar">
				<label className="search-box">
					<SearchIcon size={14} />
					<input value={query} placeholder="搜索会话标题" onChange={(event) => setQuery(event.target.value)} />
				</label>
				<label className="toggle-label">
					<input
						type="checkbox"
						checked={includeArchived}
						onChange={(event) => setIncludeArchived(event.target.checked)}
					/>
					显示归档
				</label>
				{loading ? <span className="spinner small" /> : null}
			</div>

			<div className="sessions-table">
				<div className="session-table-head">
					<span>标题</span>
					<span>更新时间</span>
					<span>状态</span>
					<span>操作</span>
				</div>
				{items.length === 0 && !loading ? <div className="side-empty">没有匹配的会话</div> : null}
				{items.map((meta) => (
					<div className={`session-table-row ${state.current?.meta.id === meta.id ? "is-current" : ""}`} key={meta.id}>
						<button className="session-table-title" onClick={() => void actions.activateSession(meta.id)}>
							<span>{meta.title}</span>
							<small>{meta.id}</small>
						</button>
						<span className="session-table-time">{relativeTime(meta.updatedAt)}</span>
						<span className="session-table-state">
							{state.runStates[meta.id] === "running" ? <span className="pill accent is-running">运行中</span> : null}
							{meta.archived ? <span className="pill">已归档</span> : null}
							{state.current?.meta.id === meta.id ? <span className="pill accent">当前</span> : null}
							{meta.forkedFrom !== undefined ? <span className="pill">分叉</span> : null}
						</span>
						<span className="session-table-actions">
							<button className="icon-button" title="打开" onClick={() => void actions.activateSession(meta.id)}>
								<ArchiveIcon size={14} />
							</button>
							<button
								className="icon-button"
								title="重命名"
								onClick={() => setRenaming({ id: meta.id, title: meta.title })}
							>
								<span className="text-icon">Aa</span>
							</button>
							<button
								className="icon-button"
								title={meta.archived ? "取消归档" : "归档"}
								onClick={() =>
									void mutate(
										() => call(window.moros.sessionsArchive(meta.id, !meta.archived)),
										meta.archived ? "已取消归档" : "已归档",
									)
								}
							>
								<ArchiveIcon size={14} />
							</button>
							<button
								className="icon-button"
								title="分叉"
								onClick={() =>
									void mutate(async () => {
										await call(window.moros.sessionsFork(meta.id));
										actions.setPage("chat");
									})
								}
							>
								<ForkIcon size={14} />
							</button>
							<button
								className="icon-button"
								title="导出"
								onClick={() =>
									void mutate(async () => {
										const result = await call(window.moros.sessionsExport(meta.id));
										if (result !== null) {
											dispatch({ type: "notice", level: "info", message: `已导出到 ${result.path}` });
										}
									})
								}
							>
								<DownloadIcon size={14} />
							</button>
							<button
								className="icon-button"
								title="回放"
								onClick={() =>
									void mutate(async () => {
										const events = await call(window.moros.sessionsReplay(meta.id));
										setReplay({ meta, events });
									})
								}
							>
								<span className="text-icon">▶</span>
							</button>
							<button
								className="icon-button danger"
								title="删除"
								onClick={async () => {
									const confirmed = await confirm({
										title: "删除会话",
										message: `删除会话「${meta.title}」？该操作不可恢复。`,
										confirmLabel: "删除",
										danger: true,
									});
									if (!confirmed) return;
									void mutate(() => call(window.moros.sessionsDelete([meta.id])), "会话已删除");
								}}
							>
								<TrashIcon size={14} />
							</button>
						</span>
					</div>
				))}
				{nextCursor !== undefined ? (
					<button className="load-older" onClick={() => void loadMore()}>
						加载更多
					</button>
				) : null}
			</div>

			{renaming !== undefined ? (
				<Modal onClose={() => setRenaming(undefined)} title="重命名会话">
					<input
						className="text-input"
						value={renaming.title}
						autoFocus
						onChange={(event) => setRenaming({ ...renaming, title: event.target.value })}
						onKeyDown={(event) => {
							if (event.key === "Enter") {
								void mutate(() => call(window.moros.sessionsRename(renaming.id, renaming.title))).then((ok) => {
									if (ok) setRenaming(undefined);
								});
							}
							if (event.key === "Escape") setRenaming(undefined);
						}}
					/>
					<div className="modal-actions">
						<button className="ghost-button" onClick={() => setRenaming(undefined)}>
							取消
						</button>
						<button
							className="primary-button"
							onClick={() => {
								void mutate(() => call(window.moros.sessionsRename(renaming.id, renaming.title))).then((ok) => {
									if (ok) setRenaming(undefined);
								});
							}}
						>
							保存
						</button>
					</div>
				</Modal>
			) : null}

			{replay !== undefined ? (
				<Modal onClose={() => setReplay(undefined)} title={`回放 · ${replay.meta.title}`}>
					<div className="replay-list">
						{replay.events.map((event) => (
							<div className={`replay-row type-${event.type.replaceAll(".", "-")}`} key={event.seq}>
								<span className="replay-seq">#{event.seq}</span>
								<span className="replay-type">{event.type}</span>
								<span className="replay-text">{summarize(event)}</span>
								<small>{new Date(event.ts).toLocaleTimeString("zh-CN")}</small>
							</div>
						))}
					</div>
				</Modal>
			) : null}
		</div>
	);
}

function Modal({
	title,
	children,
	onClose,
}: {
	readonly title: string;
	readonly children: ReactNode;
	readonly onClose: () => void;
}): JSX.Element {
	return (
		<div className="modal-backdrop" onClick={onClose}>
			<div className="modal" onClick={(event) => event.stopPropagation()}>
				<div className="modal-head">
					<h2>{title}</h2>
					<button className="icon-button" aria-label="关闭" onClick={onClose}>
						<XIcon size={16} />
					</button>
				</div>
				{children}
			</div>
		</div>
	);
}

function summarize(event: EventRecord): string {
	switch (event.type) {
		case "user.input":
			return firstLine(event.payload.text, 160) || `${event.payload.images?.length ?? 0} 张图片`;
		case "llm.request":
			return `${event.payload.model} · ${event.payload.messageCount} 条消息`;
		case "llm.response":
			return firstLine(event.payload.text, 160);
		case "tool.call":
			return `${event.payload.tool} ${firstLine(JSON.stringify(event.payload.args), 120)}`;
		case "tool.result":
			return `${event.payload.isError ? "失败" : "完成"} · ${firstLine(event.payload.result, 120)}`;
		case "file.changed":
			return `${event.payload.op} ${event.payload.path}`;
		case "approval.requested":
			return `${event.payload.tool} · ${event.payload.reason}`;
		case "approval.granted":
			return `${event.payload.tool} 已放行`;
		case "approval.denied":
			return `${event.payload.tool} 已拒绝`;
		case "approval.reviewed":
			return `${event.payload.tool} · ${event.payload.decision}: ${event.payload.reason}`;
		case "compaction.done":
			return `事件 ${event.payload.fromSeq}–${event.payload.toSeq}`;
		case "error":
			return `${event.payload.kind}: ${event.payload.message}`;
		case "session.created":
			return event.payload.title;
		case "session.renamed":
			return event.payload.title;
		case "session.archived":
			return event.payload.archived ? "归档" : "取消归档";
		case "mode.switched":
			return `${event.payload.from} → ${event.payload.to}`;
		case "subagent.started":
			return firstLine(event.payload.task, 120);
		case "subagent.finished":
			return `${event.payload.steps} 步 · ${event.payload.totalTokens} tokens`;
		case "breakpoint.paused":
		case "breakpoint.resumed":
			return event.payload.reason;
		case "rollback.done":
			return `${event.payload.scope}: ${event.payload.files.join(", ")}`;
		case "limit.blocked":
			return event.payload.message ?? event.payload.kind ?? "";
	}
}
