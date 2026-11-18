import { useEffect, useState, type JSX } from "react";

import type { WorkspaceEntry, ReadTextFileResult } from "@moros/core/workspace/files.ts";
import { useDesktopActions } from "../hooks/actions.ts";
import { call, errorMessage } from "../api/api.ts";
import { formatBytes } from "../utils/format.ts";
import { PageHeader } from "../components/PageHeader.tsx";
import {
	ChevronDownIcon,
	ChevronRightIcon,
	FileIcon,
	FolderIcon,
	FolderOpenIcon,
	RefreshIcon,
	XIcon,
} from "../components/Icons.tsx";
import { useApp } from "../store/state.tsx";

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp", "gif", "bmp", "ico", "avif"]);

type Preview =
	| { readonly kind: "empty" }
	| { readonly kind: "text"; readonly data: ReadTextFileResult }
	| { readonly kind: "image"; readonly dataUrl: string; readonly bytes: number; readonly truncated: boolean }
	| { readonly kind: "binary"; readonly bytes: number }
	| { readonly kind: "error"; readonly message: string };

export function FilesPage(): JSX.Element {
	const { state, dispatch } = useApp();
	const actions = useDesktopActions();
	const project = state.project;
	const [selected, setSelected] = useState<string | undefined>(undefined);
	const [preview, setPreview] = useState<Preview>({ kind: "empty" });
	const [localVersion, setLocalVersion] = useState(0);
	const version = state.workspaceVersion + localVersion;

	useEffect(() => {
		if (selected === undefined || project === undefined) {
			setPreview({ kind: "empty" });
			return;
		}
		let cancelled = false;
		void (async () => {
			try {
				if (isImage(selected)) {
					const result = await call(window.moros.workspaceReadBinary(selected));
					if (!cancelled) {
						setPreview({
							kind: "image",
							dataUrl: result.dataUrl,
							bytes: result.bytes,
							truncated: result.truncated,
						});
					}
					return;
				}
				const result = await call(window.moros.workspaceRead(selected));
				if (cancelled) return;
				if (result.binary) {
					setPreview({ kind: "binary", bytes: result.bytes });
				} else {
					setPreview({ kind: "text", data: result });
				}
			} catch (error) {
				if (!cancelled) setPreview({ kind: "error", message: errorMessage(error) });
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [selected, project, version]);

	if (project === undefined) {
		return (
			<div className="page-empty">
				<FolderIcon size={22} />
				<p>先打开一个项目</p>
				<button
					className="primary-button"
					onClick={() => {
						void actions.openProjectDialog().catch((error: unknown) => {
							dispatch({ type: "notice", level: "error", message: errorMessage(error) });
						});
					}}
				>
					打开项目
				</button>
			</div>
		);
	}

	return (
		<div className="files-page">
			<PageHeader
				title="文件"
				subtitle={project.root}
				actions={
					<button className="ghost-button" onClick={() => setLocalVersion((value) => value + 1)}>
						<RefreshIcon size={14} />
						刷新
					</button>
				}
			/>
			<div className="files-body">
				<div className="file-tree-pane">
					<DirectoryNode
						path=""
						name={project.name}
						depth={0}
						version={version}
						selected={selected}
						onSelect={setSelected}
						defaultOpen
					/>
				</div>
				<div className="file-preview-pane">
					{selected === undefined ? (
						<div className="page-empty">
							<FileIcon size={22} />
							<p>从左侧选择文件查看内容</p>
						</div>
					) : (
						<>
							<div className="file-preview-head">
								<div>
									<strong>{selected}</strong>
									{preview.kind === "text" ? (
										<small>
											{formatBytes(preview.data.bytes)}
											{preview.data.truncated ? " · 已截断" : ""}
										</small>
									) : null}
									{preview.kind === "image" ? (
										<small>
											{formatBytes(preview.bytes)}
											{preview.truncated ? " · 已截断" : ""}
										</small>
									) : null}
									{preview.kind === "binary" ? <small>{formatBytes(preview.bytes)} · 二进制</small> : null}
								</div>
								<button
									className="icon-button"
									title="关闭预览"
									aria-label="关闭预览"
									onClick={() => setSelected(undefined)}
								>
									<XIcon size={15} />
								</button>
							</div>
							<div className="file-preview-content">
								{preview.kind === "text" ? <TextPreview data={preview.data} /> : null}
								{preview.kind === "image" ? <img src={preview.dataUrl} alt={selected} /> : null}
								{preview.kind === "binary" ? <div className="page-empty">二进制文件无法预览</div> : null}
								{preview.kind === "error" ? <div className="inline-notice notice-error">{preview.message}</div> : null}
							</div>
						</>
					)}
				</div>
			</div>
		</div>
	);
}

function DirectoryNode({
	path,
	name,
	depth,
	version,
	selected,
	onSelect,
	defaultOpen = false,
}: {
	readonly path: string;
	readonly name: string;
	readonly depth: number;
	readonly version: number;
	readonly selected: string | undefined;
	readonly onSelect: (path: string) => void;
	readonly defaultOpen?: boolean;
}): JSX.Element {
	const { dispatch } = useApp();
	const [open, setOpen] = useState(defaultOpen);
	const [entries, setEntries] = useState<readonly WorkspaceEntry[] | undefined>(undefined);
	const [loading, setLoading] = useState(false);

	useEffect(() => {
		if (!open) return;
		let cancelled = false;
		setLoading(true);
		void (async () => {
			try {
				const items = await call(window.moros.workspaceList(path));
				if (!cancelled) setEntries(items);
			} catch (error) {
				if (!cancelled) {
					setEntries([]);
					dispatch({ type: "notice", level: "warn", message: `无法读取 ${path || "."}：${errorMessage(error)}` });
				}
			} finally {
				if (!cancelled) setLoading(false);
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [open, path, version, dispatch]);

	return (
		<div className="tree-node">
			<button
				className="tree-row"
				style={{ paddingLeft: 10 + depth * 14 }}
				onClick={() => setOpen(!open)}
				title={path || "."}
			>
				{open ? <ChevronDownIcon size={13} /> : <ChevronRightIcon size={13} />}
				{open ? <FolderOpenIcon size={14} /> : <FolderIcon size={14} />}
				<span>{name}</span>
				{loading ? <span className="spinner small" /> : null}
			</button>
			{open && entries !== undefined ? (
				<div>
					{entries.map((entry) =>
						entry.kind === "directory" ? (
							<DirectoryNode
								key={entry.path}
								path={entry.path}
								name={entry.name}
								depth={depth + 1}
								version={version}
								selected={selected}
								onSelect={onSelect}
							/>
						) : (
							<button
								key={entry.path}
								className={`tree-row file ${selected === entry.path ? "is-selected" : ""}`}
								style={{ paddingLeft: 37 + depth * 14 }}
								title={entry.path}
								onClick={() => onSelect(entry.path)}
							>
								<FileIcon size={14} />
								<span>{entry.name}</span>
								{entry.bytes !== undefined ? <small>{formatBytes(entry.bytes)}</small> : null}
							</button>
						),
					)}
					{entries.length === 0 ? <div className="tree-empty">空目录</div> : null}
				</div>
			) : null}
		</div>
	);
}

function TextPreview({ data }: { readonly data: ReadTextFileResult }): JSX.Element {
	const lines = (data.text ?? "").split("\n");
	const max = 5_000;
	const visible = lines.slice(0, max);
	return (
		<>
			{lines.length > max ? <div className="inline-notice notice-warn">仅显示前 {max} 行</div> : null}
			<pre className="code-view">
				{visible.map((line, index) => (
					<div className="code-line" key={index}>
						<span className="line-number">{index + 1}</span>
						<span className="line-text">{line.length > 0 ? line : " "}</span>
					</div>
				))}
			</pre>
		</>
	);
}

function isImage(path: string): boolean {
	const extension = path.split(".").at(-1)?.toLowerCase() ?? "";
	return IMAGE_EXTENSIONS.has(extension);
}
