import { useCallback, useEffect, useMemo, useState, type JSX, type ReactNode } from "react";

import type { SettingsPatch, SettingsSnapshot } from "@moros/core/config/settings.ts";
import type { McpStatus } from "@moros/core/mcp/types.ts";
import type { SkillSummary } from "@moros/core/skills.ts";
import type { ConfigSummary } from "../shared/contract.ts";
import { call, errorMessage } from "../api/api.ts";
import { Dropdown } from "../components/Dropdown.tsx";
import {
	ArchiveIcon2,
	ArrowLeftIcon,
	FolderIcon,
	MinusIcon,
	MonitorIcon,
	MoonIcon,
	PaletteIcon,
	PlusIcon,
	PuzzleIcon,
	RefreshIcon,
	SearchIcon,
	SettingsIcon,
	SlidersHorizontalIcon,
	SlidersIcon,
	SunIcon,
	UserCogIcon,
} from "../components/Icons.tsx";
import { ProvidersTab, WorkspaceTab } from "./SettingsPage.tsx";
import { useApp } from "../store/state.tsx";

type IconComponent = (props: { size?: number }) => JSX.Element;
type NavItem = readonly [key: string, label: string, icon: IconComponent];
interface NavGroup {
	readonly title: string;
	readonly items: readonly NavItem[];
}

const NAV_GROUPS: readonly NavGroup[] = [
	{
		title: "常规设置",
		items: [
			["general", "常规", SlidersHorizontalIcon],
			["appearance", "外观", PaletteIcon],
			["providers", "供应商", SlidersIcon],
		],
	},
	{
		title: "Agent 能力",
		items: [
			["personalize", "个性化", UserCogIcon],
			["extensions", "扩展", PuzzleIcon],
		],
	},
	{
		title: "数据与统计",
		items: [
			["workspace", "工作区", FolderIcon],
			["archive", "归档管理", ArchiveIcon2],
		],
	},
];

/** 设置独立视图：自带顶栏与左侧导航，整窗替代主工作区。 */
export function SettingsApp(): JSX.Element {
	const { state, dispatch } = useApp();
	const [active, setActive] = useState("appearance");
	const [query, setQuery] = useState("");
	const [settings, setSettings] = useState<SettingsSnapshot | undefined>(undefined);
	const [summary, setSummary] = useState<ConfigSummary | undefined>(undefined);
	const [skills, setSkills] = useState<readonly SkillSummary[]>([]);
	const [mcp, setMcp] = useState<readonly McpStatus[]>([]);
	const [mcpHealth, setMcpHealth] = useState<readonly string[]>([]);
	const [loadError, setLoadError] = useState<string | undefined>(undefined);

	const refresh = useCallback(async (): Promise<void> => {
		try {
			const next = await call(window.moros.settingsGet());
			setSettings(next);
			dispatch({ type: "settings", settings: next });
			const catalog = await call(window.moros.modelsList()).catch(() => undefined);
			if (catalog !== undefined) dispatch({ type: "models", models: catalog });
			const config = await call(window.moros.configSummary()).catch(() => undefined);
			if (config !== undefined) setSummary(config);
			setSkills(await call(window.moros.skillsList()).catch(() => []));
			setMcp(await call(window.moros.mcpStatus()).catch(() => []));
			setLoadError(undefined);
		} catch (error) {
			setLoadError(errorMessage(error));
		}
	}, [dispatch]);

	useEffect(() => {
		void refresh();
	}, [refresh]);

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

	const notice = (level: "info" | "warn" | "error", message: string): void => {
		dispatch({ type: "notice", level, message });
	};

	const filteredGroups = useMemo(() => {
		const needle = query.trim().toLowerCase();
		if (needle.length === 0) return NAV_GROUPS;
		return NAV_GROUPS.map((group) => ({
			title: group.title,
			items: group.items.filter(([, label]) => label.toLowerCase().includes(needle)),
		})).filter((group) => group.items.length > 0);
	}, [query]);

	const activeLabel = useMemo(
		() => NAV_GROUPS.flatMap((group) => group.items).find(([key]) => key === active)?.[1] ?? "外观",
		[active],
	);

	const renderContent = (): ReactNode => {
		if (loadError !== undefined) return <div className="inline-notice notice-error">{loadError}</div>;
		if (settings === undefined) return <div className="settings-loading">正在载入设置…</div>;

		switch (active) {
			case "appearance":
				return <AppearanceSettings settings={settings} onUpdate={update} />;
			case "providers":
				return (
					<ProvidersTab settings={settings} onRefresh={refresh} onNotice={(level, message) => notice(level, message)} />
				);
			case "general":
				return <GeneralSettings settings={settings} summary={summary} />;
			case "extensions":
				return (
					<ExtensionsPanel
						summary={summary}
						skills={skills}
						mcp={mcp}
						mcpHealth={mcpHealth}
						onHealth={async () => {
							try {
								setMcpHealth(await call(window.moros.mcpHealth()));
							} catch (error) {
								notice("error", errorMessage(error));
							}
						}}
						onReconnect={async (name) => {
							try {
								notice("info", await call(window.moros.mcpReconnect(name)));
								setMcp(await call(window.moros.mcpStatus()));
							} catch (error) {
								notice("error", errorMessage(error));
							}
						}}
					/>
				);
			case "workspace":
				return (
					<WorkspaceTab
						settings={settings}
						summary={summary}
						onUpdate={update}
						onTrust={async (remember) => {
							try {
								dispatch({ type: "trust", trust: await call(window.moros.trustAccept(remember)) });
								await refresh();
							} catch (error) {
								notice("error", errorMessage(error));
							}
						}}
						onDeny={async () => {
							try {
								dispatch({ type: "trust", trust: await call(window.moros.trustDeny()) });
								await refresh();
							} catch (error) {
								notice("error", errorMessage(error));
							}
						}}
					/>
				);
			default:
				return <ComingSoon label={activeLabel} />;
		}
	};

	return (
		<div className="settings-app">
			<div className="settings-app-body">
				<nav className={`settings-nav ${state.sidebarOpen ? "" : "is-collapsed"}`} aria-label="设置导航">
					<button className="settings-back" onClick={() => dispatch({ type: "page", page: "chat" })}>
						<ArrowLeftIcon size={15} />
						<span>返回工作区</span>
					</button>
					<div className="settings-search">
						<SearchIcon size={15} />
						<input
							value={query}
							onChange={(event) => setQuery(event.target.value)}
							placeholder="搜索设置"
							aria-label="搜索设置"
						/>
					</div>
					<div className="settings-nav-scroll">
						{filteredGroups.map((group) => (
							<div className="settings-nav-group" key={group.title}>
								<div className="settings-nav-group-title">{group.title}</div>
								{group.items.map(([key, label, Icon]) => (
									<button
										key={key}
										className={`settings-nav-item ${active === key ? "is-active" : ""}`}
										onClick={() => setActive(key)}
									>
										<Icon size={16} />
										<span>{label}</span>
									</button>
								))}
							</div>
						))}
						{filteredGroups.length === 0 ? <div className="settings-nav-empty">没有匹配的设置项</div> : null}
					</div>
				</nav>
				<main className="settings-content">
					<div className={`settings-content-inner ${active === "providers" ? "is-wide" : ""}`}>
						{active !== "providers" ? <h1 className="settings-page-title">{activeLabel}</h1> : null}
						{renderContent()}
					</div>
				</main>
			</div>
		</div>
	);
}

/** 数值步进器：可点击的 −/+ 按钮 + 可直接输入的文本框，替代原生 number 的难点箭头。 */
function NumberStepper({
	value,
	min,
	max,
	suffix,
	onChange,
}: {
	readonly value: number;
	readonly min: number;
	readonly max: number;
	readonly suffix?: string;
	readonly onChange: (value: number) => void;
}): JSX.Element {
	const [text, setText] = useState(String(value));
	useEffect(() => setText(String(value)), [value]);

	const commit = (): void => {
		const parsed = Number(text);
		if (Number.isInteger(parsed) && parsed >= min && parsed <= max) {
			onChange(parsed);
		} else {
			setText(String(value));
		}
	};

	const step = (delta: number): void => {
		const next = Math.min(max, Math.max(min, value + delta));
		if (next !== value) onChange(next);
	};

	return (
		<span className="settings-stepper">
			<button type="button" aria-label="减小" title="减小" disabled={value <= min} onClick={() => step(-1)}>
				<MinusIcon size={13} />
			</button>
			<input
				className="settings-stepper-input"
				type="text"
				inputMode="numeric"
				value={text}
				onChange={(event) => setText(event.target.value)}
				onBlur={commit}
				onKeyDown={(event) => {
					if (event.key === "Enter") commit();
				}}
			/>
			{suffix !== undefined ? <span className="settings-stepper-suffix">{suffix}</span> : null}
			<button type="button" aria-label="增大" title="增大" disabled={value >= max} onClick={() => step(1)}>
				<PlusIcon size={13} />
			</button>
		</span>
	);
}

/** 外观页：颜色主题与字号（真实）+ 编辑器与配色预览（占位展示）。 */
function AppearanceSettings({
	settings,
	onUpdate,
}: {
	readonly settings: SettingsSnapshot;
	readonly onUpdate: (patch: SettingsPatch, message?: string) => Promise<SettingsSnapshot | undefined>;
}): JSX.Element {
	const ui = settings.config.ui;
	return (
		<>
			<SettingsSection title="外观与字体" description="调整界面配色、文字大小与渲染缩放。">
				<SettingsCard>
					<SettingsRow
						label="颜色主题"
						description="选择浅色、深色，或随系统外观自动切换。"
						control={
							<Dropdown
								value={ui.theme}
								options={[
									{ value: "auto", label: "系统", icon: <MonitorIcon size={14} /> },
									{ value: "light", label: "浅色", icon: <SunIcon size={14} /> },
									{ value: "dark", label: "深色", icon: <MoonIcon size={14} /> },
								]}
								onChange={(theme) => {
									void onUpdate({ ui: { theme: theme as "auto" | "light" | "dark" } }, "主题已更新");
								}}
							/>
						}
					/>
					<SettingsRow
						label="界面字号"
						description="以像素为单位，仅缩放文字；图标与布局尺寸不变。"
						control={
							<NumberStepper
								value={ui.fontSize}
								min={12}
								max={20}
								suffix="px"
								onChange={(parsed) => void onUpdate({ ui: { fontSize: parsed } })}
							/>
						}
					/>
				</SettingsCard>
			</SettingsSection>

			<SettingsSection title="编辑器" description="代码区的配色与排版，独立于界面字号设置。">
				<SettingsCard>
					<SettingsRow
						label="浅色代码主题"
						description="浅色外观下代码与语法高亮采用的配色。"
						control={<DisabledSelect label="GitHub Light" />}
					/>
					<SettingsRow
						label="深色代码主题"
						description="深色外观下代码与语法高亮采用的配色。"
						control={<DisabledSelect label="GitHub Dark" />}
					/>
					<SettingsRow
						label="显示行号"
						description="在代码内容与差异视图中显示行号。"
						control={<Toggle checked disabled />}
					/>
					<SettingsRow
						label="自动换行"
						description="超出可视宽度的代码行自动折行。"
						control={<Toggle checked={false} disabled />}
					/>
					<SettingsRow
						label="代码字号"
						description="代码块、文件预览与差异视图的默认字号。"
						control={
							<span className="settings-number is-disabled">
								<span>12</span>
								<span>px</span>
							</span>
						}
					/>
				</SettingsCard>
			</SettingsSection>

			<SettingsSection title="主题预览" description="并排预览浅色与深色代码主题，当前生效的主题会标注出来。">
				<div className="code-preview-grid">
					<CodePreview title="浅色预览" theme="GitHub Light" current badge="当前生效" />
					<CodePreview title="深色预览" theme="GitHub Dark" badge="备选" />
				</div>
			</SettingsSection>
		</>
	);
}

function GeneralSettings({
	settings,
	summary,
}: {
	readonly settings: SettingsSnapshot;
	readonly summary: ConfigSummary | undefined;
}): JSX.Element {
	return (
		<SettingsSection title="概览" description="当前工作区与应用的基础信息，详细配置请从左侧进入对应分组。">
			<SettingsCard>
				<SettingsRow
					label="默认模型"
					description="新会话使用的模型。"
					control={<code>{settings.config.model || "未设置"}</code>}
				/>
				<SettingsRow
					label="供应商"
					description="当前默认模型所属供应商。"
					control={<code>{settings.config.provider || "未设置"}</code>}
				/>
				<SettingsRow
					label="审批档位"
					description="新建会话的默认审批策略。"
					control={<code>{settings.config.approval}</code>}
				/>
				{summary !== undefined ? (
					<SettingsRow
						label="配置文件"
						description={settings.configPath}
						control={<code>{settings.providersPath}</code>}
					/>
				) : null}
			</SettingsCard>
		</SettingsSection>
	);
}

type ExtensionTab = "plugins" | "skills" | "mcp";

/**
 * 扩展面板：把插件、Skills 与 MCP 三类 Agent 能力集中管理。
 * 插件后端机制尚未落地，保留占位空态；Skills 与 MCP 直接消费已就绪的 IPC。
 */
function ExtensionsPanel({
	summary,
	skills,
	mcp,
	mcpHealth,
	onHealth,
	onReconnect,
}: {
	readonly summary: ConfigSummary | undefined;
	readonly skills: readonly SkillSummary[];
	readonly mcp: readonly McpStatus[];
	readonly mcpHealth: readonly string[];
	readonly onHealth: () => Promise<void>;
	readonly onReconnect: (name: string) => Promise<void>;
}): JSX.Element {
	const [tab, setTab] = useState<ExtensionTab>("skills");
	const tabs: readonly { readonly key: ExtensionTab; readonly label: string }[] = [
		{ key: "plugins", label: "插件" },
		{ key: "skills", label: "Skills" },
		{ key: "mcp", label: "MCP" },
	];
	return (
		<div className="extensions-panel">
			<div className="extensions-tabs" role="tablist" aria-label="扩展类型">
				{tabs.map((item) => (
					<button
						key={item.key}
						type="button"
						role="tab"
						aria-selected={tab === item.key}
						className={`settings-tab ${tab === item.key ? "is-active" : ""}`}
						onClick={() => setTab(item.key)}
					>
						{item.label}
					</button>
				))}
			</div>
			{/* key 绑定标签，切换时重挂载子视图以播放入场动画 */}
			<div className="extensions-body" key={tab}>
				{tab === "plugins" ? <PluginsEmpty /> : null}
				{tab === "skills" ? <SkillsPanel skills={skills} summary={summary} /> : null}
				{tab === "mcp" ? (
					<McpPanel mcp={mcp} mcpHealth={mcpHealth} onHealth={onHealth} onReconnect={onReconnect} />
				) : null}
			</div>
		</div>
	);
}

/** 插件占位：后端尚无插件机制，明确说明现状而不提供无响应的操作按钮。 */
function PluginsEmpty(): JSX.Element {
	return (
		<SettingsSection title="插件" description="发现与管理扩展包，为 Agent 添加新的工具与工作流。">
			<div className="settings-coming-soon">
				<div className="settings-coming-soon-icon">
					<PuzzleIcon size={22} />
				</div>
				<h2>插件能力即将推出</h2>
				<p>插件机制正在建设中。目前可通过 Skills 与 MCP 为 Agent 扩展能力，两者可在上方标签切换查看。</p>
			</div>
		</SettingsSection>
	);
}

/** Skills：展示用户级与项目级技能；技能通过文件系统中的 SKILL.md 添加。 */
function SkillsPanel({
	skills,
	summary,
}: {
	readonly skills: readonly SkillSummary[];
	readonly summary: ConfigSummary | undefined;
}): JSX.Element {
	return (
		<SettingsSection title="Skills" description="来自用户目录与当前项目的技能，模型按各技能的 SKILL.md 读取完整说明。">
			{skills.length === 0 ? (
				<div className="settings-empty-hint">
					没有可用技能。在用户技能目录或项目的 <code>.moros/skills</code> 下添加 <code>SKILL.md</code> 即可被发现。
				</div>
			) : (
				<div className="skill-list">
					{skills.map((skill) => (
						<div className="skill-row" key={`${skill.scope}:${skill.path}`}>
							<span className={`pill ${skill.scope === "project" ? "warn" : ""}`}>
								{skill.scope === "project" ? "项目" : "用户"}
							</span>
							<strong>{skill.name}</strong>
							<span>{skill.description}</span>
						</div>
					))}
				</div>
			)}
			{summary !== undefined && summary.skipped.length > 0 ? (
				<div className="inline-notice notice-warn">
					跳过条目：{summary.skipped.map((item) => `${item.path}（${item.reason}）`).join("；")}
				</div>
			) : null}
		</SettingsSection>
	);
}

/** MCP：外部工具服务器的连接状态，支持健康检查与重连。 */
function McpPanel({
	mcp,
	mcpHealth,
	onHealth,
	onReconnect,
}: {
	readonly mcp: readonly McpStatus[];
	readonly mcpHealth: readonly string[];
	readonly onHealth: () => Promise<void>;
	readonly onReconnect: (name: string) => Promise<void>;
}): JSX.Element {
	const connected = mcp.filter((server) => server.status === "connected").length;
	return (
		<SettingsSection
			title="MCP"
			description="外部工具服务器为 Agent 提供额外工具；在配置文件中添加 server 后在此查看连接状态。"
		>
			<div className="section-head">
				<span className="mcp-summary">
					{mcp.length === 0 ? "未配置 server" : `${connected} / ${mcp.length} 已连接`}
				</span>
				<button className="ghost-button small" onClick={() => void onHealth()}>
					<RefreshIcon size={13} />
					健康检查
				</button>
			</div>
			{mcp.length === 0 ? (
				<div className="settings-empty-hint">没有配置 MCP server。在配置文件中添加后，连接状态会显示在这里。</div>
			) : (
				<div className="mcp-list">
					{mcp.map((server) => {
						const isConnected = server.status === "connected";
						return (
							<div className="mcp-row" key={server.name}>
								<span className={`status-dot status-${isConnected ? "ok" : "error"}`} />
								<strong>{server.name}</strong>
								<span className="pill">{server.status}</span>
								<span className="mcp-detail">{server.detail}</span>
								<button className="ghost-button small" onClick={() => void onReconnect(server.name)}>
									重连
								</button>
							</div>
						);
					})}
				</div>
			)}
			{mcpHealth.length > 0 ? (
				<div className="mcp-health-output">
					<div className="detail-label">健康检查输出</div>
					{mcpHealth.map((line) => (
						<div className="mcp-health" key={line}>
							{line}
						</div>
					))}
				</div>
			) : null}
		</SettingsSection>
	);
}

function ComingSoon({ label }: { readonly label: string }): JSX.Element {
	return (
		<div className="settings-coming-soon">
			<div className="settings-coming-soon-icon">
				<SettingsIcon size={22} />
			</div>
			<h2>{label}</h2>
			<p>该分组的设置项即将推出。当前版本可先使用外观、模型、供应商与工作区等分组。</p>
		</div>
	);
}

function SettingsSection({
	title,
	description,
	children,
}: {
	readonly title: string;
	readonly description: string;
	readonly children: ReactNode;
}): JSX.Element {
	return (
		<section className="settings-section-block">
			<h2 className="settings-section-heading">{title}</h2>
			<p className="settings-section-desc">{description}</p>
			{children}
		</section>
	);
}

function SettingsCard({ children }: { readonly children: ReactNode }): JSX.Element {
	return <div className="settings-card">{children}</div>;
}

function SettingsRow({
	label,
	description,
	control,
}: {
	readonly label: string;
	readonly description: string;
	readonly control: ReactNode;
}): JSX.Element {
	return (
		<div className="settings-row">
			<div className="settings-row-text">
				<div className="settings-row-label">{label}</div>
				<div className="settings-row-desc">{description}</div>
			</div>
			<div className="settings-row-control">{control}</div>
		</div>
	);
}

function DisabledSelect({ label }: { readonly label: string }): JSX.Element {
	return (
		<button className="settings-select is-disabled" disabled>
			<span>{label}</span>
			<svg
				width="12"
				height="12"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				strokeWidth="2"
				aria-hidden="true"
			>
				<path d="M6 9l6 6 6-6" />
			</svg>
		</button>
	);
}

function Toggle({ checked, disabled }: { readonly checked: boolean; readonly disabled?: boolean }): JSX.Element {
	return (
		<span className={`settings-toggle ${checked ? "is-on" : ""} ${disabled === true ? "is-disabled" : ""}`}>
			<span className="settings-toggle-knob" />
		</span>
	);
}

function CodePreview({
	title,
	theme,
	badge,
	current,
}: {
	readonly title: string;
	readonly theme: string;
	readonly badge: string;
	readonly current?: boolean;
}): JSX.Element {
	return (
		<div className={`code-preview ${current === true ? "is-current" : ""}`}>
			<div className="code-preview-head">
				<div>
					<div className="code-preview-title">{title}</div>
					<div className="code-preview-theme">{theme}</div>
				</div>
				<span className={`code-preview-badge ${current === true ? "is-current" : ""}`}>{badge}</span>
			</div>
			<pre className="code-preview-code">
				<code>
					<span className="tok-key">const</span> themePreview: <span className="tok-type">ThemeConfig</span> = {"{"}
					{"\n"} surfaces: <span className="tok-string">"sidebar"</span>,{"\n"} accent:{" "}
					<span className="tok-string">"#3390FF"</span>,{"\n"} contrast: <span className="tok-number">45</span>,{"\n"}
					{"}"};
				</code>
			</pre>
		</div>
	);
}
