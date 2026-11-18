import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type JSX } from "react";

import type { PreparedImage, SessionView } from "#src/desktop/shared/contract.ts";
import { call, errorMessage } from "#src/desktop/renderer/api.ts";
import { Dropdown, type DropdownOption } from "#src/desktop/renderer/Dropdown.tsx";
import {
	ArrowUpIcon,
	ImageIcon,
	LinkIcon,
	PlusIcon,
	ShieldIcon,
	SparklesIcon,
	StopIcon,
	XIcon,
} from "#src/desktop/renderer/icons.tsx";
import { useApp } from "#src/desktop/renderer/state.tsx";

const MAX_IMAGES = 8;

/** 输入框与运行控制；审批卡、信任页由 ChatPage 负责，避免输入组件知道所有业务状态。 */
export function Composer(): JSX.Element {
	const { state, dispatch } = useApp();
	const current = state.current;
	const project = state.project;
	const [text, setText] = useState("");
	const [images, setImages] = useState<readonly PreparedImage[]>([]);
	const [sending, setSending] = useState(false);
	const [dragging, setDragging] = useState(false);
	const [attachMenu, setAttachMenu] = useState(false);
	const [showUrlInput, setShowUrlInput] = useState(false);
	const [imageUrl, setImageUrl] = useState("");
	const textarea = useRef<HTMLTextAreaElement | null>(null);

	const trustBlocked = project?.trust.required === true && project.trust.decision === null;
	const readOnly = current?.readOnly === true;
	const running =
		current?.running === true || (current !== undefined && state.runStates[current.meta.id] === "running");
	const disabled = current === undefined || project === undefined || readOnly || trustBlocked;
	const canSend = !disabled && !sending && (text.trim().length > 0 || images.length > 0);
	const queued = state.queue[current?.meta.id ?? ""] ?? [];

	useEffect(() => {
		const element = textarea.current;
		if (element === null) return;
		element.style.height = "auto";
		element.style.height = `${Math.min(element.scrollHeight, 140)}px`;
	}, [text]);

	useEffect(() => {
		if (disabled) return;
		textarea.current?.focus();
	}, [current?.meta.id, disabled]);

	const send = async (): Promise<void> => {
		if (current === undefined || disabled || sending) return;
		const message = text.trim();
		if (message.length === 0 && images.length === 0) return;
		setSending(true);
		try {
			const result = await call(
				window.moros.chatSend({
					sessionId: current.meta.id,
					text: message,
					...(images.length === 0 ? {} : { imageIds: images.map((image) => image.id) }),
				}),
			);
			setText("");
			setImages([]);
			if (result.queued) {
				dispatch({ type: "notice", level: "info", message: "已加入队列，当前回合结束后自动发送" });
			}
		} catch (error) {
			dispatch({ type: "notice", level: "error", message: errorMessage(error) });
		} finally {
			setSending(false);
		}
	};

	const attach = async (): Promise<void> => {
		setAttachMenu(false);
		try {
			const image = await call(window.moros.imagesPick());
			if (image !== null) addImage(image);
		} catch (error) {
			dispatch({ type: "notice", level: "error", message: errorMessage(error) });
		}
	};

	const addImage = (image: PreparedImage): void => {
		setImages((existing) => {
			if (existing.length >= MAX_IMAGES) {
				dispatch({ type: "notice", level: "warn", message: `最多附加 ${MAX_IMAGES} 张图片` });
				return existing;
			}
			if (existing.some((entry) => entry.id === image.id)) return existing;
			return [...existing, image];
		});
	};

	const addFiles = async (files: FileList | readonly File[]): Promise<void> => {
		for (const file of Array.from(files)) {
			if (!file.type.startsWith("image/")) continue;
			if (file.size > 8 * 1024 * 1024) {
				dispatch({ type: "notice", level: "warn", message: `${file.name} 超过单张图片上限` });
				continue;
			}
			try {
				const bytes = new Uint8Array(await file.arrayBuffer());
				addImage(await call(window.moros.imagesFromBytes(bytes, file.type)));
			} catch (error) {
				dispatch({ type: "notice", level: "error", message: errorMessage(error) });
			}
		}
	};

	const addImageUrl = async (): Promise<void> => {
		const url = imageUrl.trim();
		if (url.length === 0) return;
		try {
			addImage(await call(window.moros.imagesFromUrl(url)));
			setImageUrl("");
			setShowUrlInput(false);
		} catch (error) {
			dispatch({ type: "notice", level: "error", message: errorMessage(error) });
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
		if (event.dataTransfer.files.length > 0) void addFiles(event.dataTransfer.files);
	};

	const changeModel = async (value: string): Promise<void> => {
		try {
			const [provider, model] = JSON.parse(value) as [string, string];
			await call(window.moros.sessionSelectModel(provider, model));
		} catch (error) {
			dispatch({ type: "notice", level: "error", message: errorMessage(error) });
		}
	};

	return (
		<div
			className={`composer-wrap ${dragging ? "is-dragging" : ""}`}
			onDragOver={(event) => {
				event.preventDefault();
				setDragging(true);
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
							void window.moros.chatClearQueue().catch((error: unknown) => {
								dispatch({ type: "notice", level: "error", message: errorMessage(error) });
							});
						}}
					>
						清空
					</button>
				</div>
			) : null}

			<div className="composer">
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
									onClick={() => setImages((existing) => existing.filter((entry) => entry.id !== image.id))}
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
								: "描述你想构建的内容"
					}
					onChange={(event) => setText(event.target.value)}
					onPaste={onPaste}
					onKeyDown={(event) => {
						if (event.key !== "Enter" || event.shiftKey) return;
						if ((event.nativeEvent as KeyboardEvent).isComposing) return;
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
						{current !== undefined ? <ApprovalPicker current={current} /> : null}
						{current !== undefined ? (
							<button
								className={`plan-control ${current.plan ? "is-active" : ""}`}
								disabled={running}
								title="只读规划：模型只探索并提交计划"
								onClick={() => {
									void call(window.moros.sessionSetPlan(!current.plan)).catch((error: unknown) => {
										dispatch({ type: "notice", level: "error", message: errorMessage(error) });
									});
								}}
							>
								<SparklesIcon size={15} />
								<span>{current.plan ? "计划模式" : "计划"}</span>
							</button>
						) : null}
					</div>
					<div className="composer-right">
						{current !== undefined ? <ModelPicker current={current} onChange={changeModel} /> : null}
						{current !== undefined ? <EffortPicker current={current} /> : null}
						{running ? (
							<button
								className="stop-button"
								title="停止当前回合"
								onClick={() => {
									void window.moros.chatAbort();
								}}
							>
								<StopIcon size={16} />
							</button>
						) : null}
						<button
							className={`send-button ${canSend ? "is-ready" : ""}`}
							title={running ? "加入队列" : "发送"}
							disabled={disabled || sending}
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
	current,
	onChange,
}: {
	readonly current: SessionView;
	readonly onChange: (value: string) => Promise<void>;
}): JSX.Element {
	const { state } = useApp();
	const providers = state.models.providers;
	const selected = current.model;
	const selectedValue = selected === undefined ? "" : JSON.stringify([selected.provider, selected.model]);
	const label =
		selected === undefined
			? "选择模型"
			: (providers
					.find((provider) => provider.name === selected.provider)
					?.models.find((model) => model.id === selected.model)?.name ?? selected.model);
	const options: DropdownOption[] = [{ value: "", label: "选择模型", disabled: true }];
	for (const provider of providers) {
		options.push(
			...provider.models.map((model) => ({
				value: JSON.stringify([provider.name, model.id]),
				label: model.name ?? model.id,
				group: provider.name,
			})),
		);
	}
	return (
		<Dropdown
			className="model-picker"
			variant="inline"
			title="切换模型（同时写入全局默认）"
			value={selectedValue}
			options={options}
			placeholder="选择模型"
			trigger={
				<>
					<span>{label}</span>
				</>
			}
			onChange={(value) => void onChange(value)}
		/>
	);
}

function EffortPicker({ current }: { readonly current: SessionView }): JSX.Element {
	const { dispatch } = useApp();
	return (
		<Dropdown
			className="effort-picker"
			variant="inline"
			title="推理强度（同时写入全局默认）"
			value={current.effort}
			options={[
				{ value: "off", label: "Off" },
				{ value: "minimal", label: "Minimal" },
				{ value: "low", label: "Low" },
				{ value: "medium", label: "Medium" },
				{ value: "high", label: "High" },
				{ value: "max", label: "Max" },
			]}
			trigger={<span>{effortLabel(current.effort)}</span>}
			onChange={(effort) => {
				void call(window.moros.sessionSelectEffort(effort as SessionView["effort"])).catch((error: unknown) =>
					dispatch({ type: "notice", level: "error", message: errorMessage(error) }),
				);
			}}
		/>
	);
}

function ApprovalPicker({ current }: { readonly current: SessionView }): JSX.Element {
	const { dispatch } = useApp();
	return (
		<Dropdown
			className="permission"
			variant="inline"
			title="审批档位（仅本会话，不回写配置）"
			value={current.approval}
			options={[
				{ value: "ask", label: "每次确认" },
				{ value: "auto", label: "自动审批" },
				{ value: "yolo", label: "全部放行" },
			]}
			trigger={
				<>
					<ShieldIcon size={16} />
					<span>{approvalLabel(current.approval)}</span>
				</>
			}
			onChange={(approval) => {
				void call(window.moros.sessionSelectApproval(approval as SessionView["approval"])).catch((error: unknown) =>
					dispatch({ type: "notice", level: "error", message: errorMessage(error) }),
				);
			}}
		/>
	);
}

function approvalLabel(mode: SessionView["approval"]): string {
	if (mode === "ask") return "每次确认";
	if (mode === "auto") return "自动审批";
	return "全部放行";
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
