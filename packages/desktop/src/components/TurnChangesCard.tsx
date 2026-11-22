import { useEffect, useState, type JSX } from "react";

import type { FileChangeDiff } from "@moros/core/core.ts";
import { call } from "../api/api.ts";
import { displayPath } from "../utils/format.ts";
import { AlertIcon, ChevronDownIcon, ChevronRightIcon, DiffIcon } from "./Icons.tsx";

/** 拼接项目根与相对路径为完整路径（渲染进程无 node:path，做简单规范化）。 */
function fullPath(projectRoot: string | undefined, relative: string): string {
	if (projectRoot === undefined) return relative;
	const sep = projectRoot.includes("\\") ? "\\" : "/";
	return `${projectRoot.replace(/[\\/]+$/, "")}${sep}${relative.replace(/^[\\/]+/, "")}`;
}

interface FileEntry {
	readonly path: string;
	readonly op: "create" | "modify" | "delete";
	readonly seq: number;
}

interface FileDiffState {
	readonly diff?: FileChangeDiff;
	readonly loading: boolean;
}

/**
 * 轮结束时的「本轮改动」卡片：显示本轮改了几个文件 + 增删行。
 * 每个文件行可展开审查该文件的 diff（按需 diffGet 拉取）。
 */
export function TurnChangesCard({
	files,
	projectRoot,
}: {
	readonly files: readonly FileEntry[];
	readonly projectRoot?: string;
}): JSX.Element | null {
	const [stats, setStats] = useState<{ added: number; removed: number } | undefined>(undefined);
	const [open, setOpen] = useState(false);
	const [diffs, setDiffs] = useState<Readonly<Record<number, FileDiffState>>>({});

	// 汇总行数：仅为统计拉取一次（逐文件），失败的文件忽略。
	useEffect(() => {
		if (files.length === 0) return;
		let cancelled = false;
		void (async () => {
			let added = 0;
			let removed = 0;
			for (const file of files) {
				try {
					const diff = await call(window.moros.diffGet(file.seq));
					if (cancelled) return;
					added += diff.added;
					removed += diff.removed;
				} catch {
					// 单个文件 diff 失败时忽略其行数，不影响整体。
				}
			}
			if (!cancelled) setStats({ added, removed });
		})();
		return () => {
			cancelled = true;
		};
	}, [files]);

	if (files.length === 0) return null;

	const toggleFile = (seq: number): void => {
		const current = diffs[seq];
		if (current !== undefined) {
			// 已加载：切展开状态（用 diff 是否存在标记，折叠通过本地 open 集合同步，见下）。
			return;
		}
		setDiffs((prev) => ({ ...prev, [seq]: { loading: true } }));
		void call(window.moros.diffGet(seq))
			.then((diff) => setDiffs((prev) => ({ ...prev, [seq]: { diff, loading: false } })))
			.catch(() => setDiffs((prev) => ({ ...prev, [seq]: { loading: false } })));
	};

	return (
		<div className={`turn-changes-card ${open ? "is-open" : ""}`}>
			<button type="button" className="turn-changes-head" onClick={() => setOpen(!open)}>
				<DiffIcon size={12} />
				<span className="turn-changes-count">{files.length} 个文件已更改</span>
				{stats === undefined ? null : (
					<span className="diff-stats">
						<span className="added">+{stats.added}</span>
						<span className="removed">−{stats.removed}</span>
					</span>
				)}
				{open ? <ChevronDownIcon size={12} /> : <ChevronRightIcon size={12} />}
			</button>
			{open ? (
				<div className="turn-changes-body">
					{files.map((file) => (
						<FileChangeRow
							key={file.seq}
							file={file}
							{...(projectRoot === undefined ? {} : { projectRoot })}
							state={diffs[file.seq]}
							onToggle={() => toggleFile(file.seq)}
						/>
					))}
				</div>
			) : null}
		</div>
	);
}

function FileChangeRow({
	file,
	projectRoot,
	state,
	onToggle,
}: {
	readonly file: FileEntry;
	readonly projectRoot?: string;
	readonly state: FileDiffState | undefined;
	readonly onToggle: () => void;
}): JSX.Element {
	const [expanded, setExpanded] = useState(false);
	const handleClick = (): void => {
		if (!expanded && state === undefined) onToggle();
		setExpanded(!expanded);
	};
	const absolutePath = fullPath(projectRoot, file.path);
	return (
		<div className={`turn-change-file ${expanded ? "is-expanded" : ""}`}>
			<button type="button" className="turn-change-file-head" onClick={handleClick}>
				{expanded ? <ChevronDownIcon size={12} /> : <ChevronRightIcon size={12} />}
				<span className={`file-op op-${file.op}`}>{opLabel(file.op)}</span>
				<span className="file-path">
					<span className="turn-change-file-link" data-tooltip={absolutePath}>
						{displayPath(file.path)}
					</span>
				</span>
				{state?.diff === undefined ? null : (
					<span className="diff-stats">
						<span className="added">+{state.diff.added}</span>
						<span className="removed">−{state.diff.removed}</span>
					</span>
				)}
			</button>
			{expanded ? (
				<div className="turn-change-diff">
					{state === undefined || state.loading ? (
						<div className="turn-change-diff-loading">正在加载改动…</div>
					) : state.diff === undefined ? (
						<div className="inline-notice notice-warn">
							<AlertIcon size={13} /> 无法加载该文件的改动
						</div>
					) : (
						<DiffBlock diff={state.diff} />
					)}
				</div>
			) : null}
		</div>
	);
}

/** 单个文件的 unified diff 展示（复用 ChangesPage 的 diff-* 样式类）。 */
function DiffBlock({ diff }: { readonly diff: FileChangeDiff }): JSX.Element {
	if (diff.binary) {
		return (
			<div className="inline-notice notice-warn">
				<AlertIcon size={13} /> 二进制文件，仅记录变更
			</div>
		);
	}
	return (
		<div className="diff-content">
			{diff.hunks.map((hunk, hunkIndex) => (
				<div className="diff-hunk" key={hunkIndex}>
					<div className="diff-hunk-head">
						@@ -{hunk.oldStart},{hunk.oldCount} +{hunk.newStart},{hunk.newCount} @@
					</div>
					{hunk.lines.map((line, lineIndex) => (
						<div className={`diff-line ${line.kind}`} key={lineIndex}>
							<span className="diff-number">{line.oldLine ?? ""}</span>
							<span className="diff-number">{line.newLine ?? ""}</span>
							<span className="diff-marker">{line.kind === "add" ? "+" : line.kind === "remove" ? "−" : " "}</span>
							<span className="diff-text">{line.text.length > 0 ? line.text : " "}</span>
						</div>
					))}
				</div>
			))}
		</div>
	);
}

function opLabel(op: FileEntry["op"]): string {
	switch (op) {
		case "create":
			return "新建";
		case "modify":
			return "修改";
		case "delete":
			return "删除";
	}
}
