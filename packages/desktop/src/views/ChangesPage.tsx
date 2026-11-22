import { useEffect, useState, type JSX } from "react";

import type { FileChangeDiff } from "@moros/core/core.ts";
import type { DiffHunk, DiffLine } from "@moros/core/diff/line-diff.ts";
import type { CheckpointView, FileChangeSummary } from "../shared/contract.ts";
import { call, errorMessage } from "../api/api.ts";
import { displayPath, relativeTime } from "../utils/format.ts";
import { PageHeader } from "../components/PageHeader.tsx";
import { AlertIcon, ArrowLeftIcon, DiffIcon, RefreshIcon, RestoreIcon } from "../components/Icons.tsx";
import { useConfirm } from "../components/ConfirmDialog.tsx";
import { useApp } from "../store/state.tsx";

export function ChangesPage(): JSX.Element {
	const { state, dispatch } = useApp();
	const { confirm } = useConfirm();
	const current = state.current;
	const [changes, setChanges] = useState<readonly FileChangeSummary[]>([]);
	const [selected, setSelected] = useState<number | undefined>(undefined);
	const [diff, setDiff] = useState<FileChangeDiff | undefined>(undefined);
	const [checkpoint, setCheckpoint] = useState<CheckpointView | null>(null);
	const [error, setError] = useState<string | undefined>(undefined);
	const [version, setVersion] = useState(0);
	const [viewMode, setViewMode] = useState<"unified" | "split">("unified");
	const eventCount = current === undefined ? 0 : (state.events[current.meta.id]?.length ?? 0);

	useEffect(() => {
		if (current === undefined) {
			setChanges([]);
			return;
		}
		let cancelled = false;
		void (async () => {
			try {
				const items = await call(window.moros.sessionsChanges(current.meta.id));
				if (cancelled) return;
				setChanges(items);
				setError(undefined);
				setSelected((existing) =>
					existing !== undefined && items.some((item) => item.seq === existing) ? existing : items.at(-1)?.seq,
				);
			} catch (loadError) {
				if (!cancelled) setError(errorMessage(loadError));
			}
			try {
				const point = await call(window.moros.sessionsCheckpoint());
				if (!cancelled) setCheckpoint(point);
			} catch {
				if (!cancelled) setCheckpoint(null);
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [current?.meta.id, eventCount, version]);

	useEffect(() => {
		if (current === undefined || selected === undefined) {
			setDiff(undefined);
			return;
		}
		let cancelled = false;
		void (async () => {
			try {
				const result = await call(window.moros.diffGet(selected));
				if (!cancelled) {
					setDiff(result);
					setError(undefined);
				}
			} catch (loadError) {
				if (!cancelled) setError(errorMessage(loadError));
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [current?.meta.id, selected, version]);

	if (current === undefined) {
		return (
			<div className="page-empty">
				<DiffIcon size={22} />
				<p>先打开一个会话</p>
			</div>
		);
	}

	return (
		<div className="changes-page">
			<PageHeader
				title="变更"
				subtitle="文件工具产生的快照；shell 改动由审批与审计兜底。"
				actions={
					<>
						<button
							className="icon-button"
							data-tooltip="刷新"
							aria-label="刷新"
							onClick={() => setVersion((value) => value + 1)}
						>
							<RefreshIcon size={16} />
						</button>
						{checkpoint !== null ? (
							<button
								className="icon-button"
								data-tooltip="恢复检查点"
								aria-label="恢复检查点"
								onClick={async () => {
									const confirmed = await confirm({
										title: "恢复检查点",
										message: "恢复到最近检查点？当前工作区中该检查点涉及的文件会被写回。",
										confirmLabel: "恢复",
										danger: true,
									});
									if (!confirmed) return;
									try {
										await call(window.moros.sessionsRestore(checkpoint.id));
										setVersion((value) => value + 1);
									} catch (restoreError) {
										if (current !== undefined) {
											dispatch({
												type: "inline-notice",
												sessionId: current.meta.id,
												tone: "error",
												text: errorMessage(restoreError),
											});
										} else {
											console.error(`[moros] ${errorMessage(restoreError)}`);
										}
									}
								}}
							>
								<RestoreIcon size={16} />
							</button>
						) : null}
						<button
							className="icon-button danger"
							data-tooltip="回滚最近一步"
							aria-label="回滚最近一步"
							onClick={async () => {
								const confirmed = await confirm({
									title: "回滚改动",
									message: "回滚最近一次文件改动？该操作不可恢复。",
									confirmLabel: "回滚",
									danger: true,
								});
								if (!confirmed) return;
								try {
									await call(window.moros.sessionsRollback());
									setVersion((value) => value + 1);
								} catch (rollbackError) {
									if (current !== undefined) {
										dispatch({
											type: "inline-notice",
											sessionId: current.meta.id,
											tone: "error",
											text: errorMessage(rollbackError),
										});
									} else {
										console.error(`[moros] ${errorMessage(rollbackError)}`);
									}
								}
							}}
						>
							<ArrowLeftIcon size={16} />
						</button>
					</>
				}
			/>

			{error !== undefined ? <div className="inline-notice notice-error">{error}</div> : null}
			<div className="changes-body">
				<div className="change-list">
					{changes.length === 0 ? <div className="side-empty">当前会话还没有文件变更</div> : null}
					{[...changes].reverse().map((change) => (
						<button
							key={change.seq}
							className={`change-row ${selected === change.seq ? "is-selected" : ""}`}
							onClick={() => setSelected(change.seq)}
							data-tooltip={change.path}
						>
							<span className={`file-op op-${change.op}`}>{opLabel(change.op)}</span>
							<span className="change-path">{displayPath(change.path)}</span>
							<small>{relativeTime(change.ts)}</small>
						</button>
					))}
				</div>
				<div className="diff-pane">
					{diff === undefined ? (
						<div className="page-empty">
							<DiffIcon size={20} />
							<p>选择一条变更查看 Diff</p>
						</div>
					) : (
						<>
							<div className="diff-head">
								<strong>{displayPath(diff.path)}</strong>
								<div className="diff-head-right">
									<div className="view-toggle">
										<button
											className={viewMode === "unified" ? "is-active" : ""}
											onClick={() => setViewMode("unified")}
										>
											统一
										</button>
										<button className={viewMode === "split" ? "is-active" : ""} onClick={() => setViewMode("split")}>
											并排
										</button>
									</div>
									<span className="diff-stats">
										<span className="added">+{diff.added}</span>
										<span className="removed">−{diff.removed}</span>
									</span>
								</div>
							</div>
							{diff.binary ? (
								<div className="inline-notice notice-warn">
									<AlertIcon size={14} /> 二进制文件，仅记录变更
								</div>
							) : null}
							{diff.degraded ? <div className="inline-notice notice-warn">文件过大，已降级为整段替换展示</div> : null}
							<div className="diff-content">
								{diff.hunks.map((hunk, hunkIndex) => (
									<div className="diff-hunk" key={hunkIndex}>
										<div className="diff-hunk-head">
											@@ -{hunk.oldStart},{hunk.oldCount} +{hunk.newStart},{hunk.newCount} @@
										</div>
										{viewMode === "unified" ? (
											hunk.lines.map((line, lineIndex) => (
												<div className={`diff-line ${line.kind}`} key={lineIndex}>
													<span className="diff-number">{line.oldLine ?? ""}</span>
													<span className="diff-number">{line.newLine ?? ""}</span>
													<span className="diff-marker">
														{line.kind === "add" ? "+" : line.kind === "remove" ? "−" : " "}
													</span>
													<span className="diff-text">{line.text.length > 0 ? line.text : " "}</span>
												</div>
											))
										) : (
											<SplitHunk hunk={hunk} />
										)}
									</div>
								))}
							</div>
						</>
					)}
				</div>
			</div>
		</div>
	);
}

function SplitHunk({ hunk }: { readonly hunk: DiffHunk }): JSX.Element {
	const rows = splitRows(hunk.lines);
	return (
		<div className="diff-split">
			{rows.map((row, index) => (
				<div className="split-row" key={index}>
					<SplitCell line={row.left} side="left" />
					<SplitCell line={row.right} side="right" />
				</div>
			))}
		</div>
	);
}

function SplitCell({
	line,
	side,
}: {
	readonly line: DiffLine | undefined;
	readonly side: "left" | "right";
}): JSX.Element {
	const number = line === undefined ? "" : side === "left" ? (line.oldLine ?? "") : (line.newLine ?? "");
	const kind = line?.kind ?? "empty";
	return (
		<div className={`split-cell ${kind} ${side}`}>
			<span className="diff-number">{number}</span>
			<span className="diff-text">{line === undefined ? "" : line.text.length > 0 ? line.text : " "}</span>
		</div>
	);
}

interface SplitRow {
	readonly left?: DiffLine;
	readonly right?: DiffLine;
}

/** 把 hunk 的删除/新增段按行配对成左右两栏；相等的行两侧同源。 */
function splitRows(lines: readonly DiffLine[]): readonly SplitRow[] {
	const rows: SplitRow[] = [];
	let index = 0;
	while (index < lines.length) {
		const line = lines[index];
		if (line === undefined) break;
		if (line.kind === "equal") {
			rows.push({ left: line, right: line });
			index += 1;
			continue;
		}
		const removes: DiffLine[] = [];
		const adds: DiffLine[] = [];
		while (index < lines.length && lines[index]?.kind === "remove") {
			const remove = lines[index];
			if (remove !== undefined) removes.push(remove);
			index += 1;
		}
		while (index < lines.length && lines[index]?.kind === "add") {
			const add = lines[index];
			if (add !== undefined) adds.push(add);
			index += 1;
		}
		const count = Math.max(removes.length, adds.length);
		for (let offset = 0; offset < count; offset += 1) {
			const left = removes[offset];
			const right = adds[offset];
			rows.push({
				...(left === undefined ? {} : { left }),
				...(right === undefined ? {} : { right }),
			});
		}
	}
	return rows;
}

function opLabel(op: FileChangeSummary["op"]): string {
	if (op === "create") return "新建";
	if (op === "delete") return "删除";
	return "修改";
}
