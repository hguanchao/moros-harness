import { useEffect, useId, useRef, useState, type JSX } from "react";

import { call, errorMessage } from "../api/api.ts";
import { useDesktopActions } from "../hooks/actions.ts";
import { useApp } from "../store/state.tsx";
import { Dropdown, type DropdownAction, type DropdownOption } from "./Dropdown.tsx";
import { BranchIcon, FolderIcon, FolderOpenIcon, FolderPlusIcon, XIcon } from "./Icons.tsx";

const PROJECT_NAME_MAX_LENGTH = 100;

interface ProjectBranches {
	readonly root: string;
	readonly branches: readonly string[];
	readonly current?: string;
}

/**
 * 新任务的项目选择器：选择结果只关联草稿，不激活旧会话；创建与选择目录作为下拉菜单动作。
 * 目录校验、独占创建和权限检查均由主进程负责。
 */
export function ProjectPicker(): JSX.Element {
	const { state, dispatch } = useApp();
	const actions = useDesktopActions();
	const [isSelecting, setIsSelecting] = useState(false);
	const [isCreating, setIsCreating] = useState(false);
	const [branches, setBranches] = useState<ProjectBranches | undefined>();
	const project = state.draft.project;
	const projects = state.app?.recentProjects ?? [];
	const isDisabled = !state.ready || state.isSending || state.isNavigating || isSelecting;
	const options: DropdownOption[] = projects.map((item) => ({
		value: item.root,
		label: item.name,
		icon: <FolderIcon size={14} />,
	}));
	if (project !== null && !projects.some((item) => item.root === project.root)) {
		options.push({ value: project.root, label: project.name, icon: <FolderIcon size={14} /> });
	}

	useEffect(() => {
		if (project === null) {
			setBranches(undefined);
			return;
		}
		let cancelled = false;
		void call(window.moros.gitBranches(project.root))
			.then((info) => {
				if (!cancelled) setBranches({ root: project.root, ...info });
			})
			.catch((error: unknown) => {
				if (cancelled) return;
				setBranches(undefined);
				dispatch({ type: "notice", level: "warn", message: `无法读取 Git 分支：${errorMessage(error)}` });
			});
		return () => {
			cancelled = true;
		};
	}, [project?.root, dispatch]);

	const branchInfo = branches !== undefined && branches.root === project?.root ? branches : undefined;
	const branchOptions = (branchInfo?.branches ?? []).map((branch): DropdownOption => ({
		value: branch,
		label: branch,
		icon: <BranchIcon size={14} />,
	}));
	const selectedBranch = state.draft.branch ?? branchInfo?.current;

	const selectLocal = async (): Promise<void> => {
		setIsSelecting(true);
		try {
			await actions.selectProjectDialog();
		} catch (error) {
			dispatch({ type: "notice", level: "error", message: errorMessage(error) });
		} finally {
			setIsSelecting(false);
		}
	};

	const menuActions: DropdownAction[] = [
		{ label: "创建项目", icon: <FolderPlusIcon size={14} />, onSelect: () => setIsCreating(true) },
		{ label: "选择本地项目", icon: <FolderOpenIcon size={14} />, onSelect: () => void selectLocal() },
	];

	return (
		<>
			<div
				className={`project-picker-wrap ${project === null ? "" : "has-project"} ${isDisabled ? "is-disabled" : ""}`}
			>
				<Dropdown
					className="project-picker"
					variant="inline"
					title={project?.root ?? "选择或创建项目后，任务会归入该项目"}
					disabled={isDisabled}
					value={project?.root ?? ""}
					options={options}
					actions={menuActions}
					trigger={
						<>
							<FolderIcon size={16} />
							<span>{project?.name ?? "选择项目"}</span>
						</>
					}
					onChange={(root) => {
						const selected = projects.find((item) => item.root === root);
						if (selected !== undefined) {
							dispatch({ type: "draft-project", project: { root: selected.root, name: selected.name } });
						}
					}}
				/>
				{project === null ? null : (
					<button
						type="button"
						className="project-clear"
						title="取消选择项目"
						aria-label="取消选择项目"
						disabled={isDisabled}
						onClick={() => dispatch({ type: "draft-project", project: null })}
					>
						<XIcon size={13} />
					</button>
				)}
			</div>
			{project !== null && branchOptions.length > 0 ? (
				<Dropdown
					className="branch-picker"
					variant="inline"
					title="首次发送前切换到该分支；工作区有未提交改动时不会切换"
					disabled={isDisabled}
					value={selectedBranch ?? ""}
					options={branchOptions}
					placeholder="选择分支"
					trigger={
						<>
							<BranchIcon size={16} />
							<span>{selectedBranch ?? "选择分支"}</span>
						</>
					}
					onChange={(branch) => dispatch({ type: "draft-branch", branch })}
				/>
			) : null}
			{isCreating ? <CreateProjectDialog onClose={() => setIsCreating(false)} /> : null}
		</>
	);
}

function CreateProjectDialog({ onClose }: { readonly onClose: () => void }): JSX.Element {
	const actions = useDesktopActions();
	const dialog = useRef<HTMLDialogElement | null>(null);
	const titleId = useId();
	const nameId = useId();
	const [name, setName] = useState("");
	const [isCreating, setIsCreating] = useState(false);
	const [error, setError] = useState<string | undefined>();

	useEffect(() => {
		const element = dialog.current;
		element?.showModal();
		return () => element?.close();
	}, []);

	const create = async (): Promise<void> => {
		if (isCreating || name.trim().length === 0) return;
		setIsCreating(true);
		setError(undefined);
		try {
			if (await actions.createProjectDialog(name)) onClose();
		} catch (cause) {
			setError(errorMessage(cause));
		} finally {
			setIsCreating(false);
		}
	};

	return (
		<dialog
			ref={dialog}
			className="project-create-dialog"
			aria-labelledby={titleId}
			onClose={onClose}
			onCancel={(event) => {
				if (isCreating) event.preventDefault();
			}}
		>
			<form
				onSubmit={(event) => {
					event.preventDefault();
					void create();
				}}
			>
				<div className="modal-head">
					<h2 id={titleId}>创建项目</h2>
					<button type="button" className="icon-button" aria-label="关闭" onClick={onClose} disabled={isCreating}>
						<XIcon size={16} />
					</button>
				</div>
				<p className="project-create-desc">选择父目录后，新建一个同名文件夹作为项目；不会初始化 Git 或添加模板。</p>
				<label htmlFor={nameId}>项目名称</label>
				<input
					id={nameId}
					autoFocus
					value={name}
					maxLength={PROJECT_NAME_MAX_LENGTH}
					disabled={isCreating}
					placeholder="例如 Ferry"
					onChange={(event) => setName(event.target.value)}
				/>
				{error === undefined ? null : (
					<p className="project-create-error" role="alert">
						{error}
					</p>
				)}
				<div className="project-create-actions">
					<button type="button" className="ghost-button" disabled={isCreating} onClick={onClose}>
						取消
					</button>
					<button type="submit" className="primary-button" disabled={isCreating || name.trim().length === 0}>
						{isCreating ? "正在创建…" : "选择位置并创建"}
					</button>
				</div>
			</form>
		</dialog>
	);
}
