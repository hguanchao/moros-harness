import { useCallback, useEffect, useMemo, useState, type JSX, type ReactNode } from "react";

import type { SettingsPatch, SettingsSnapshot } from "#src/core/config/settings.ts";
import type { McpStatus } from "#src/core/mcp/types.ts";
import type { SkillSummary } from "#src/core/skills.ts";
import type { ConfigSummary } from "#src/desktop/shared/contract.ts";
import { call, errorMessage } from "#src/desktop/renderer/api.ts";
import { Dropdown } from "#src/desktop/renderer/Dropdown.tsx";
import {
	ArchiveIcon2,
	BrainIcon,
	DatabaseIcon,
	FolderIcon,
	KeyboardIcon,
	LinkIcon,
	MaximizeIcon,
	MinusIcon,
	MonitorIcon,
	PlugIcon,
	PuzzleIcon,
	RestoreIcon,
	RouteIcon,
	SearchIcon,
	SettingsIcon,
	ShareIcon,
	SlidersIcon,
	SparklesIcon,
	SunIcon,
	TerminalIcon,
	XIcon,
} from "#src/desktop/renderer/icons.tsx";
import { ProvidersTab, WorkspaceTab } from "#src/desktop/renderer/pages/SettingsPage.tsx";
import { useApp } from "#src/desktop/renderer/state.tsx";

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
			["general", "常规", SettingsIcon],
			["appearance", "外观", SunIcon],
			["providers", "供应商", SlidersIcon],
			["browser", "浏览器控制", MonitorIcon],
			["remote", "远程设备", LinkIcon],
			["terminal", "终端控制", TerminalIcon],
			["shortcuts", "键盘快捷键", KeyboardIcon],
		],
	},
	{
		title: "Agent 能力",
		items: [
			["personalize", "个性化", SettingsIcon],
			["behavior", "行为与工具", SlidersIcon],
			["memory", "记忆", BrainIcon],
			["subagents", "子智能体", RouteIcon],
			["plugins", "插件", PuzzleIcon],
			["mcp", "MCP 服务器", PlugIcon],
			["skills", "技能", SparklesIcon],
			["commands", "命令", TerminalIcon],
			["hooks", "钩子", RouteIcon],
		],
	},
	{
		title: "数据与统计",
		items: [
			["workspace", "工作区", FolderIcon],
			["sync", "数据同步", DatabaseIcon],
			["usage", "使用统计", ArchiveIcon2],
			["projects", "项目管理", FolderIcon],
			["archive", "归档管理", ArchiveIcon2],
			["share", "分享管理", ShareIcon],
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
			case "workspace":
			case "mcp":
			case "skills":
				return (
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
			<SettingsTopBar />
			<div className="settings-app-body">
				<nav className="settings-nav" aria-label="设置导航">
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
					<div className="settings-nav-footer">
						<SettingsIcon size={14} />
						<span>连接使用</span>
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

function SettingsTopBar(): JSX.Element {
	const { state, dispatch } = useApp();
	return (
		<header className="settings-topbar">
			<button className="settings-back" onClick={() => dispatch({ type: "page", page: "chat" })}>
				<ChevronLeft size={15} />
				<span>返回工作区</span>
			</button>
			<div className="settings-caption-group">
				<button className="settings-caption" aria-label="最小化" onClick={() => void window.moros.windowMinimize()}>
					<MinusIcon size={14} />
				</button>
				<button
					className="settings-caption"
					aria-label={state.windowMaximized ? "向下还原" : "最大化"}
					onClick={() => void window.moros.windowToggleMaximize()}
				>
					{state.windowMaximized ? <RestoreIcon size={14} /> : <MaximizeIcon size={14} />}
				</button>
				<button
					className="settings-caption settings-caption-close"
					aria-label="关闭"
					onClick={() => void window.moros.windowClose()}
				>
					<XIcon size={14} />
				</button>
			</div>
		</header>
	);
}

function ChevronLeft({ size }: { readonly size: number }): JSX.Element {
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.7"
			aria-hidden="true"
		>
			<path d="M15 18l-6-6 6-6" />
		</svg>
	);
}

/** 外观页：界面设置（真实）+ 代码设置与代码预览（占位展示）。 */
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
			<SettingsSection title="界面设置" description="设置应用主题和界面文字大小。">
				<SettingsCard>
					<SettingsRow
						label="界面主题"
						description="选择浅色、深色或跟随系统主题。"
						control={
							<Dropdown
								value={ui.theme}
								options={[
									{ value: "auto", label: "系统" },
									{ value: "light", label: "浅色" },
									{ value: "dark", label: "深色" },
								]}
								onChange={(theme) => {
									void onUpdate({ ui: { theme: theme as "auto" | "light" | "dark" } }, "主题已更新");
								}}
							/>
						}
					/>
					<SettingsRow
						label="界面字号"
						description="调整应用界面的文字大小，图标和布局尺寸不受影响。"
						control={
							<span className="settings-number">
								<input
									type="number"
									min={12}
									max={20}
									value={ui.fontSize}
									onChange={(event) => {
										const parsed = Number(event.target.value);
										if (Number.isInteger(parsed) && parsed >= 12 && parsed <= 20) {
											void onUpdate({ ui: { fontSize: parsed } });
										}
									}}
								/>
								<span>px</span>
							</span>
						}
					/>
				</SettingsCard>
			</SettingsSection>

			<SettingsSection title="代码设置" description="设置代码内容的主题、字号和显示方式，不受界面字号影响。">
				<SettingsCard>
					<SettingsRow
						label="浅色代码主题"
						description="浅色界面下代码内容使用的主题。"
						control={<DisabledSelect label="GitHub Light" />}
					/>
					<SettingsRow
						label="深色代码主题"
						description="深色界面下代码内容使用的主题。"
						control={<DisabledSelect label="GitHub Dark" />}
					/>
					<SettingsRow
						label="显示行号"
						description="在代码内容和差异视图中显示行号。"
						control={<Toggle checked disabled />}
					/>
					<SettingsRow
						label="长行自动换行"
						description="代码内容过长时自动换行。"
						control={<Toggle checked={false} disabled />}
					/>
					<SettingsRow
						label="代码字号"
						description="调整代码块、文件预览和差异视图的默认字号。"
						control={
							<span className="settings-number is-disabled">
								<span>12</span>
								<span>px</span>
							</span>
						}
					/>
				</SettingsCard>
			</SettingsSection>

			<SettingsSection
				title="代码预览"
				description="同时预览浅色与深色代码主题，当前界面使用的主题会标记为「当前生效」。"
			>
				<div className="code-preview-grid">
					<CodePreview title="浅色预览" theme="GitHub Light" current badge="当前生效" />
					<CodePreview title="深色预览" theme="GitHub Dark" badge="预留" />
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
