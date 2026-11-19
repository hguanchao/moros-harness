import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type JSX } from "react";

import type { SettingsSnapshot } from "@moros/core/config/settings.ts";
import type { ModelCatalog } from "@moros/core/core.ts";
import type { PreparedImage, SessionView } from "../shared/contract.ts";
import { call, errorMessage } from "../api/api.ts";
import { currentNavigationEpoch, useDesktopActions } from "../hooks/actions.ts";
import { Dropdown, type DropdownOption } from "./Dropdown.tsx";
import { ProjectPicker } from "./ProjectPicker.tsx";
import {
	ArrowUpIcon,
	ImageIcon,
	LightbulbIcon,
	LinkIcon,
	PlusIcon,
	PointerIcon,
	ShieldAlertIcon,
	ShieldCheckIcon,
	StopIcon,
	XIcon,
} from "./Icons.tsx";
import { useApp } from "../store/state.tsx";
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
	const disabled = !state.ready || state.isNavigating || readOnly || trustBlocked;
	const canSend = !disabled && !isSending && (text.trim().length > 0 || images.length > 0);
	const queued = state.queue[current?.meta.id ?? ""] ?? [];
	const model =
		current === undefined ? (state.draft.model ?? configuredModel(state.models, state.settings)) : current.model;
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
		try {
			if (current === undefined) dispatch({ type: "draft-options", options: { model: selected } });
			else await call(window.moros.sessionSelectModel(selected.provider, selected.model));
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
	const changeApproval = async (value: SessionView["approval"]): Promise<void> => {
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
						<ModelPicker
							model={model}
							isDraft={current === undefined}
							disabled={disabled || isSending}
							onChange={changeModel}
						/>
						<EffortPicker
							effort={effort}
							isDraft={current === undefined}
							disabled={disabled || isSending}
							onChange={(value) => void changeEffort(value)}
						/>
						{running ? (
							<button
								className="stop-button"
								title="停止当前回合"
								onClick={() => {
									void call(window.moros.chatAbort()).catch(report);
								}}
							>
								<StopIcon size={16} />
							</button>
						) : null}
						<button
							className={`send-button ${canSend ? "is-ready" : ""}`}
							title={running ? "加入队列" : "发送"}
							disabled={disabled || isSending}
							onClick={() => void send()}
						>
							<ArrowUpIcon size={19} />
						</button>
					</div>
				</div>
			</div>
			{dragging ? <div className="drop-hint">松开以添加图片</div> : null}
		</div>
	);
}

function ModelPicker({
	model,
	isDraft,
	disabled,
	onChange,
}: {
	readonly model: SessionView["model"];
	readonly isDraft: boolean;
	readonly disabled: boolean;
	readonly onChange: (value: string) => Promise<void>;
}): JSX.Element {
	const { state } = useApp();
	const providers = state.models.providers;
	const selectedValue = model === undefined ? "" : JSON.stringify([model.provider, model.model]);
	const label =
		model === undefined
			? "选择模型"
			: (providers
					.find((provider) => provider.name === model.provider)
					?.models.find((entry) => entry.id === model.model)?.name ?? model.model);
	const options: DropdownOption[] = [{ value: "", label: "选择模型", disabled: true }];
	for (const provider of providers) {
		options.push(
			...provider.models.map((entry) => ({
				value: JSON.stringify([provider.name, entry.id]),
				label: entry.name ?? entry.id,
				group: provider.name,
			})),
		);
	}
	return (
		<Dropdown
			className="model-picker"
			variant="inline"
			disabled={disabled}
			title={isDraft ? "新任务模型（未选择时使用工作区默认）" : "切换模型（同时写入全局默认）"}
			value={selectedValue}
			options={options}
			placeholder="选择模型"
			trigger={<span>{label}</span>}
			onChange={(value) => void onChange(value)}
		/>
	);
}

function EffortPicker({
	effort,
	isDraft,
	disabled,
	onChange,
}: {
	readonly effort: SessionView["effort"];
	readonly isDraft: boolean;
	readonly disabled: boolean;
	readonly onChange: (value: SessionView["effort"]) => void;
}): JSX.Element {
	return (
		<Dropdown
			className="effort-picker"
			variant="inline"
			disabled={disabled}
			title={isDraft ? "新任务推理强度（未选择时使用工作区默认）" : "推理强度（同时写入全局默认）"}
			value={effort}
			options={[
				{ value: "off", label: "Off" },
				{ value: "minimal", label: "Minimal" },
				{ value: "low", label: "Low" },
				{ value: "medium", label: "Medium" },
				{ value: "high", label: "High" },
				{ value: "max", label: "Max" },
			]}
			trigger={<span>{effortLabel(effort)}</span>}
			onChange={(value) => onChange(value as SessionView["effort"])}
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
					label: "每次确认",
					description: "每次操作前都询问你",
					icon: <PointerIcon size={14} />,
				},
				{
					value: "auto",
					label: "自动审批",
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

function configuredModel(catalog: ModelCatalog, settings: SettingsSnapshot | undefined): SessionView["model"] {
	const configured = settings?.config.model;
	if (configured === undefined) return undefined;
	for (const provider of catalog.providers) {
		if (settings?.config.provider !== undefined && settings.config.provider !== provider.name) continue;
		const model = provider.models.find(
			(entry) => entry.id === configured || `${provider.name}/${entry.id}` === configured,
		);
		if (model !== undefined) return { provider: provider.name, model: model.id };
	}
	return undefined;
}

function approvalLabel(mode: SessionView["approval"]): string {
	if (mode === "ask") return "每次确认";
	if (mode === "auto") return "自动审批";
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
