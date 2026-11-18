import { useCallback, useEffect, useState, type JSX } from "react";

import type { SettingsPatch, SettingsSnapshot, ProviderDraft, ProviderView } from "#src/core/config/settings.ts";
import type { McpStatus } from "#src/core/mcp/types.ts";
import type { SkillSummary } from "#src/core/skills.ts";
import type { ModelCatalog } from "#src/core/core.ts";
import type { ConfigSummary } from "#src/desktop/shared/contract.ts";
import { call, errorMessage } from "#src/desktop/renderer/api.ts";
import { PageHeader } from "#src/desktop/renderer/PageHeader.tsx";
import {
	AlertIcon,
	CheckIcon,
	EyeIcon,
	EyeOffIcon,
	PlusIcon,
	RefreshIcon,
	SettingsIcon,
	TrashIcon,
	XIcon,
} from "#src/desktop/renderer/icons.tsx";
import { useApp } from "#src/desktop/renderer/state.tsx";

type Tab = "models" | "providers" | "workspace" | "appearance";

interface ModelForm {
	id: string;
	name: string;
	maxTokens: string;
	contextWindow: string;
	reasoning: boolean;
	image: boolean;
}

interface ProviderForm {
	originalName?: string;
	name: string;
	api: ProviderView["api"];
	baseUrl: string;
	apiKey: string;
	timeoutMs: string;
	models: ModelForm[];
}

export function SettingsPage(): JSX.Element {
	const { state, dispatch } = useApp();
	const [settings, setSettings] = useState<SettingsSnapshot | undefined>(undefined);
	const [models, setModels] = useState<ModelCatalog | undefined>(undefined);
	const [summary, setSummary] = useState<ConfigSummary | undefined>(undefined);
	const [skills, setSkills] = useState<readonly SkillSummary[]>([]);
	const [mcp, setMcp] = useState<readonly McpStatus[]>([]);
	const [mcpHealth, setMcpHealth] = useState<readonly string[]>([]);
	const [tab, setTab] = useState<Tab>("models");
	const [editing, setEditing] = useState<ProviderForm | undefined>(undefined);
	const [revealed, setRevealed] = useState<Record<string, string>>({});
	const [loadError, setLoadError] = useState<string | undefined>(undefined);
	const project = state.project;

	const refresh = useCallback(async (): Promise<void> => {
		try {
			const next = await call(window.moros.settingsGet());
			setSettings(next);
			dispatch({ type: "settings", settings: next });
			const catalog = await call(window.moros.modelsList()).catch(() => undefined);
			if (catalog !== undefined) {
				setModels(catalog);
				dispatch({ type: "models", models: catalog });
			}
			const config = await call(window.moros.configSummary()).catch(() => undefined);
			if (config !== undefined) setSummary(config);
			const skillList = await call(window.moros.skillsList()).catch(() => []);
			setSkills(skillList);
			const statuses = await call(window.moros.mcpStatus()).catch(() => []);
			setMcp(statuses);
			setLoadError(undefined);
		} catch (error) {
			setLoadError(errorMessage(error));
		}
	}, [dispatch]);

	useEffect(() => {
		void refresh();
	}, [refresh, project?.root]);

	const update = async (patch: SettingsPatch, message?: string): Promise<SettingsSnapshot | undefined> => {
		try {
			const next = await call(window.moros.settingsUpdate(patch));
			setSettings(next);
			dispatch({ type: "settings", settings: next });
			await refresh();
			if (message !== undefined) dispatch({ type: "notice", level: "info", message });
			return next;
		} catch (error) {
			dispatch({ type: "notice", level: "error", message: errorMessage(error) });
			return undefined;
		}
	};

	if (project === undefined) {
		return (
			<div className="page-empty">
				<SettingsIcon size={22} />
				<p>设置需要先打开一个项目</p>
			</div>
		);
	}

	return (
		<div className="settings-page">
			<PageHeader
				title="设置"
				subtitle="全局配置写入 ~/.moros；当前会话的模型/强度选择会立即生效。"
				actions={
					<button className="ghost-button" onClick={() => void refresh()}>
						<RefreshIcon size={14} />
						刷新
					</button>
				}
			/>

			{loadError !== undefined ? <div className="inline-notice notice-error">{loadError}</div> : null}
			<div className="settings-tabs">
				{(
					[
						["models", "模型"],
						["providers", "供应商"],
						["workspace", "工作区"],
						["appearance", "外观"],
					] as const
				).map(([value, label]) => (
					<button
						key={value}
						className={`settings-tab ${tab === value ? "is-active" : ""}`}
						onClick={() => setTab(value)}
					>
						{label}
					</button>
				))}
			</div>

			<div className="settings-body">
				{tab === "models" && settings !== undefined ? (
					<ModelsTab settings={settings} models={models} onUpdate={update} onRefresh={refresh} />
				) : null}
				{tab === "providers" && settings !== undefined ? (
					<ProvidersTab
						settings={settings}
						editing={editing}
						revealed={revealed}
						onEdit={setEditing}
						onRevealed={(name, value) =>
							setRevealed((existing) => {
								if (value === undefined) {
									const next = { ...existing };
									delete next[name];
									return next;
								}
								return { ...existing, [name]: value };
							})
						}
						onRefresh={refresh}
						onNotice={(level, message) => dispatch({ type: "notice", level, message })}
					/>
				) : null}
				{tab === "workspace" ? (
					<WorkspaceTab
						settings={settings}
						summary={summary}
						skills={skills}
						mcp={mcp}
						mcpHealth={mcpHealth}
						onUpdate={update}
						onHealth={async () => {
							try {
								setMcpHealth(await call(window.moros.mcpHealth()));
							} catch (error) {
								dispatch({ type: "notice", level: "error", message: errorMessage(error) });
							}
						}}
						onReconnect={async (name) => {
							try {
								const message = await call(window.moros.mcpReconnect(name));
								dispatch({ type: "notice", level: "info", message });
								setMcp(await call(window.moros.mcpStatus()));
							} catch (error) {
								dispatch({ type: "notice", level: "error", message: errorMessage(error) });
							}
						}}
						onTrust={async (remember) => {
							try {
								const trust = await call(window.moros.trustAccept(remember));
								dispatch({ type: "trust", trust });
								await refresh();
							} catch (error) {
								dispatch({ type: "notice", level: "error", message: errorMessage(error) });
							}
						}}
						onDeny={async () => {
							try {
								const trust = await call(window.moros.trustDeny());
								dispatch({ type: "trust", trust });
								await refresh();
							} catch (error) {
								dispatch({ type: "notice", level: "error", message: errorMessage(error) });
							}
						}}
					/>
				) : null}
				{tab === "appearance" && settings !== undefined ? (
					<AppearanceTab settings={settings} onUpdate={update} />
				) : null}
			</div>
		</div>
	);
}

function ModelsTab({
	settings,
	models,
	onUpdate,
	onRefresh,
}: {
	readonly settings: SettingsSnapshot;
	readonly models: ModelCatalog | undefined;
	readonly onUpdate: (patch: SettingsPatch, message?: string) => Promise<SettingsSnapshot | undefined>;
	readonly onRefresh: () => Promise<void>;
}): JSX.Element {
	const { state, dispatch } = useApp();
	const provider = settings.config.provider ?? "";
	const model = settings.config.model ?? "";
	const providerEntry = models?.providers.find((entry) => entry.name === provider);
	const selected = JSON.stringify([provider, model]);

	const changeModel = async (value: string): Promise<void> => {
		try {
			const [nextProvider, nextModel] = JSON.parse(value) as [string, string];
			if (state.current !== undefined) {
				await call(window.moros.sessionSelectModel(nextProvider, nextModel));
				await onRefresh();
			} else {
				await onUpdate({ provider: nextProvider, model: nextModel }, "默认模型已更新");
			}
		} catch (error) {
			dispatch({ type: "notice", level: "error", message: errorMessage(error) });
		}
	};

	return (
		<div className="settings-section">
			<h3>默认模型</h3>
			<p className="settings-note">新会话从这里的默认值开始；在对话框里切换会同时写回默认。</p>
			<label className="field">
				<span>模型</span>
				<select value={selected} onChange={(event) => void changeModel(event.target.value)}>
					<option value={JSON.stringify(["", ""])} disabled>
						选择模型
					</option>
					{(models?.providers ?? []).map((entry) => (
						<optgroup key={entry.name} label={entry.name}>
							{entry.models.map((item) => (
								<option key={`${entry.name}/${item.id}`} value={JSON.stringify([entry.name, item.id])}>
									{item.name ?? item.id}
								</option>
							))}
						</optgroup>
					))}
				</select>
			</label>
			{providerEntry !== undefined ? (
				<div className="model-facts">
					{providerEntry.models
						.filter((entry) => entry.id === model)
						.map((entry) => (
							<div className="fact-row" key={entry.id}>
								<span>上下文窗口</span>
								<strong>{entry.contextWindow === undefined ? "未声明" : entry.contextWindow.toLocaleString()}</strong>
								<span>最大输出</span>
								<strong>{entry.maxTokens.toLocaleString()}</strong>
								<span>能力</span>
								<strong>
									{entry.reasoning ? "reasoning " : ""}
									{entry.input.join(" / ")}
								</strong>
							</div>
						))}
				</div>
			) : null}

			<h3>默认放权</h3>
			<div className="field-grid">
				<label className="field">
					<span>推理强度</span>
					<select
						value={settings.config.reasoningEffort}
						onChange={(event) => {
							const effort = event.target.value;
							if (state.current !== undefined) {
								void call(window.moros.sessionSelectEffort(effort as typeof settings.config.reasoningEffort)).catch(
									(error: unknown) => dispatch({ type: "notice", level: "error", message: errorMessage(error) }),
								);
							} else {
								void onUpdate({ reasoningEffort: effort as SettingsPatch["reasoningEffort"] }, "默认推理强度已更新");
							}
						}}
					>
						<option value="off">Off</option>
						<option value="minimal">Minimal</option>
						<option value="low">Low</option>
						<option value="medium">Medium</option>
						<option value="high">High</option>
						<option value="max">Max</option>
					</select>
				</label>
				<label className="field">
					<span>审批档位</span>
					<select
						value={settings.config.approval}
						onChange={(event) => {
							const approval = event.target.value as SettingsPatch["approval"];
							void onUpdate({ approval }, "默认审批档位已更新").then(() => {
								if (state.current !== undefined && approval !== undefined) {
									void call(window.moros.sessionSelectApproval(approval)).catch(() => undefined);
								}
							});
						}}
					>
						<option value="ask">Ask</option>
						<option value="auto">Auto</option>
						<option value="yolo">Yolo</option>
					</select>
				</label>
			</div>
		</div>
	);
}

function ProvidersTab({
	settings,
	editing,
	revealed,
	onEdit,
	onRevealed,
	onRefresh,
	onNotice,
}: {
	readonly settings: SettingsSnapshot;
	readonly editing: ProviderForm | undefined;
	readonly revealed: Record<string, string>;
	readonly onEdit: (form: ProviderForm | undefined) => void;
	readonly onRevealed: (name: string, value: string | undefined) => void;
	readonly onRefresh: () => Promise<void>;
	readonly onNotice: (level: "info" | "warn" | "error", message: string) => void;
}): JSX.Element {
	const save = async (form: ProviderForm): Promise<void> => {
		try {
			const draft: ProviderDraft = {
				api: form.api,
				baseUrl: form.baseUrl,
				timeoutMs: Number(form.timeoutMs),
				models: form.models.map((model) => ({
					id: model.id,
					...(model.name.trim().length === 0 ? {} : { name: model.name.trim() }),
					maxTokens: Number(model.maxTokens),
					...(model.contextWindow.trim().length === 0 ? {} : { contextWindow: Number(model.contextWindow) }),
					reasoning: model.reasoning,
					input: model.image ? (["text", "image"] as const) : (["text"] as const),
				})),
				...(form.apiKey.trim().length === 0 ? {} : { apiKey: form.apiKey.trim() }),
			};
			await call(window.moros.settingsUpsertProvider(form.name.trim(), draft));
			await onRefresh();
			onEdit(undefined);
			onNotice("info", `供应商 ${form.name} 已保存`);
		} catch (error) {
			onNotice("error", errorMessage(error));
		}
	};

	return (
		<div className="settings-section">
			<div className="section-head">
				<div>
					<h3>供应商与模型</h3>
					<p className="settings-note">
						密钥支持 <code>${"{ENV}"}</code>、<code>!command</code> 或明文；界面只显示掩码，显示原文需显式操作。
					</p>
				</div>
				<button
					className="primary-button"
					onClick={() =>
						onEdit({
							name: "",
							api: "chat-completions",
							baseUrl: "https://api.openai.com/v1",
							apiKey: "",
							timeoutMs: "60000",
							models: [
								{ id: "", name: "", maxTokens: "8192", contextWindow: "128000", reasoning: false, image: false },
							],
						})
					}
				>
					<PlusIcon size={15} />
					添加供应商
				</button>
			</div>

			<div className="provider-list">
				{settings.providers.map((provider) => (
					<div className="provider-card" key={provider.name}>
						<div className="provider-main">
							<div className="provider-title">
								<strong>{provider.name}</strong>
								<span className="pill">{provider.api}</span>
								<span className="pill">{provider.models.length} 模型</span>
							</div>
							<div className="provider-url">{provider.baseUrl}</div>
							<div className="provider-secret">
								<span>密钥</span>
								<code>{revealed[provider.name] ?? provider.apiKey.display}</code>
								<button
									className="icon-button"
									title={revealed[provider.name] === undefined ? "显示原始表达式" : "隐藏"}
									onClick={() => {
										if (revealed[provider.name] !== undefined) {
											onRevealed(provider.name, undefined);
											return;
										}
										void call(window.moros.settingsRevealSecret(provider.name))
											.then((value) => onRevealed(provider.name, value))
											.catch((error: unknown) => onNotice("error", errorMessage(error)));
									}}
								>
									{revealed[provider.name] === undefined ? <EyeIcon size={14} /> : <EyeOffIcon size={14} />}
								</button>
							</div>
						</div>
						<div className="provider-actions">
							<button
								className="ghost-button"
								onClick={() =>
									onEdit({
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
									})
								}
							>
								编辑
							</button>
							<button
								className="icon-button danger"
								title="删除供应商"
								onClick={() => {
									if (!window.confirm(`删除供应商 ${provider.name}？`)) return;
									void call(window.moros.settingsDeleteProvider(provider.name))
										.then(() => onRefresh())
										.then(() => onNotice("info", `已删除 ${provider.name}`))
										.catch((error: unknown) => onNotice("error", errorMessage(error)));
								}}
							>
								<TrashIcon size={14} />
							</button>
						</div>
					</div>
				))}
			</div>

			{editing !== undefined ? (
				<ProviderEditor form={editing} onChange={onEdit} onSave={save} onCancel={() => onEdit(undefined)} />
			) : null}
		</div>
	);
}

function ProviderEditor({
	form,
	onChange,
	onSave,
	onCancel,
}: {
	readonly form: ProviderForm;
	readonly onChange: (form: ProviderForm | undefined) => void;
	readonly onSave: (form: ProviderForm) => Promise<void>;
	readonly onCancel: () => void;
}): JSX.Element {
	const set = (patch: Partial<ProviderForm>): void => onChange({ ...form, ...patch });
	const setModel = (index: number, patch: Partial<ModelForm>): void => {
		const models = form.models.map((model, current) => (current === index ? { ...model, ...patch } : model));
		onChange({ ...form, models });
	};
	return (
		<div className="provider-editor">
			<div className="modal-head">
				<h3>{form.originalName === undefined ? "添加供应商" : `编辑 ${form.originalName}`}</h3>
				<button className="icon-button" aria-label="关闭" onClick={onCancel}>
					<XIcon size={16} />
				</button>
			</div>
			<div className="field-grid">
				<label className="field">
					<span>名称</span>
					<input
						value={form.name}
						disabled={form.originalName !== undefined}
						onChange={(event) => set({ name: event.target.value })}
					/>
				</label>
				<label className="field">
					<span>协议</span>
					<select value={form.api} onChange={(event) => set({ api: event.target.value as ProviderView["api"] })}>
						<option value="chat-completions">chat-completions</option>
						<option value="anthropic-messages">anthropic-messages</option>
						<option value="responses">responses</option>
					</select>
				</label>
				<label className="field wide">
					<span>Base URL</span>
					<input value={form.baseUrl} onChange={(event) => set({ baseUrl: event.target.value })} />
				</label>
				<label className="field">
					<span>API Key</span>
					<input
						type="password"
						value={form.apiKey}
						placeholder="留空保持不变"
						onChange={(event) => set({ apiKey: event.target.value })}
					/>
				</label>
				<label className="field">
					<span>超时（毫秒）</span>
					<input value={form.timeoutMs} onChange={(event) => set({ timeoutMs: event.target.value })} />
				</label>
			</div>

			<div className="model-editor">
				<div className="section-head">
					<h4>模型</h4>
					<button
						className="ghost-button"
						onClick={() =>
							set({
								models: [
									...form.models,
									{ id: "", name: "", maxTokens: "8192", contextWindow: "", reasoning: false, image: false },
								],
							})
						}
					>
						<PlusIcon size={13} />
						添加模型
					</button>
				</div>
				{form.models.map((model, index) => (
					<div className="model-row" key={index}>
						<input
							placeholder="id"
							value={model.id}
							onChange={(event) => setModel(index, { id: event.target.value })}
						/>
						<input
							placeholder="显示名（可选）"
							value={model.name}
							onChange={(event) => setModel(index, { name: event.target.value })}
						/>
						<input
							placeholder="maxTokens"
							value={model.maxTokens}
							onChange={(event) => setModel(index, { maxTokens: event.target.value })}
						/>
						<input
							placeholder="contextWindow"
							value={model.contextWindow}
							onChange={(event) => setModel(index, { contextWindow: event.target.value })}
						/>
						<label className="check">
							<input
								type="checkbox"
								checked={model.reasoning}
								onChange={(event) => setModel(index, { reasoning: event.target.checked })}
							/>
							reasoning
						</label>
						<label className="check">
							<input
								type="checkbox"
								checked={model.image}
								onChange={(event) => setModel(index, { image: event.target.checked })}
							/>
							image
						</label>
						<button
							className="icon-button danger"
							title="删除模型"
							onClick={() => set({ models: form.models.filter((_, current) => current !== index) })}
						>
							<TrashIcon size={14} />
						</button>
					</div>
				))}
			</div>
			<div className="modal-actions">
				<button className="ghost-button" onClick={onCancel}>
					取消
				</button>
				<button className="primary-button" onClick={() => void onSave(form)}>
					<CheckIcon size={14} />
					保存供应商
				</button>
			</div>
		</div>
	);
}

function WorkspaceTab({
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

function AppearanceTab({
	settings,
	onUpdate,
}: {
	readonly settings: SettingsSnapshot;
	readonly onUpdate: (patch: SettingsPatch, message?: string) => Promise<SettingsSnapshot | undefined>;
}): JSX.Element {
	return (
		<div className="settings-section">
			<h3>主题</h3>
			<p className="settings-note">跟随系统会监听系统深浅色变化；选择后立即写入全局配置。</p>
			<label className="field">
				<span>外观</span>
				<select
					value={settings.config.ui.theme}
					onChange={(event) => {
						void onUpdate({ ui: { theme: event.target.value as "auto" | "light" | "dark" } }, "主题已更新");
					}}
				>
					<option value="auto">跟随系统</option>
					<option value="light">浅色</option>
					<option value="dark">深色</option>
				</select>
			</label>
			<h3>通知</h3>
			<label className="field">
				<span>完成提醒</span>
				<select
					value={settings.config.ui.notify}
					onChange={(event) => {
						void onUpdate(
							{ ui: { notify: event.target.value as "auto" | "bell" | "desktop" | "off" } },
							"通知设置已更新",
						);
					}}
				>
					<option value="auto">窗口失焦时通知</option>
					<option value="desktop">总是系统通知</option>
					<option value="bell">响铃</option>
					<option value="off">关闭</option>
				</select>
			</label>
		</div>
	);
}
