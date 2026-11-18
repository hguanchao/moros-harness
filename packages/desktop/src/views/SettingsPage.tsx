import { useEffect, useRef, useState, type JSX } from "react";

import type { SettingsPatch, SettingsSnapshot, ProviderDraft, ProviderView } from "@moros/core/config/settings.ts";
import type { McpStatus } from "@moros/core/mcp/types.ts";
import type { SkillSummary } from "@moros/core/skills.ts";
import type { ConfigSummary } from "../shared/contract.ts";
import { call, errorMessage } from "../api/api.ts";
import { Dropdown } from "../components/Dropdown.tsx";
import {
	AlertIcon,
	CheckIcon,
	EyeIcon,
	EyeOffIcon,
	InfoIcon,
	MoreIcon,
	PencilIcon,
	PlusIcon,
	RefreshIcon,
	ServerIcon,
	TrashIcon,
	XIcon,
} from "../components/Icons.tsx";
import { useApp } from "../store/state.tsx";

const NEW_PROVIDER = "__new__";

const API_OPTIONS: ReadonlyArray<readonly [ProviderView["api"], string]> = [
	["anthropic-messages", "Anthropic Messages (/v1/messages)"],
	["chat-completions", "OpenAI Chat Completions (/v1/chat/completions)"],
	["responses", "OpenAI Responses (/v1/responses)"],
];

interface ModelForm {
	id: string;
	name: string;
	maxTokens: string;
	contextWindow: string;
	reasoning: boolean;
	image: boolean;
}

export interface ProviderForm {
	originalName?: string;
	name: string;
	api: ProviderView["api"];
	baseUrl: string;
	apiKey: string;
	timeoutMs: string;
	models: ModelForm[];
}

interface ModelEditorState {
	readonly index?: number;
	readonly model: ModelForm;
}

function emptyModel(): ModelForm {
	return { id: "", name: "", maxTokens: "8192", contextWindow: "", reasoning: false, image: false };
}

function emptyForm(): ProviderForm {
	return {
		name: "",
		api: "anthropic-messages",
		baseUrl: "",
		apiKey: "",
		timeoutMs: "120000",
		models: [],
	};
}

function formFromProvider(provider: ProviderView): ProviderForm {
	return {
		originalName: provider.name,
		name: provider.name,
		api: provider.api,
		baseUrl: provider.baseUrl,
		apiKey: "",
		timeoutMs: String(provider.timeoutMs),
		models: provider.models.map((model) => ({
			id: model.id,
			name: model.name ?? "",
			maxTokens: String(model.maxTokens),
			contextWindow: model.contextWindow === undefined ? "" : String(model.contextWindow),
			reasoning: model.reasoning,
			image: model.input.includes("image"),
		})),
	};
}

export function ProvidersTab({
	settings,
	onRefresh,
	onNotice,
}: {
	readonly settings: SettingsSnapshot;
	readonly onRefresh: () => Promise<void>;
	readonly onNotice: (level: "info" | "warn" | "error", message: string) => void;
}): JSX.Element {
	const firstProvider = settings.providers[0];
	const [selected, setSelected] = useState<string>(() => firstProvider?.name ?? NEW_PROVIDER);
	const [draft, setDraft] = useState<ProviderForm>(() =>
		firstProvider === undefined ? emptyForm() : formFromProvider(firstProvider),
	);
	const [revealed, setRevealed] = useState<Record<string, string>>({});
	const [modelEditor, setModelEditor] = useState<ModelEditorState | undefined>(undefined);
	const [showKey, setShowKey] = useState(false);
	const [moreOpen, setMoreOpen] = useState(false);
	const [editingName, setEditingName] = useState(false);
	const [renameValue, setRenameValue] = useState("");
	const moreRef = useRef<HTMLDivElement>(null);

	const isNew = selected === NEW_PROVIDER;
	const current = settings.providers.find((provider) => provider.name === selected);
	const keyDisplay = revealed[selected] ?? current?.apiKey.display ?? "";
	const set = (patch: Partial<ProviderForm>): void => setDraft((previous) => ({ ...previous, ...patch }));

	useEffect(() => {
		if (!moreOpen) return;
		const onPointerDown = (event: PointerEvent): void => {
			if (moreRef.current !== null && !moreRef.current.contains(event.target as Node)) setMoreOpen(false);
		};
		document.addEventListener("pointerdown", onPointerDown);
		return () => document.removeEventListener("pointerdown", onPointerDown);
	}, [moreOpen]);

	const selectProvider = (provider: ProviderView): void => {
		setSelected(provider.name);
		setDraft(formFromProvider(provider));
		setRevealed({});
		setShowKey(false);
		setModelEditor(undefined);
		setMoreOpen(false);
		setEditingName(false);
	};

	const startNew = (): void => {
		setSelected(NEW_PROVIDER);
		setDraft(emptyForm());
		setRevealed({});
		setShowKey(false);
		setModelEditor(undefined);
		setMoreOpen(false);
		setEditingName(false);
	};

	/** 组装写回后端的草稿；密钥留空时省略以保留原值。 */
	const buildPayload = (form: ProviderForm): ProviderDraft => {
		const timeout = Number(form.timeoutMs);
		return {
			api: form.api,
			baseUrl: form.baseUrl.trim(),
			timeoutMs: Number.isInteger(timeout) && timeout > 0 ? timeout : 120_000,
			models: form.models.map((model) => ({
				id: model.id.trim(),
				...(model.name.trim().length === 0 ? {} : { name: model.name.trim() }),
				maxTokens: Number(model.maxTokens),
				...(model.contextWindow.trim().length === 0 ? {} : { contextWindow: Number(model.contextWindow) }),
				reasoning: model.reasoning,
				input: model.image ? (["text", "image"] as const) : (["text"] as const),
			})),
			...(form.apiKey.trim().length === 0 ? {} : { apiKey: form.apiKey.trim() }),
		};
	};

	/** 自动保存前置校验：未完成编辑时静默跳过，避免每个按键都弹提示。 */
	const readyToSave = (form: ProviderForm, name: string): boolean => {
		if (name.length === 0) return false;
		try {
			const url = new URL(form.baseUrl.trim());
			if (!["http:", "https:"].includes(url.protocol)) return false;
		} catch {
			return false;
		}
		if (form.models.length === 0) return false;
		for (const model of form.models) {
			if (model.id.trim().length === 0) return false;
			if (!Number.isInteger(Number(model.maxTokens)) || Number(model.maxTokens) <= 0) return false;
			const context = model.contextWindow.trim();
			if (context.length > 0 && (!Number.isInteger(Number(context)) || Number(context) <= 0)) return false;
		}
		return true;
	};

	/** 字段变更后自动保存；可传入覆盖值以绕过 setState 的异步性。 */
	const autoSave = async (overrides?: Partial<ProviderForm>): Promise<void> => {
		const form = { ...draft, ...overrides };
		const name = (isNew ? form.name : selected).trim();
		if (!readyToSave(form, name)) return;
		try {
			await call(window.moros.settingsUpsertProvider(name, buildPayload(form)));
			await onRefresh();
			if (isNew) {
				setSelected(name);
				setDraft((previous) => ({ ...previous, name }));
				setRevealed({});
				setShowKey(false);
			}
		} catch (error) {
			onNotice("error", errorMessage(error));
		}
	};

	const toggleReveal = async (): Promise<void> => {
		if (isNew || current === undefined) {
			setShowKey((previous) => !previous);
			return;
		}
		if (revealed[selected] !== undefined) {
			const next = { ...revealed };
			delete next[selected];
			setRevealed(next);
			set({ apiKey: "" });
			setShowKey(false);
			return;
		}
		try {
			const value = await call(window.moros.settingsRevealSecret(selected));
			setRevealed((previous) => ({ ...previous, [selected]: value }));
			set({ apiKey: value });
			setShowKey(true);
		} catch (error) {
			onNotice("error", errorMessage(error));
		}
	};

	const remove = async (): Promise<void> => {
		if (isNew || current === undefined) return;
		setMoreOpen(false);
		if (!window.confirm(`删除供应商 ${selected}？`)) return;
		try {
			await call(window.moros.settingsDeleteProvider(selected));
			await onRefresh();
			const provider = settings.providers.find((item) => item.name !== selected);
			if (provider === undefined) {
				startNew();
			} else {
				selectProvider(provider);
			}
			onNotice("info", `已删除 ${selected}`);
		} catch (error) {
			onNotice("error", errorMessage(error));
		}
	};

	const startEditName = (): void => {
		setMoreOpen(false);
		if (isNew) return;
		setRenameValue(selected);
		setEditingName(true);
	};

	/** 行内重命名：名称输入框失焦或回车时提交，空值与未变化直接取消。 */
	const commitRename = async (): Promise<void> => {
		const next = renameValue.trim();
		setEditingName(false);
		if (next.length === 0 || next === selected) return;
		try {
			await call(window.moros.settingsRenameProvider(selected, next));
			await onRefresh();
			setSelected(next);
			setDraft((previous) => ({ ...previous, originalName: next, name: next }));
			setRevealed({});
			onNotice("info", `已重命名为 ${next}`);
		} catch (error) {
			onNotice("error", errorMessage(error));
		}
	};

	const commitModel = (model: ModelForm): void => {
		const id = model.id.trim();
		if (id.length === 0) {
			onNotice("warn", "请填写模型 ID");
			return;
		}
		const index = modelEditor?.index;
		if (draft.models.some((item, position) => position !== index && item.id.trim() === id)) {
			onNotice("warn", `模型 ID ${id} 已存在`);
			return;
		}
		const maxTokens = Number(model.maxTokens);
		if (!Number.isInteger(maxTokens) || maxTokens <= 0) {
			onNotice("warn", "maxTokens 必须为正整数");
			return;
		}
		const contextWindow = model.contextWindow.trim();
		if (contextWindow.length > 0 && (!Number.isInteger(Number(contextWindow)) || Number(contextWindow) <= 0)) {
			onNotice("warn", "contextWindow 必须为正整数");
			return;
		}
		const normalized: ModelForm = {
			...model,
			id,
			name: model.name.trim(),
			maxTokens: String(maxTokens),
			contextWindow,
		};
		const nextModels =
			index === undefined
				? [...draft.models, normalized]
				: draft.models.map((item, position) => (position === index ? normalized : item));
		setDraft((previous) => ({ ...previous, models: nextModels }));
		setModelEditor(undefined);
		void autoSave({ models: nextModels });
	};

	const deleteModel = (index: number): void => {
		const nextModels = draft.models.filter((_, position) => position !== index);
		setDraft((previous) => ({ ...previous, models: nextModels }));
		void autoSave({ models: nextModels });
	};

	return (
		<div className="prov-page">
			<div className="prov-page-head">
				<div>
					<h1 className="prov-page-title">模型设置</h1>
					<p className="prov-page-desc">管理自定义模型供应商，配置后可在聊天时选择使用。</p>
				</div>
				<div className="prov-page-actions">
					<button className="icon-button" title="刷新" onClick={() => void onRefresh()}>
						<RefreshIcon size={16} />
					</button>
					<button className="primary-button" onClick={startNew}>
						<PlusIcon size={15} />
						添加供应商
					</button>
				</div>
			</div>

			<div className="prov-workspace">
				<aside className="prov-sidebar">
					<div className="prov-sidebar-label">自定义供应商</div>
					<div className="prov-sidebar-list">
						{settings.providers.map((provider) => (
							<button
								key={provider.name}
								className={`provider-card prov-item ${selected === provider.name ? "is-active" : ""}`}
								onClick={() => selectProvider(provider)}
							>
								<ServerIcon size={15} />
								<span className="prov-item-name">{provider.name}</span>
								<span className={`prov-item-status ${provider.apiKey.source === "empty" ? "is-warn" : "is-ok"}`} />
							</button>
						))}
						{settings.providers.length === 0 ? <div className="prov-sidebar-empty">还没有自定义供应商</div> : null}
					</div>
				</aside>

				<section className="prov-detail">
					<div className="prov-detail-head">
						<div className="prov-detail-identity">
							<span className="prov-detail-icon">
								<ServerIcon size={18} />
							</span>
							{isNew ? (
								<input
									className="prov-name-input is-inline"
									value={draft.name}
									placeholder="新供应商"
									onChange={(event) => set({ name: event.target.value })}
									onBlur={() => void autoSave()}
								/>
							) : editingName ? (
								<input
									className="prov-name-input is-inline"
									value={renameValue}
									autoFocus
									onChange={(event) => setRenameValue(event.target.value)}
									onBlur={() => void commitRename()}
									onKeyDown={(event) => {
										if (event.key === "Enter") commitRename();
										if (event.key === "Escape") {
											setEditingName(false);
											setRenameValue(selected);
										}
									}}
								/>
							) : (
								<h2 className="prov-detail-name" title="双击重命名" onDoubleClick={startEditName}>
									{selected}
								</h2>
							)}
						</div>
						{!isNew ? (
							<div className="prov-more" ref={moreRef}>
								<button className="icon-button" title="更多" onClick={() => setMoreOpen((previous) => !previous)}>
									<MoreIcon size={16} />
								</button>
								{moreOpen ? (
									<div className="prov-more-menu" role="menu">
										<button type="button" role="menuitem" onClick={startEditName}>
											<PencilIcon size={14} />
											重命名
										</button>
										<button type="button" role="menuitem" className="danger" onClick={() => void remove()}>
											<TrashIcon size={14} />
											删除
										</button>
									</div>
								) : null}
							</div>
						) : null}
					</div>

					<div className="prov-fields">
						<label className="prov-field">
							<span>Base URL</span>
							<input
								className="prov-input"
								value={draft.baseUrl}
								placeholder="https://api.example.com/v1"
								onChange={(event) => set({ baseUrl: event.target.value })}
								onBlur={() => void autoSave()}
							/>
						</label>
						<label className="prov-field">
							<span>API 格式</span>
							<Dropdown
								value={draft.api}
								options={API_OPTIONS.map(([value, label]) => ({ value, label }))}
								onChange={(api) => {
									const next = api as ProviderView["api"];
									set({ api: next });
									void autoSave({ api: next });
								}}
							/>
						</label>
						<label className="prov-field">
							<span>API Key</span>
							<span className="prov-key-wrap">
								<input
									className="prov-input"
									type={showKey ? "text" : "password"}
									value={draft.apiKey}
									placeholder={
										isNew ? "输入 API Key" : `留空保持不变${keyDisplay.length > 0 ? `（当前 ${keyDisplay}）` : ""}`
									}
									onChange={(event) => set({ apiKey: event.target.value })}
									onBlur={() => void autoSave()}
								/>
								<button
									type="button"
									className="prov-key-eye"
									title={showKey ? "隐藏" : "显示原始表达式"}
									onClick={() => void toggleReveal()}
								>
									{showKey ? <EyeOffIcon size={15} /> : <EyeIcon size={15} />}
								</button>
							</span>
						</label>
					</div>

					<div className="prov-models">
						<div className="prov-models-head">
							<h3>模型列表</h3>
							<button className="ghost-button small" onClick={() => setModelEditor({ model: emptyModel() })}>
								<PlusIcon size={13} />
								添加模型
							</button>
						</div>
						{draft.models.length === 0 ? (
							<div className="prov-empty">
								<InfoIcon size={16} />
								<span>当前没有配置模型，添加模型后可在聊天中使用。</span>
							</div>
						) : (
							<div className="prov-model-list">
								{draft.models.map((model, index) => (
									<div className="prov-model-card" key={`${index}-${model.id}`}>
										<div className="prov-model-main">
											<div className="prov-model-title">
												<strong>{model.id}</strong>
												{model.name.trim().length > 0 ? <span>{model.name}</span> : null}
											</div>
											<div className="prov-model-meta">
												<span>maxTokens {model.maxTokens}</span>
												{model.contextWindow.trim().length > 0 ? <span>context {model.contextWindow}</span> : null}
												{model.reasoning ? <span className="pill">reasoning</span> : null}
												{model.image ? <span className="pill">image</span> : null}
											</div>
										</div>
										<div className="prov-model-actions">
											<button
												className="icon-button"
												title="编辑模型"
												onClick={() => setModelEditor({ index, model: { ...model } })}
											>
												<PencilIcon size={14} />
											</button>
											<button className="icon-button danger" title="删除模型" onClick={() => deleteModel(index)}>
												<TrashIcon size={14} />
											</button>
										</div>
									</div>
								))}
							</div>
						)}
					</div>
				</section>
			</div>

			{modelEditor !== undefined ? (
				<div
					className="modal-backdrop"
					onMouseDown={(event) => {
						if (event.target === event.currentTarget) setModelEditor(undefined);
					}}
				>
					<div className="modal model-modal" role="dialog" aria-modal="true">
						<div className="modal-head">
							<h3>{modelEditor.index === undefined ? "添加模型" : "编辑模型"}</h3>
							<button className="icon-button" aria-label="关闭" onClick={() => setModelEditor(undefined)}>
								<XIcon size={16} />
							</button>
						</div>
						<div className="field-grid">
							<label className="field">
								<span>模型 ID</span>
								<input
									value={modelEditor.model.id}
									placeholder="例如 claude-sonnet-4"
									onChange={(event) =>
										setModelEditor((previous) =>
											previous === undefined
												? undefined
												: { ...previous, model: { ...previous.model, id: event.target.value } },
										)
									}
								/>
							</label>
							<label className="field">
								<span>显示名称（可选）</span>
								<input
									value={modelEditor.model.name}
									onChange={(event) =>
										setModelEditor((previous) =>
											previous === undefined
												? undefined
												: { ...previous, model: { ...previous.model, name: event.target.value } },
										)
									}
								/>
							</label>
							<label className="field">
								<span>maxTokens</span>
								<input
									value={modelEditor.model.maxTokens}
									onChange={(event) =>
										setModelEditor((previous) =>
											previous === undefined
												? undefined
												: {
														...previous,
														model: { ...previous.model, maxTokens: event.target.value },
													},
										)
									}
								/>
							</label>
							<label className="field">
								<span>contextWindow（可选）</span>
								<input
									value={modelEditor.model.contextWindow}
									onChange={(event) =>
										setModelEditor((previous) =>
											previous === undefined
												? undefined
												: {
														...previous,
														model: { ...previous.model, contextWindow: event.target.value },
													},
										)
									}
								/>
							</label>
							<label className="check">
								<input
									type="checkbox"
									checked={modelEditor.model.reasoning}
									onChange={(event) =>
										setModelEditor((previous) =>
											previous === undefined
												? undefined
												: { ...previous, model: { ...previous.model, reasoning: event.target.checked } },
										)
									}
								/>
								reasoning
							</label>
							<label className="check">
								<input
									type="checkbox"
									checked={modelEditor.model.image}
									onChange={(event) =>
										setModelEditor((previous) =>
											previous === undefined
												? undefined
												: { ...previous, model: { ...previous.model, image: event.target.checked } },
										)
									}
								/>
								image
							</label>
						</div>
						<div className="modal-actions">
							<button className="ghost-button" onClick={() => setModelEditor(undefined)}>
								取消
							</button>
							<button className="primary-button" onClick={() => commitModel(modelEditor.model)}>
								<CheckIcon size={14} />
								保存模型
							</button>
						</div>
					</div>
				</div>
			) : null}
		</div>
	);
}

export function WorkspaceTab({
	settings,
	summary,
	skills,
	mcp,
	mcpHealth,
	onUpdate,
	onHealth,
	onReconnect,
	onTrust,
	onDeny,
}: {
	readonly settings: SettingsSnapshot | undefined;
	readonly summary: ConfigSummary | undefined;
	readonly skills: readonly SkillSummary[];
	readonly mcp: readonly McpStatus[];
	readonly mcpHealth: readonly string[];
	readonly onUpdate: (patch: SettingsPatch, message?: string) => Promise<SettingsSnapshot | undefined>;
	readonly onHealth: () => Promise<void>;
	readonly onReconnect: (name: string) => Promise<void>;
	readonly onTrust: (remember: boolean) => Promise<void>;
	readonly onDeny: () => Promise<void>;
}): JSX.Element {
	const { state, dispatch } = useApp();
	const project = state.project;
	const [shellPath, setShellPath] = useState(settings?.config.shellPath ?? "");
	const [httpProxy, setHttpProxy] = useState(settings?.config.httpProxy ?? "");
	const [maxTurns, setMaxTurns] = useState(String(settings?.config.limits.maxTurns ?? 0));

	useEffect(() => {
		setShellPath(settings?.config.shellPath ?? "");
		setHttpProxy(settings?.config.httpProxy ?? "");
		setMaxTurns(String(settings?.config.limits.maxTurns ?? 0));
	}, [settings]);

	if (project === undefined) return <></>;
	const trust = project.trust;
	return (
		<div className="settings-section">
			<h3>工作区信任</h3>
			{trust.decision === true ? (
				<div className="inline-notice notice-ok">
					<CheckIcon size={14} /> 已信任：项目配置、项目技能与 AGENTS.md 生效
				</div>
			) : trust.decision === false ? (
				<div className="inline-notice notice-warn">
					<AlertIcon size={14} /> 已拒绝：项目配置与项目技能不生效
				</div>
			) : (
				<div className="inline-notice notice-warn">
					<AlertIcon size={14} /> 尚未决定；聊天发送会被阻止
				</div>
			)}
			<div className="button-row">
				<button className="primary-button" onClick={() => void onTrust(true)}>
					信任并记住
				</button>
				<button className="ghost-button" onClick={() => void onTrust(false)}>
					仅本次信任
				</button>
				<button className="danger-button" onClick={() => void onDeny()}>
					不信任
				</button>
			</div>
			{trust.files.length > 0 ? (
				<ul className="trust-files">
					{trust.files.map((file) => (
						<li key={file}>{file}</li>
					))}
				</ul>
			) : null}

			<h3>技能</h3>
			<div className="skill-list">
				{skills.length === 0 ? <div className="side-empty">没有可用技能</div> : null}
				{skills.map((skill) => (
					<div className="skill-row" key={`${skill.scope}:${skill.path}`}>
						<span className="pill">{skill.scope}</span>
						<strong>{skill.name}</strong>
						<span>{skill.description}</span>
					</div>
				))}
			</div>

			<div className="section-head">
				<h3>MCP</h3>
				<button className="ghost-button" onClick={() => void onHealth()}>
					健康检查
				</button>
			</div>
			<div className="mcp-list">
				{mcp.length === 0 ? <div className="side-empty">没有配置 MCP server</div> : null}
				{mcp.map((server) => (
					<div className="mcp-row" key={server.name}>
						<span className={`status-dot status-${server.status === "connected" ? "ok" : "error"}`} />
						<strong>{server.name}</strong>
						<span className="pill">{server.status}</span>
						<span className="mcp-detail">{server.detail}</span>
						<button className="ghost-button small" onClick={() => void onReconnect(server.name)}>
							重连
						</button>
					</div>
				))}
				{mcpHealth.map((line) => (
					<div className="mcp-health" key={line}>
						{line}
					</div>
				))}
			</div>

			<h3>运行环境</h3>
			<div className="field-grid">
				<label className="field wide">
					<span>Shell 路径</span>
					<input
						value={shellPath}
						placeholder="留空使用系统默认"
						onChange={(event) => setShellPath(event.target.value)}
					/>
				</label>
				<label className="field wide">
					<span>HTTP 代理</span>
					<input
						value={httpProxy}
						placeholder="http://127.0.0.1:7890"
						onChange={(event) => setHttpProxy(event.target.value)}
					/>
				</label>
				<label className="field">
					<span>最大步数</span>
					<input value={maxTurns} onChange={(event) => setMaxTurns(event.target.value)} />
				</label>
			</div>
			<div className="button-row">
				<button
					className="primary-button"
					onClick={() => {
						void onUpdate(
							{
								shellPath: shellPath.trim().length === 0 ? null : shellPath.trim(),
								httpProxy: httpProxy.trim().length === 0 ? null : httpProxy.trim(),
								limits: { maxTurns: Number(maxTurns) },
							},
							"运行环境已保存",
						);
					}}
				>
					保存运行环境
				</button>
				<button
					className="ghost-button"
					onClick={() => {
						void call(window.moros.configSummary())
							.then((value) => dispatch({ type: "notice", level: "info", message: JSON.stringify(value, null, 2) }))
							.catch((error: unknown) => dispatch({ type: "notice", level: "error", message: errorMessage(error) }));
					}}
				>
					查看诊断
				</button>
			</div>

			{summary !== undefined ? (
				<div className="config-summary">
					<div>配置：{settings?.configPath}</div>
					<div>供应商：{settings?.providersPath}</div>
					{summary.skipped.length > 0 ? (
						<div className="inline-notice notice-warn">
							跳过条目：{summary.skipped.map((item) => `${item.path}（${item.reason}）`).join("；")}
						</div>
					) : null}
				</div>
			) : null}
		</div>
	);
}
