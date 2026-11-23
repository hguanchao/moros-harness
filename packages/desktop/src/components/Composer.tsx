import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type JSX, type KeyboardEvent } from "react";
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
import type { DraftCommand, DraftMention, DraftQuote } from "../store/draft.ts";
import { availableModel, clampEffortToModel, configuredModel } from "../utils/model.ts";
import { workspaceTarget, workspaceTargetsMatch } from "../utils/workspace.ts";
import {
	buildModelInput,
	MAX_FILE_INLINE_BYTES,
	MAX_TOTAL_INLINE_BYTES,
	truncateToBudget,
	type InlineFile,
} from "../utils/model-input.ts";
import { ComposerEditor, type ComposerEditorHandle } from "./editor/ComposerEditor.tsx";
import type { ChipData } from "./editor/ChipNode.tsx";
import {
	filterCommands,
	filterConnectors,
	filterFiles,
	filterSkills,
	findAtToken,
	findSkillToken,
	findSlashToken,
	type TriggerToken,
} from "../utils/inline-completion.ts";
import { DESKTOP_COMMANDS } from "../utils/command-list.ts";
import { runDesktopCommand, splitCommand, type CommandHandlers } from "../utils/command-runner.ts";
import { InlineCompletion, type CompletionOption, type CompletionTrigger } from "./InlineCompletion.tsx";

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/** MCP 连接状态的中文标签；连接器没有 detail 时作为说明文字。 */
function mcpStatusLabel(status: "connecting" | "connected" | "unreachable" | "disabled"): string {
	switch (status) {
		case "connected":
			return "已连接";
		case "connecting":
			return "连接中";
		case "unreachable":
			return "未连接";
		case "disabled":
			return "已禁用";
	}
}

/** 行内补全的当前状态（同时写入 state 与 ref，见 completionRef）。 */
interface CompletionState {
	readonly trigger: CompletionTrigger;
	readonly token: TriggerToken;
	readonly options: readonly CompletionOption[];
	readonly activeIndex: number;
	readonly rect: { left: number; bottom: number; top: number };
}

/** 输入框与首发/运行控制；信任页由 ChatPage 负责，新任务首次有效发送才创建会话。 */
export function Composer(): JSX.Element {
	const { state, dispatch } = useApp();
	const actions = useDesktopActions();
	const current = state.current;
	const project = state.project;
	const { text, images, quotes, mentions, commands } = state.draft;
	const isSending = state.isSending;
	const [dragging, setDragging] = useState(false);
	const [attachMenu, setAttachMenu] = useState(false);
	const [showUrlInput, setShowUrlInput] = useState(false);
	const [imageUrl, setImageUrl] = useState("");
	const [yoloConfirmOpen, setYoloConfirmOpen] = useState(false);
	const editorRef = useRef<ComposerEditorHandle | null>(null);
	const isSubmitting = useRef(false);
	// 编辑器 draft：正文 + chip（编辑器是 chip 真相，回写 draft.quotes/mentions/commands）。
	const editorDraft = useMemo(
		() => ({
			text,
			quotes: quotes.map((q) => ({ id: q.id, kind: "quote" as const, value: q.text, label: q.display })),
			mentions: mentions.map((m) => ({ id: m.id, kind: m.kind, value: m.value, label: m.display })),
			commands: commands.map((c) => ({ id: c.id, kind: "command" as const, value: c.value, label: c.display })),
		}),
		[text, quotes, mentions, commands],
	);
	const handleEditorChange = useCallback(
		(next: {
			text: string;
			quotes: readonly ChipData[];
			mentions: readonly ChipData[];
			commands: readonly ChipData[];
		}): void => {
			const nextQuotes: DraftQuote[] = next.quotes.map((c) => ({
				id: c.id,
				text: c.value,
				display: c.label,
			}));
			const nextMentions: DraftMention[] = next.mentions.map((c) => ({
				id: c.id,
				kind: c.kind === "skill" ? "skill" : c.kind === "mcp" ? "mcp" : "file",
				value: c.value,
				display: c.label,
			}));
			const nextCommands: DraftCommand[] = next.commands.map((c) => ({
				id: c.id,
				value: c.value,
				display: c.label,
			}));
			dispatch({
				type: "draft-sync",
				text: next.text,
				quotes: nextQuotes,
				mentions: nextMentions,
				commands: nextCommands,
			});
		},
		[dispatch],
	);
	// 行内补全状态；Esc 关闭后记住 dismissed，输入变化才重置。
	const [completion, setCompletion] = useState<CompletionState | undefined>(undefined);
	// 键盘事件（捕获阶段）与异步补全计算之间可能有竞态：state 更新尚未渲染时 Enter
	// 读到旧值会误走发送。用 ref 镜像最新值，keydown 一律读 ref，保证与浮层一致。
	const completionRef = useRef<CompletionState | undefined>(undefined);
	const setCompletionSafe = useCallback((next: CompletionState | undefined): void => {
		completionRef.current = next;
		setCompletion(next);
	}, []);
	const completionDismissed = useRef(false);
	/** @ 文件数据源缓存（会话内复用）。 */
	const fileListCache = useRef<readonly string[] | undefined>(undefined);
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
	const canSend =
		!disabled &&
		!isSending &&
		(text.trim().length > 0 || images.length > 0 || quotes.length > 0 || mentions.length > 0 || commands.length > 0);
	const queued = state.queue[current?.meta.id ?? ""] ?? [];
	const model =
		current === undefined
			? availableModel(state.models, state.draft.model ?? configuredModel(state.models, state.settings))
			: availableModel(state.models, current.model);
	const effort = current?.effort ?? state.draft.effort ?? state.settings?.config.reasoningEffort ?? "off";
	const approval = current?.approval ?? state.draft.approval ?? state.settings?.config.approval ?? "ask";
	const plan = current?.plan ?? state.draft.plan;

	useEffect(() => {
		if (!disabled) editorRef.current?.focus();
	}, [current?.meta.id, state.draftGeneration, disabled]);

	// 补全浮层打开时，点击编辑器与浮层之外即关闭（等价于"失去焦点"）。
	// 浮层用 portal 渲染到 body，不在 .composer 内，故用 role=listbox 判定。
	useEffect(() => {
		if (completion === undefined) return;
		const onPointerDown = (event: PointerEvent): void => {
			const target = event.target as Node;
			const editorEl = document.querySelector(".composer .composer-input");
			const inCompletion = target instanceof Element && target.closest('[role="listbox"]') !== null;
			if ((editorEl === null || !editorEl.contains(target)) && !inCompletion) {
				completionDismissed.current = true;
				setCompletionSafe(undefined);
			}
		};
		document.addEventListener("pointerdown", onPointerDown);
		return () => document.removeEventListener("pointerdown", onPointerDown);
	}, [completion, setCompletionSafe]);

	const report = (error: unknown): void => {
		if (current !== undefined) {
			dispatch({ type: "inline-notice", sessionId: current.meta.id, tone: "error", text: errorMessage(error) });
		} else {
			console.error(`[moros] ${errorMessage(error)}`);
		}
	};

	// ---------- 行内补全（/ @ $）----------
	const IGNORED_DIRS = new Set(["node_modules", ".git", ".moros", "dist", "build", "coverage"]);

	/** 递归列举项目文件（深度≤3、全局上限 2000、忽略常见目录），结果缓存复用。 */
	const listProjectFiles = useCallback(async (): Promise<readonly string[]> => {
		if (fileListCache.current !== undefined) return fileListCache.current;
		const found: string[] = [];
		const walk = async (dir: string, depth: number): Promise<void> => {
			if (depth > 3 || found.length >= 2000) return;
			let entries;
			try {
				entries = await call(window.moros.workspaceList(dir));
			} catch {
				return;
			}
			for (const entry of entries) {
				if (found.length >= 2000) break;
				if (entry.kind === "directory") {
					if (IGNORED_DIRS.has(entry.name)) continue;
					await walk(entry.path, depth + 1);
				} else if (entry.kind === "file") {
					found.push(entry.path);
				}
			}
		};
		await walk("", 0);
		fileListCache.current = found;
		return found;
	}, []);

	/** 命令处理器：只保留桌面端没有专门 UI 入口的两条命令。 */
	const commandHandlers: CommandHandlers = {
		compact: () => {
			void call(window.moros.sessionsCompact()).catch(report);
		},
		review: (args) => {
			void call(window.moros.sessionsReview(args)).catch(report);
		},
	};

	/**
	 * 读取 file mention 的内容并按预算内联；失败/二进制/超预算降级为占位文本，不阻断发送。
	 * 必须在会话确定（工作区已切换）之后调用，否则首条消息会读到旧工作区。
	 */
	const collectInlineFilesFromMentions = async (activeMentions: readonly DraftMention[]): Promise<InlineFile[]> => {
		const files: InlineFile[] = [];
		let used = 0;
		for (const mention of activeMentions) {
			if (mention.kind !== "file") continue;
			try {
				const result = await call(window.moros.workspaceRead(mention.value));
				if (result.binary || result.text === null) {
					files.push({ path: mention.value, text: "", note: `(binary or unreadable; use the Read tool)` });
					continue;
				}
				const remaining = MAX_TOTAL_INLINE_BYTES - used;
				const budget = Math.min(MAX_FILE_INLINE_BYTES, remaining);
				if (budget <= 0) {
					files.push({ path: mention.value, text: "", note: `(skipped: inline budget reached; use the Read tool)` });
					continue;
				}
				const clipped = truncateToBudget(result.text, budget);
				used += new TextEncoder().encode(clipped.text).length;
				files.push({ path: mention.value, text: clipped.text, truncated: clipped.truncated || result.truncated });
			} catch {
				files.push({ path: mention.value, text: "", note: `(not found or unreadable; use the Read tool)` });
			}
		}
		return files;
	};

	const send = async (): Promise<void> => {
		if (disabled || isSending || isSubmitting.current) return;
		const hasMessage = text.trim().length > 0 || images.length > 0 || quotes.length > 0 || mentions.length > 0;
		if (!hasMessage && commands.length === 0) return;
		const epoch = currentNavigationEpoch();
		const generation = state.draftGeneration;
		const revision = state.draftRevision;
		const imageIds = images.map((image) => image.id);
		isSubmitting.current = true;
		dispatch({ type: "sending", isSending: true });
		try {
			// / 命令 chip 在发送时才执行：value 可能带说明（"/review 审查 API"），拆成名与参数。
			for (const command of commands) {
				const { name: commandName, args: commandArgs } = splitCommand(command.value);
				await runDesktopCommand(commandName, commandArgs, commandHandlers);
			}
			// 只有命令、没有消息内容时，执行完即清空草稿，不建会话也不发消息。
			if (!hasMessage) {
				dispatch({ type: "draft-sent", generation, revision, imageIds });
				return;
			}
			let session = current;
			if (session === undefined) {
				const draftProject = state.draft.project;
				const draftBranch = state.draft.branch;
				const target = workspaceTarget(draftProject);
				const prepared = await actions.prepareTask(target, generation);
				if (prepared === undefined || epoch !== currentNavigationEpoch()) return;
				if (prepared.trust.required && prepared.trust.decision === null) {
					// 信任确认由 TrustGate 界面呈现，不再额外弹提示。
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
			// chip 由编辑器真相同步到 draft，直接全用；text 已是纯正文（不含 chip 显示文字）。
			const files = await collectInlineFilesFromMentions(mentions);
			const message = buildModelInput({ text: text.trim(), quotes, mentions, files });
			await call(
				window.moros.chatSend({
					sessionId: session.meta.id,
					text: message,
					...(imageIds.length === 0 ? {} : { imageIds }),
				}),
			);
			dispatch({ type: "draft-sent", generation, revision, imageIds });
		} catch (error) {
			report(error);
		} finally {
			isSubmitting.current = false;
			dispatch({ type: "sending", isSending: false });
		}
	};

	/** 根据编辑器提供的正文/光标/位置重算补全浮层。 */
	const updateCompletion = (value: string, cursor: number, rect: DOMRect | undefined): void => {
		if (completionDismissed.current) return;
		// 先算 / 命令补全：它容忍尾随空格（"/ "），用户敲 / 后顺手带的空格不该
		// 让浮层消失——否则浮层看着还开着、回车时 completion 却已清空而误发送。
		const slash = findSlashToken(value, cursor);
		if (slash === undefined && cursor > 0 && /\s/.test(value[cursor - 1] ?? "")) {
			// @/$ 的尾随空格：chip 已插入，不该再弹补全。
			setCompletionSafe(undefined);
			return;
		}
		const detected = slash ?? findAtToken(value, cursor) ?? findSkillToken(value, cursor);
		if (detected === undefined || rect === undefined) {
			setCompletionSafe(undefined);
			return;
		}
		const trigger: CompletionTrigger = value[detected.start] === "/" ? "/" : value[detected.start] === "@" ? "@" : "$";
		const anchor = { left: rect.left, bottom: rect.bottom, top: rect.top };
		void (async () => {
			let options: CompletionOption[] = [];
			if (trigger === "/") {
				// 命令菜单分三组：命令 / 技能 / MCP 连接器，都支持按 query 过滤。
				const commandOptions: CompletionOption[] = filterCommands(DESKTOP_COMMANDS, detected.query).map((command) => ({
					value: command.name,
					label: `/${command.name}`,
					description: command.description,
					group: "命令",
					kind: "command",
				}));
				let skillOptions: CompletionOption[] = [];
				let connectorOptions: CompletionOption[] = [];
				try {
					const skills = await call(window.moros.skillsList());
					skillOptions = filterSkills(skills, detected.query).map((skill) => ({
						value: skill.name,
						label: skill.name,
						description: skill.description || skill.scope,
						group: "技能",
						kind: "skill",
					}));
				} catch {
					skillOptions = [];
				}
				try {
					const connectors = await call(window.moros.mcpStatus());
					connectorOptions = filterConnectors(
						connectors.map((connector) => ({
							name: connector.name,
							description: connector.detail.length > 0 ? connector.detail : mcpStatusLabel(connector.status),
						})),
						detected.query,
					).map((connector) => ({
						value: connector.name,
						label: connector.name,
						description: connector.description,
						group: "MCP 连接器",
						kind: "mcp",
					}));
				} catch {
					connectorOptions = [];
				}
				options = [...commandOptions, ...skillOptions, ...connectorOptions];
			} else if (trigger === "@") {
				const files = await listProjectFiles();
				options = filterFiles(files, detected.query).map((path) => ({ value: path, label: path }));
			} else {
				try {
					const skills = await call(window.moros.skillsList());
					options = filterSkills(skills, detected.query).map((skill) => ({
						value: skill.name,
						label: skill.name,
						description: skill.description || skill.scope,
					}));
				} catch {
					options = [];
				}
			}
			setCompletionSafe({ trigger, token: detected, options, activeIndex: 0, rect: anchor });
		})();
	};

	/** 选中补全项：插入对应 chip（/命令、@文件、$技能、MCP 连接器）；命令发送时才执行。 */
	const selectCompletion = (index: number): void => {
		const current = completionRef.current;
		if (current === undefined) return;
		const option = current.options[index];
		if (option === undefined) return;
		const { trigger, token } = current;
		completionDismissed.current = true;
		setCompletionSafe(undefined);
		// 命令菜单里可能混着命令/技能/MCP，优先用选项自带 kind；其余按 trigger 推断。
		const kind: ChipData["kind"] = option.kind ?? (trigger === "/" ? "command" : trigger === "@" ? "file" : "skill");
		const isCommand = kind === "command";
		// /命令可带说明：value 存「命令名 + 空格 + 说明」，发送时用 splitCommand 拆开。
		const commandValue = isCommand && (token.args ?? "").length > 0 ? `${option.value} ${token.args}` : option.value;
		const chip: ChipData = {
			id: crypto.randomUUID(),
			kind,
			value: isCommand ? commandValue : option.value,
			label: isCommand
				? `/${commandValue}`
				: kind === "file"
					? (option.value.split("/").at(-1) ?? option.value)
					: option.value,
		};
		// 先删触发 token，再插入 chip（编辑器原生保证光标与原子删除）。
		editorRef.current?.deleteTriggerToken(token.end - token.start);
		requestAnimationFrame(() => editorRef.current?.insertChip(chip));
	};

	/** 编辑器键盘：补全打开时拦截方向键/Enter/Tab/Esc；返回是否已消费。 */
	const handleCompletionKeyDown = (event: KeyboardEvent<HTMLElement>): boolean => {
		// 读 ref 而非 state：异步补全刚算完、state 尚未渲染时，浮层已可见而 state 还是旧值，
		// 用 state 会让 Enter 漏过补全拦截、误走发送。
		const current = completionRef.current;
		if (current === undefined) return false;
		if (event.key === "ArrowDown") {
			event.preventDefault();
			event.stopPropagation();
			setCompletionSafe({
				...current,
				activeIndex: Math.min(current.activeIndex + 1, Math.max(0, current.options.length - 1)),
			});
			return true;
		}
		if (event.key === "ArrowUp") {
			event.preventDefault();
			event.stopPropagation();
			setCompletionSafe({ ...current, activeIndex: Math.max(current.activeIndex - 1, 0) });
			return true;
		}
		if (event.key === "Enter" || event.key === "Tab") {
			// 没有候选时别吞掉按键：此时 selectCompletion 什么都不做，会变成「回车无反应」。
			if (current.options.length === 0) return false;
			event.preventDefault();
			event.stopPropagation();
			selectCompletion(current.activeIndex);
			return true;
		}
		if (event.key === "Escape") {
			event.preventDefault();
			event.stopPropagation();
			setCompletionSafe(undefined);
			completionDismissed.current = true;
			return true;
		}
		return false;
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
				// 超过单张图片上限时跳过该文件，不再弹提示。
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
				<ComposerEditor
					ref={editorRef}
					draft={editorDraft}
					onChange={handleEditorChange}
					disabled={disabled}
					placeholder={
						trustBlocked
							? "请先确认工作区信任"
							: readOnly
								? "该会话正在另一个窗口中使用，当前为只读"
								: "描述你的任务，/调用指令，@文件，$技能"
					}
					onKeyDown={(event) => {
						if (handleCompletionKeyDown(event)) return;
						if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
						event.preventDefault();
						// 捕获阶段必须 stopPropagation：否则事件继续到 contenteditable 上 Lexical 的
						// 原生 keydown，触发 KEY_ENTER_COMMAND 插入换行（rich-text 处理器不检查
						// defaultPrevented），造成「既发送又换行」。Shift+Enter 不拦截，交给 Lexical
						// 走 INSERT_LINE_BREAK_COMMAND 正常换行。
						event.stopPropagation();
						void send();
					}}
					onSelectionChange={(value, cursor, rect) => {
						completionDismissed.current = false;
						updateCompletion(value, cursor, rect);
					}}
				/>
				{completion === undefined ? null : (
					<InlineCompletion
						trigger={completion.trigger}
						token={completion.token}
						options={completion.options}
						activeIndex={completion.activeIndex}
						rect={completion.rect}
						onSelect={selectCompletion}
						onHover={(index) => setCompletionSafe({ ...completion, activeIndex: index })}
					/>
				)}

				<div className="composer-toolbar">
					<div className="composer-left">
						<div className="attach-wrap">
							<button
								className="add-button"
								data-tooltip="添加附件"
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
							data-tooltip={stoppable ? "停止当前回合" : "发送"}
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
			tooltip={title}
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
						data-tooltip="返回供应商列表"
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
			tooltip="权限模式（仅本会话，不回写配置）"
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
