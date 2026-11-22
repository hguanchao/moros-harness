import { useMemo, useState, type JSX } from "react";

import type { EventRecord } from "@moros/core/events/schema.ts";
import type { SessionView } from "../shared/contract.ts";
import { call, errorMessage } from "../api/api.ts";
import { displayPath } from "../utils/format.ts";
import { useApp } from "../store/state.tsx";
import {
	ChevronDownIcon,
	ChevronRightIcon,
	DatabaseIcon,
	DiffIcon,
	FileIcon,
	FileTextIcon,
	FolderOpenIcon,
	GlobeIcon,
	PlusIcon,
	RouteIcon,
	TerminalIcon,
	XIcon,
} from "./Icons.tsx";

/** 产物条目：当前会话创建的文件，按路径去重。 */
interface Artifact {
	readonly path: string;
	readonly seq: number;
}

/** 按扩展名映射文件类型图标与颜色类。 */
function fileTypeIcon(path: string): { icon: JSX.Element; colorClass: string } {
	const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
	if (ext === "md" || ext === "txt" || ext === "docx" || ext === "doc") {
		return { icon: <FileTextIcon size={15} />, colorClass: "ft-doc" };
	}
	if (ext === "html" || ext === "htm") {
		return { icon: <GlobeIcon size={15} />, colorClass: "ft-web" };
	}
	if (ext === "sql" || ext === "json" || ext === "yaml" || ext === "yml" || ext === "toml") {
		return { icon: <DatabaseIcon size={15} />, colorClass: "ft-data" };
	}
	return { icon: <FileIcon size={15} />, colorClass: "ft-other" };
}

/**
 * 对话区右侧工作台面板：视觉单标签 + 快捷入口（查看文件夹 / 查看变更 / 打开终端）+ 产物列表。
 * 保留 props 形状，供 ChatPage 直接挂载。
 */
export function ConversationPanel({
	current,
	events,
	onClose,
}: {
	readonly current: SessionView;
	readonly events: readonly EventRecord[];
	readonly onClose: () => void;
}): JSX.Element {
	const { state, dispatch } = useApp();
	const [artifactsOpen, setArtifactsOpen] = useState(true);
	const root = state.project?.root;

	const artifacts = useMemo(() => {
		const seen = new Set<string>();
		const result: Artifact[] = [];
		for (let index = events.length - 1; index >= 0; index -= 1) {
			const event = events[index];
			if (event?.type !== "file.changed" || event.payload.op !== "create") continue;
			const path = event.payload.path;
			if (seen.has(path)) continue;
			seen.add(path);
			result.push({ path, seq: event.seq });
		}
		return result;
	}, [events]);

	const openFolder = (): void => {
		if (root === undefined) return;
		void call(window.moros.openProjectFolder(root)).catch((error: unknown) => console.error(errorMessage(error)));
	};
	const openTerminal = (): void => {
		if (root === undefined) return;
		void call(window.moros.openTerminal(root)).catch((error: unknown) => console.error(errorMessage(error)));
	};
	const viewChanges = (): void => dispatch({ type: "page", page: "changes" });
	const viewTrace = (): void => dispatch({ type: "page", page: "trace" });
	// 代码工作视图开启时才显示轨迹与本轮代码差异入口；缺省（设置未加载）按开启处理。
	const codeWorkspace = state.settings?.config.ui.codeWorkspace ?? true;

	return (
		<aside className="conversation-panel conv-workbench">
			<div className="conv-workbench-tabbar">
				<div className="conv-wb-tab">
					<FileTextIcon size={14} />
					<span>新标签页</span>
					<button className="conv-wb-tab-close" aria-label="关闭标签" data-tooltip="关闭" onClick={onClose}>
						<XIcon size={13} />
					</button>
				</div>
				<button className="conv-wb-add" aria-label="新建标签" data-tooltip="新建标签页" onClick={onClose}>
					<PlusIcon size={15} />
				</button>
			</div>

			<div className="conv-wb-body">
				<div className="conv-wb-actions">
					<button className="conv-wb-action-row" onClick={openFolder} disabled={root === undefined}>
						<FolderOpenIcon size={17} />
						<span>查看文件夹</span>
					</button>
					{codeWorkspace ? (
						<>
							<button className="conv-wb-action-row" onClick={viewTrace}>
								<RouteIcon size={17} />
								<span>查看轨迹</span>
							</button>
							<button className="conv-wb-action-row" onClick={viewChanges}>
								<DiffIcon size={17} />
								<span>本轮代码差异</span>
							</button>
						</>
					) : null}
					<button className="conv-wb-action-row" onClick={openTerminal} disabled={root === undefined}>
						<TerminalIcon size={17} />
						<span>打开终端</span>
					</button>
				</div>

				<div className="conv-wb-artifacts">
					<button
						className="conv-wb-artifacts-head"
						onClick={() => setArtifactsOpen((open) => !open)}
						aria-expanded={artifactsOpen}
					>
						{artifactsOpen ? <ChevronDownIcon size={14} /> : <ChevronRightIcon size={14} />}
						<span>产物 ({artifacts.length})</span>
					</button>
					{artifactsOpen ? (
						<div className="conv-wb-artifact-list">
							{artifacts.length === 0 ? (
								<div className="conv-wb-empty">暂无产物</div>
							) : (
								artifacts.map((artifact) => {
									const { icon, colorClass } = fileTypeIcon(artifact.path);
									return (
										<button
											className={`conv-wb-artifact-row ${colorClass}`}
											key={artifact.seq}
											data-tooltip={artifact.path}
											onClick={openFolder}
										>
											{icon}
											<span>{displayPath(artifact.path)}</span>
										</button>
									);
								})
							)}
						</div>
					) : null}
				</div>
			</div>
		</aside>
	);
}
