import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type JSX } from "react";
import { createPortal } from "react-dom";

import type { PreparedImage, SessionView } from "../shared/contract.ts";
import { call, errorMessage } from "../api/api.ts";
import { currentNavigationEpoch, useDesktopActions } from "../hooks/actions.ts";
import { Dropdown, type DropdownOption } from "./Dropdown.tsx";
import { ProjectPicker } from "./ProjectPicker.tsx";
import {
	ArrowUpIcon,
	ChevronLeftIcon,
	FolderIcon,
	GlobeIcon,
	ImageIcon,
	LightbulbIcon,
	LinkIcon,
	PlugIcon,
	PlusIcon,
	PointerIcon,
	ShieldAlertIcon,
	ShieldCheckIcon,
	StopIcon,
	TerminalIcon,
	XIcon,
} from "./Icons.tsx";
import { useApp } from "../store/state.tsx";
import { availableModel, clampEffortToModel, configuredModel } from "../utils/model.ts";
import { workspaceTarget, workspaceTargetsMatch } from "../utils/workspace.ts";

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/** 输入框与首发/运行控制；信任页由 ChatPage 负责，新任务首次有效发送才创建会话。 */
export function Composer(): JSX.Element {
	const { state, dispatch } = useApp();
	const actions = useDesktopActions();
	const current = state.current;
	const project = state.project;
	const { text, images } = state.draft;
	const isSending = state.isSending;
	const [dragging, setDragging] = useState(false);
	const [attachMenu, setAttachMenu] = useState(false);
	const [showUrlInput, setShowUrlInput] = useState(false);
	const [imageUrl, setImageUrl] = useState("");
	const [yoloConfirmOpen, setYoloConfirmOpen] = useState(false);
	const textarea = useRef<HTMLTextAreaElement | null>(null);
	const isSubmitting = useRef(false);
	const platform = state.app?.platform ?? "win32";
	const isDraftPrepared =
		state.draftWorkspace !== undefined &&
		workspaceTargetsMatch(state.draftWorkspace, workspaceTarget(state.draft.project), platform);
	const trustBlocked =
		(current !== undefined || isDraftPrepared) && project?.trust.required === true && project.trust.decision === null;
	const readOnly = current?.readOnly === true;
	const running =
		current?.running === true || (current !== undefined && state.runStates[current.meta.id] === "running");
	// 回合挂起在审批断点上也必须能停止：此时合并按钮切到停止态，作为「放弃等待」的出口
	const awaitingApproval =
		current !== undefined && state.runStates[current.meta.id] === "paused" && current.running !== true;
	const stoppable = running || awaitingApproval;
	const disabled = !state.ready || state.isNavigating || readOnly || trustBlocked;
	const canSend = !disabled && !isSending && (text.trim().length > 0 || images.length > 0);
	const queued = state.queue[current?.meta.id ?? ""] ?? [];
	const model =
		current === undefined
			? availableModel(state.models, state.draft.model ?? configuredModel(state.models, state.settings))
			: availableModel(state.models, current.model);
	const effort = current?.effort ?? state.draft.effort ?? state.settings?.config.reasoningEffort ?? "off";
	const approval = current?.approval ?? state.draft.approval ?? state.settings?.config.approval ?? "ask";
	const plan = current?.plan ?? state.draft.plan;

	useEffect(() => {
		const element = textarea.current;
		if (element === null) return;
		element.style.height = "auto";
		element.style.height = `${Math.min(element.scrollHeight, 140)}px`;
	}, [text]);

	useEffect(() => {
		if (!disabled) textarea.current?.focus();
	}, [current?.meta.id, state.draftGeneration, disabled]);

	const report = (error: unknown): void => {
		dispatch({ type: "notice", level: "error", message: errorMessage(error) });
	};

	const send = async (): Promise<void> => {
		if (disabled || isSending || isSubmitting.current) return;
		const message = text.trim();
		if (message.length === 0 && images.length === 0) return;
		const epoch = currentNavigationEpoch();
		const generation = state.draftGeneration;
		const revision = state.draftRevision;
		const imageIds = images.map((image) => image.id);
		isSubmitting.current = true;
		dispatch({ type: "sending", isSending: true });
		try {
			let session = current;
			if (session === undefined) {
				const draftProject = state.draft.project;
				const draftBranch = state.draft.branch;
				const target = workspaceTarget(draftProject);
				const prepared = await actions.prepareTask(target, generation);
				if (prepared === undefined || epoch !== currentNavigationEpoch()) return;
				if (prepared.trust.required && prepared.trust.decision === null) {
					dispatch({ type: "notice", level: "info", message: "请确认工作区信任后再次发送，输入已保留" });
					return;
				}
				if (draftProject !== null && draftBranch !== undefined) {
					await call(window.moros.gitCheckout(draftProject.root, draftBranch));
					if (epoch !== currentNavigationEpoch()) return;
				}
				const context = await actions.createTask(
					{
						target,
						...(state.draft.model === undefined ? {} : { model: state.draft.model }),
						...(state.draft.effort === undefined ? {} : { effort: state.draft.effort }),
						...(state.draft.approval === undefined ? {} : { approval: state.draft.approval }),
						plan: state.draft.plan,
					},
					generation,
				);
				if (context === undefined || epoch !== currentNavigationEpoch()) return;
				session = context.session;
			}
			const result = await call(
				window.moros.chatSend({
					sessionId: session.meta.id,
					text: message,
					...(imageIds.length === 0 ? {} : { imageIds }),
				}),
			);
			dispatch({ type: "draft-sent", generation, revision, imageIds });
			if (result.queued) {
				dispatch({ type: "notice", level: "info", message: "已加入队列，当前回合结束后自动发送" });
			}
		} catch (error) {
			report(error);
		} finally {
			isSubmitting.current = false;
			dispatch({ type: "sending", isSending: false });
		}
	};

	const addImage = (image: PreparedImage, generation: number): void => {
		dispatch({ type: "draft-image-added", image, generation });
	};

	const attach = async (): Promise<void> => {
		setAttachMenu(false);
		const generation = state.draftGeneration;
		try {
			const image = await call(window.moros.imagesPick());
			if (image !== null) addImage(image, generation);
		} catch (error) {
			report(error);
		}
	};

	const addFiles = async (files: FileList | readonly File[]): Promise<void> => {
		const generation = state.draftGeneration;
		for (const file of Array.from(files)) {
			if (!file.type.startsWith("image/")) continue;
			if (file.size > MAX_IMAGE_BYTES) {
				dispatch({ type: "notice", level: "warn", message: `${file.name} 超过单张图片上限` });
				continue;
			}
			try {
				const bytes = new Uint8Array(await file.arrayBuffer());
				addImage(await call(window.moros.imagesFromBytes(bytes, file.type)), generation);
			} catch (error) {
				report(error);
			}
		}
	};

	const addImageUrl = async (): Promise<void> => {
		const url = imageUrl.trim();
		if (url.length === 0) return;
		const generation = state.draftGeneration;
		try {
			addImage(await call(window.moros.imagesFromUrl(url)), generation);
			setImageUrl("");
			setShowUrlInput(false);
		} catch (error) {
			report(error);
		}
	};

	const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>): void => {
		const files = [...event.clipboardData.files].filter((file) => file.type.startsWith("image/"));
		if (files.length === 0) return;
		event.preventDefault();
		void addFiles(files);
	};

	const onDrop = (event: DragEvent<HTMLDivElement>): void => {
		event.preventDefault();
		setDragging(false);
		if (!disabled && event.dataTransfer.files.length > 0) void addFiles(event.dataTransfer.files);
	};

	const changeModel = async (value: string): Promise<void> => {
		const selected = state.models.providers
			.flatMap((provider) => provider.models.map((entry) => ({ provider: provider.name, model: entry.id })))
			.find((entry) => JSON.stringify([entry.provider, entry.model]) === value);
		if (selected === undefined) {
			report(new Error("所选模型已不可用，请重新选择"));
			return;
		}
		// 新模型可能不支持当前推理强度（如 Max 遇到只到 High 的模型），钳到最近档位保持与菜单一致
		const nextEffort = clampEffortToModel(state.models, selected, effort);
		try {
			if (current === undefined) {
				dispatch({
					type: "draft-options",
					options: nextEffort === effort ? { model: selected } : { model: selected, effort: nextEffort },
				});
				return;
			}
			await call(window.moros.sessionSelectModel(selected.provider, selected.model));
			if (nextEffort !== effort) await call(window.moros.sessionSelectEffort(nextEffort));
		} catch (error) {
			report(error);
		}
	};

	const changeEffort = async (value: SessionView["effort"]): Promise<void> => {
		try {
			if (current === undefined) dispatch({ type: "draft-options", options: { effort: value } });
			else await call(window.moros.sessionSelectEffort(value));
		} catch (error) {
			report(error);
		}
	};

	// 权限项与计划模式互斥：选择任一审批档位会退出计划模式。
	// 切到完全访问时二次确认；当前已是完全访问（且非计划模式）则重复选择不再询问。
	const changeApproval = async (value: SessionView["approval"]): Promise<void> => {
		if (value === "yolo" && (approval !== "yolo" || plan)) {
			setYoloConfirmOpen(true);
			return;
		}
		await applyApproval(value);
	};

	const applyApproval = async (value: SessionView["approval"]): Promise<void> => {
		try {
			if (current === undefined) {
				dispatch({ type: "draft-options", options: { approval: value, plan: false } });
				return;
			}
			if (plan) await call(window.moros.sessionSetPlan(false));
			await call(window.moros.sessionSelectApproval(value));
		} catch (error) {
			report(error);
		}
	};

	const selectPlan = (): void => {
		if (plan) return;
		if (current === undefined) dispatch({ type: "draft-options", options: { plan: true } });
		else void call(window.moros.sessionSetPlan(true)).catch(report);
	};

	return (
		<div
			className={`composer-wrap ${dragging ? "is-dragging" : ""}`}
			onDragOver={(event) => {
				event.preventDefault();
				if (!disabled) setDragging(true);
			}}
			onDragLeave={() => setDragging(false)}
			onDrop={onDrop}
		>
			{current !== undefined && current.queued > 0 ? (
				<div className="queue-bar">
					<span>
						已排队 {current.queued} 条{queued[0] === undefined ? "" : ` · ${truncate(queued[0].text, 80)}`}
					</span>
					<button
						className="ghost-button small"
						onClick={() => {
							void call(window.moros.chatClearQueue()).catch(report);
						}}
					>
						清空
					</button>
				</div>
			) : null}

			<div className="composer">
				{current === undefined ? (
					<div className="composer-project">
						<ProjectPicker />
					</div>
				) : null}
				{showUrlInput ? (
					<div className="url-attach">
						<LinkIcon size={14} />
						<input
							autoFocus
							value={imageUrl}
							placeholder="https://example.com/image.png"
							onChange={(event) => setImageUrl(event.target.value)}
							onKeyDown={(event) => {
								if (event.key === "Enter") {
									event.preventDefault();
									void addImageUrl();
								}
								if (event.key === "Escape") {
									setShowUrlInput(false);
									setImageUrl("");
								}
							}}
						/>
						<button className="ghost-button small" onClick={() => void addImageUrl()}>
							添加
						</button>
						<button
							className="icon-button"
							aria-label="取消"
							onClick={() => {
								setShowUrlInput(false);
								setImageUrl("");
							}}
						>
							<XIcon size={14} />
						</button>
					</div>
				) : null}
				{images.length > 0 ? (
					<div className="attachments">
						{images.map((image) => (
							<div className="attachment" key={image.id}>
								<img src={image.dataUrl} alt="" />
								<button
									className="attachment-remove"
									aria-label="移除图片"
									onClick={() => dispatch({ type: "draft-image-removed", id: image.id })}
								>
									<XIcon size={12} />
								</button>
							</div>
						))}
					</div>
				) : null}

				<textarea
					className="composer-input"
					ref={textarea}
					value={text}
					rows={1}
					disabled={disabled}
					placeholder={
						trustBlocked
							? "请先确认工作区信任"
							: readOnly
								? "该会话正在另一个窗口中使用，当前为只读"
								: "描述你的任务，/调用指令，@文件或对话"
					}
					onChange={(event) => dispatch({ type: "draft-text", text: event.target.value })}
					onPaste={onPaste}
					onKeyDown={(event) => {
						if (event.key !== "Enter" || event.shiftKey || (event.nativeEvent as KeyboardEvent).isComposing) return;
						event.preventDefault();
						void send();
					}}
				/>

				<div className="composer-toolbar">
					<div className="composer-left">
						<div className="attach-wrap">
							<button
								className="add-button"
								title="添加附件"
								aria-label="添加附件"
								disabled={disabled}
								onClick={() => setAttachMenu(!attachMenu)}
							>
								<PlusIcon size={16} />
							</button>
							{attachMenu ? (
								<>
									<div className="menu-backdrop" onClick={() => setAttachMenu(false)} />
									<div className="attach-menu">
										<button
											onClick={() => {
												void attach();
											}}
										>
											<ImageIcon size={15} />
											图片文件
										</button>
										<button
											onClick={() => {
												setAttachMenu(false);
												setShowUrlInput(true);
											}}
										>
											<LinkIcon size={15} />
											图片链接
										</button>
									</div>
								</>
							) : null}
						</div>
						<ApprovalPicker
							approval={approval}
							plan={plan}
							disabled={disabled || isSending}
							planDisabled={running || disabled || isSending}
							onChange={(value) => void changeApproval(value)}
							onSelectPlan={selectPlan}
						/>
					</div>
					<div className="composer-right">
						<ModelEffortPicker
							model={model}
							effort={effort}
							isDraft={current === undefined}
							disabled={disabled || isSending}
							onModelChange={changeModel}
							onEffortChange={(value) => void changeEffort(value)}
						/>
						<button
							className={`send-button ${stoppable ? "is-stop" : canSend ? "is-ready" : ""}`}
							title={stoppable ? "停止当前回合" : "发送"}
							aria-label={stoppable ? "停止当前回合" : "发送"}
							disabled={!stoppable && (disabled || isSending || !canSend)}
							onClick={() => {
								if (stoppable) {
									void call(window.moros.chatAbort()).catch(report);
									return;
								}
								void send();
							}}
						>
							<span className="send-glyph">
								<ArrowUpIcon size={19} className="glyph-arrow" />
								<StopIcon size={15} className="glyph-stop" />
							</span>
						</button>
					</div>
				</div>
			</div>
			{dragging ? <div className="drop-hint">松开以添加图片</div> : null}
			{yoloConfirmOpen ? (
				<YoloConfirmModal
					onCancel={() => setYoloConfirmOpen(false)}
					onConfirm={() => {
						setYoloConfirmOpen(false);
						void applyApproval("yolo");
					}}
				/>
			) : null}
		</div>
	);
}

/**
 * 完全访问权限的二次确认弹窗：列出高风险能力并要求显式勾选后确认。
 * 用 portal 挂到 body，避免被输入栏的层叠上下文裁切。
 */
function YoloConfirmModal({
	onCancel,
	onConfirm,
}: {
	readonly onCancel: () => void;
	readonly onConfirm: () => void;
}): JSX.Element {
	const [acknowledged, setAcknowledged] = useState(false);
	return createPortal(
		<div className="modal-backdrop" onClick={onCancel}>
			<div
				className="rename-dialog yolo-dialog"
				role="dialog"
				aria-label="确认允许完全访问"
				onClick={(event) => event.stopPropagation()}
			>
				<div className="modal-head">
					<h2>启用完全访问模式？</h2>
					<button className="icon-button" aria-label="关闭" onClick={onCancel}>
						<XIcon size={16} />
					</button>
				</div>
				<p className="yolo-intro">
					此模式下 Agent 执行操作不再逐条征求确认，仅危险命令仍由策略拦截。请确认你了解以下影响：
				</p>
				<ul className="yolo-risk-list">
					<li>
						<FolderIcon size={15} />
						<div>
							<strong>文件读写</strong>
							<span>可在工作区内外读取、修改或删除文件</span>
						</div>
					</li>
					<li>
						<TerminalIcon size={15} />
						<div>
							<strong>Shell 命令</strong>
							<span>可直接执行终端命令、安装依赖、改动系统设置</span>
						</div>
					</li>
					<li>
						<GlobeIcon size={15} />
						<div>
							<strong>联网与工具</strong>
							<span>可访问网络、调用已启用的 MCP 工具并向外发送数据</span>
						</div>
					</li>
				</ul>
				<label className="discover-check yolo-confirm-check">
					<input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} />
					<span>我已知晓风险，愿意自行承担数据安全责任</span>
				</label>
				<div className="modal-actions">
					<button className="ghost-button" onClick={onCancel}>
						取消
					</button>
					<button className="danger-button" disabled={!acknowledged} onClick={onConfirm}>
						仍要启用
					</button>
				</div>
			</div>
		</div>,
		document.body,
	);
}

const EFFORT_OPTIONS: readonly { readonly value: SessionView["effort"]; readonly label: string }[] = [
	{ value: "off", label: "Off" },
	{ value: "minimal", label: "Minimal" },
	{ value: "low", label: "Low" },
	{ value: "medium", label: "Medium" },
	{ value: "high", label: "High" },
	{ value: "max", label: "Max" },
];

/**
 * 模型与推理强度合并菜单：第一级选供应商，第二级选模型与推理强度。
 * 第二级分两组：选供应商或模型保持菜单开启（选完模型可继续选强度），选强度后关闭；重新打开总是从供应商列表开始。
 */
function ModelEffortPicker({
	model,
	effort,
	isDraft,
	disabled,
	onModelChange,
	onEffortChange,
}: {
	readonly model: SessionView["model"];
	readonly effort: SessionView["effort"];
	readonly isDraft: boolean;
	readonly disabled: boolean;
	readonly onModelChange: (value: string) => Promise<void>;
	readonly onEffortChange: (value: SessionView["effort"]) => void;
}): JSX.Element {
	const { state } = useApp();
	const [providerName, setProviderName] = useState<string | undefined>();
	const providers = state.models.providers;
	const provider = providerName === undefined ? undefined : providers.find((item) => item.name === providerName);
	const selectedValue = model === undefined ? "" : JSON.stringify([model.provider, model.model]);
	const selectedEntry =
		model === undefined
			? undefined
			: providers.find((item) => item.name === model.provider)?.models.find((entry) => entry.id === model.model);
	// 触发器显示模型名称（无名称回退 ID）；下拉列表里才显示 ID，ID 是供应商间的唯一标识。
	const modelLabel = model === undefined ? "选择模型" : (selectedEntry?.name ?? model.model);
	const title =
		providers.length === 0
			? "暂无可用供应商，请先在设置中添加"
			: isDraft
				? "模型与推理强度（未选择时使用工作区默认）"
				: "切换当前会话的模型与推理强度，不影响其他会话；新会话使用默认设置";

	useEffect(() => {
		if (providerName === undefined) return;
		if (!providers.some((item) => item.name === providerName)) setProviderName(undefined);
	}, [providers, providerName]);

	const providerOptions: DropdownOption[] = providers.map((item) => ({
		value: item.name,
		label: item.name,
		group: "供应商",
		selected: item.name === model?.provider,
	}));

	const modelOptions: DropdownOption[] =
		provider === undefined
			? []
			: provider.models.length === 0
				? [{ value: "__no_models__", label: "该供应商暂无模型", group: "模型", disabled: true }]
				: provider.models.map((entry) => {
						const value = JSON.stringify([provider.name, entry.id]);
						return {
							value,
							label: entry.id,
							group: "模型",
							selected: value === selectedValue,
						};
					});

	// 推理档位严格按模型配置列出，判断顺序固定：显式关闭（reasoning=false）→ 只有 Off；
	// 配置了档位就只列这些；档位为空数组 → 只有 Off；未配置档位（旧版配置）→ 全档位可选。
	const effortValues: readonly SessionView["effort"][] =
		selectedEntry === undefined
			? EFFORT_OPTIONS.map((option) => option.value)
			: selectedEntry.reasoning === false
				? ["off"]
				: selectedEntry.reasoningEfforts === undefined
					? EFFORT_OPTIONS.map((option) => option.value)
					: selectedEntry.reasoningEfforts.length === 0
						? ["off"]
						: selectedEntry.reasoningEfforts;
	const effortOptions: DropdownOption[] = effortValues.map((value) => ({
		value,
		label: effortLabel(value),
		group: "推理强度",
		selected: value === effort,
	}));

	return (
		<Dropdown
			className="model-picker"
			variant="inline"
			disabled={disabled}
			title={title}
			value={provider === undefined ? (model?.provider ?? "") : selectedValue}
			options={provider === undefined ? providerOptions : [...modelOptions, ...effortOptions]}
			emptyState={
				providers.length === 0 ? (
					<div className="dropdown-empty">
						<PlugIcon size={18} />
						<span className="dropdown-empty-title">暂无可用供应商</span>
						<span>请先在设置中添加供应商与模型</span>
					</div>
				) : undefined
			}
			keepOpenOnSelect={(value) => !EFFORT_OPTIONS.some((option) => option.value === value)}
			onOpenChange={(open) => {
				if (!open) setProviderName(undefined);
			}}
			menuHeader={
				provider === undefined ? undefined : (
					<button
						type="button"
						className="dropdown-menu-back"
						title="返回供应商列表"
						onClick={() => setProviderName(undefined)}
					>
						<ChevronLeftIcon size={13} />
						<span>{provider.name}</span>
					</button>
				)
			}
			trigger={
				model === undefined ? (
					<span>选择模型 · 推理</span>
				) : (
					<>
						<span className="model-picker-model">{modelLabel}</span>
						<span className="model-picker-effort">{` · ${effortLabel(effort)}`}</span>
					</>
				)
			}
			onChange={(value) => {
				if (provider === undefined) {
					setProviderName(value);
					return;
				}
				if (EFFORT_OPTIONS.some((option) => option.value === value)) {
					onEffortChange(value as SessionView["effort"]);
					return;
				}
				void onModelChange(value);
			}}
		/>
	);
}

function ApprovalPicker({
	approval,
	plan,
	disabled,
	planDisabled,
	onChange,
	onSelectPlan,
}: {
	readonly approval: SessionView["approval"];
	readonly plan: boolean;
	readonly disabled: boolean;
	readonly planDisabled: boolean;
	readonly onChange: (value: SessionView["approval"]) => void;
	readonly onSelectPlan: () => void;
}): JSX.Element {
	return (
		<Dropdown
			className={`permission ${plan ? "is-plan" : ""}`}
			variant="inline"
			title="权限模式（仅本会话，不回写配置）"
			disabled={disabled}
			value={plan ? "plan" : approval}
			options={[
				{
					value: "ask",
					label: "每次询问",
					description: "每次操作前都询问你",
					icon: <PointerIcon size={14} />,
				},
				{
					value: "auto",
					label: "自动批准",
					description: "低中风险自动放行高风险先审查",
					icon: <ShieldCheckIcon size={14} />,
				},
				{
					value: "yolo",
					label: "完全访问",
					description: "不再询问但危险命令仍会被拦截",
					icon: <ShieldAlertIcon size={14} />,
				},
			]}
			actions={[
				{
					label: "计划模式",
					value: "plan",
					description: "只探索并提交计划不修改文件",
					icon: <LightbulbIcon size={14} />,
					selected: plan,
					disabled: planDisabled,
					onSelect: onSelectPlan,
				},
			]}
			trigger={
				<>
					{plan ? <LightbulbIcon size={16} /> : approvalIcon(approval)}
					<span>{plan ? "计划模式" : approvalLabel(approval)}</span>
				</>
			}
			onChange={(value) => onChange(value as SessionView["approval"])}
		/>
	);
}

function approvalLabel(mode: SessionView["approval"]): string {
	if (mode === "ask") return "每次询问";
	if (mode === "auto") return "自动批准";
	return "完全访问";
}

function approvalIcon(mode: SessionView["approval"]): JSX.Element {
	if (mode === "ask") return <PointerIcon size={16} />;
	if (mode === "auto") return <ShieldCheckIcon size={16} />;
	return <ShieldAlertIcon size={16} />;
}

function effortLabel(effort: SessionView["effort"]): string {
	if (effort === "off") return "Off";
	if (effort === "minimal") return "Minimal";
	if (effort === "low") return "Low";
	if (effort === "medium") return "Medium";
	if (effort === "high") return "High";
	return "Max";
}

function truncate(text: string, limit: number): string {
	if (text.length <= limit) return text;
	return `${text.slice(0, limit - 1)}…`;
}
