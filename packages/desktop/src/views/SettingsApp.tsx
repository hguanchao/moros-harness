import { useCallback, useEffect, useMemo, useRef, useState, type JSX, type ReactNode } from "react";

import type { SettingsPatch, SettingsSnapshot } from "@moros/core/config/settings.ts";
import type { McpStatus } from "@moros/core/mcp/types.ts";
import type { SkillSummary } from "@moros/core/skills.ts";
import type { ConfigSummary, McpServerDetail, McpServerDraftInput, SkillDraftInput } from "../shared/contract.ts";
import { call, errorMessage } from "../api/api.ts";
import { useConfirm } from "../components/ConfirmDialog.tsx";
import { Dropdown } from "../components/Dropdown.tsx";
import { McpServerDialog } from "../components/McpServerDialog.tsx";
import { SkillDialog } from "../components/SkillDialog.tsx";
import {
	ArchiveIcon2,
	ArrowLeftIcon,
	FileTextIcon,
	FolderIcon,
	MinusIcon,
	MonitorIcon,
	MoonIcon,
	PaletteIcon,
	PlusIcon,
	PuzzleIcon,
	RefreshIcon,
	SearchIcon,
	ServerIcon,
	SettingsIcon,
	SlidersHorizontalIcon,
	SparklesIcon,
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
			["providers", "供应商", ServerIcon],
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
	const { confirm } = useConfirm();
	const [active, setActive] = useState("appearance");
	const [settings, setSettings] = useState<SettingsSnapshot | undefined>(undefined);
	const [summary, setSummary] = useState<ConfigSummary | undefined>(undefined);
	const [skills, setSkills] = useState<readonly SkillSummary[]>([]);
	const [mcp, setMcp] = useState<readonly McpStatus[]>([]);
	const [mcpHealth, setMcpHealth] = useState<readonly string[]>([]);
	const [loadError, setLoadError] = useState<string | undefined>(undefined);
	/** MCP 对话框：undefined 关闭；{ detail } 编辑（detail 为 null 表示新增）。 */
	const [mcpDialog, setMcpDialog] = useState<{ readonly detail: McpServerDetail | null } | undefined>(undefined);
	/** 技能对话框：仅新增，open 即显示。 */
	const [skillDialogOpen, setSkillDialogOpen] = useState(false);
	/** 本工作区是否有回合在飞；有则禁用 MCP 增删改（写通道侧也会拒绝，双层保护）。 */
	const mcpBlocked = Object.values(state.runStates).some((run) => run === "running" || run === "paused");

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

	const update = async (patch: SettingsPatch, _message?: string): Promise<SettingsSnapshot | undefined> => {
		try {
			const next = await call(window.moros.settingsUpdate(patch));
			setSettings(next);
			dispatch({ type: "settings", settings: next });
			await refresh();
			return next;
		} catch (error) {
			console.error(`[moros] ${errorMessage(error)}`);
			return undefined;
		}
	};

	// 设置页不再弹提示：错误写入控制台，其余信息类提示静默丢弃。
	const notice = (level: "info" | "warn" | "error", message: string): void => {
		if (level === "error") console.error(`[moros] ${message}`);
		else if (level === "warn") console.warn(`[moros] ${message}`);
	};

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
				return <GeneralSettings settings={settings} onUpdate={update} />;
			case "extensions":
				return (
					<ExtensionsPanel
						summary={summary}
						skills={skills}
						mcp={mcp}
						mcpHealth={mcpHealth}
						mcpBlocked={mcpBlocked}
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
						onAdd={() => setMcpDialog({ detail: null })}
						onEdit={async (name) => {
							try {
								const detail = await call(window.moros.mcpServerDetail(name));
								if (detail === null || detail === undefined) {
									notice("error", `找不到 MCP server：${name}`);
									return;
								}
								setMcpDialog({ detail });
							} catch (error) {
								notice("error", errorMessage(error));
							}
						}}
						onDelete={async (name) => {
							if (
								!(await confirm({
									title: "删除 MCP 服务器",
									message: `删除会从 config.toml 移除 ${name} 并断开连接，不能撤销。`,
									confirmLabel: "删除",
									danger: true,
								}))
							) {
								return;
							}
							try {
								await call(window.moros.mcpServerRemove(name));
								await refresh();
							} catch (error) {
								notice("error", errorMessage(error));
							}
						}}
						onReload={async () => {
							try {
								await call(window.moros.mcpReload());
								await refresh();
							} catch (error) {
								notice("error", errorMessage(error));
							}
						}}
						onSkillAdd={() => setSkillDialogOpen(true)}
						onSkillDelete={async (path) => {
							if (
								!(await confirm({
									title: "删除技能",
									message: "删除会移除该技能的目录与 SKILL.md，不能撤销。",
									confirmLabel: "删除",
									danger: true,
								}))
							) {
								return;
							}
							try {
								await call(window.moros.skillRemove(path));
								await refresh();
							} catch (error) {
								notice("error", errorMessage(error));
							}
						}}
						onSkillImport={async () => {
							try {
								const imported = await call(window.moros.skillImport());
								if (imported !== null && imported !== undefined) await refresh();
							} catch (error) {
								notice("error", errorMessage(error));
							}
						}}
						onSkillRefresh={async () => {
							await refresh();
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
		<>
			<div className="settings-app">
				<div className="settings-app-body">
					<nav className={`settings-nav ${state.sidebarOpen ? "" : "is-collapsed"}`} aria-label="设置导航">
						<button className="settings-back" onClick={() => dispatch({ type: "page", page: "chat" })}>
							<ArrowLeftIcon size={15} />
							<span>返回工作区</span>
						</button>
						<div className="settings-nav-scroll">
							{NAV_GROUPS.map((group) => (
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
			<McpServerDialog
				open={mcpDialog !== undefined}
				detail={mcpDialog?.detail ?? undefined}
				onClose={() => setMcpDialog(undefined)}
				onSave={async (name, draft: McpServerDraftInput) => {
					await call(window.moros.mcpServerUpsert(name, draft));
					await refresh();
				}}
			/>
			<SkillDialog
				open={skillDialogOpen}
				onClose={() => setSkillDialogOpen(false)}
				onSave={async (draft: SkillDraftInput) => {
					await call(window.moros.skillUpsert(draft));
					await refresh();
				}}
			/>
		</>
	);
}

/** 数值步进器：可点击的 −/+ 按钮 + 可直接输入的文本框，替代原生 number 的难点箭头。 */
function NumberStepper({
	value,
	min,
	max,
	step: stepSize = 1,
	decimals = 0,
	percent = false,
	suffix,
	onChange,
}: {
	readonly value: number;
	readonly min: number;
	readonly max: number;
	readonly step?: number;
	readonly decimals?: number;
	/** 百分比模式：以 0–100 显示（后缀 %），写回时换算为 0–1 比例。 */
	readonly percent?: boolean;
	readonly suffix?: string;
	readonly onChange: (value: number) => void;
}): JSX.Element {
	// 显示值：百分比模式下把 0–1 比例放大 100 倍，其余模式直接显示。
	const toDisplay = (v: number): number => round(v * (percent ? 100 : 1));
	const round = (n: number): number => Number(n.toFixed(decimals));
	const [text, setText] = useState(String(toDisplay(value)));
	useEffect(() => setText(String(toDisplay(value))), [value]);

	const commit = (): void => {
		const parsed = Number(text);
		const displayMin = percent ? min * 100 : min;
		const displayMax = percent ? max * 100 : max;
		if (Number.isFinite(parsed) && parsed >= displayMin && parsed <= displayMax) {
			const displayValue = round(parsed);
			// 百分比模式下比例需保留小数（如 85% -> 0.85），用独立精度而非 decimals。
			const real = percent ? Number((displayValue / 100).toFixed(4)) : displayValue;
			setText(String(displayValue));
			if (real !== value) onChange(real);
		} else {
			setText(String(toDisplay(value)));
		}
	};

	const step = (direction: number): void => {
		const raw = Math.min(max, Math.max(min, value + direction * stepSize));
		const next = percent ? Number(raw.toFixed(4)) : round(raw);
		if (next !== value) onChange(next);
	};

	return (
		<span className="settings-stepper">
			<button type="button" aria-label="减小" data-tooltip="减小" disabled={value <= min} onClick={() => step(-1)}>
				<MinusIcon size={13} />
			</button>
			<input
				className="settings-stepper-input"
				type="text"
				inputMode={decimals > 0 || percent ? "decimal" : "numeric"}
				value={text}
				onChange={(event) => setText(event.target.value)}
				onBlur={commit}
				onKeyDown={(event) => {
					if (event.key === "Enter") commit();
				}}
			/>
			{percent ? (
				<span className="settings-stepper-suffix">%</span>
			) : suffix === undefined ? null : (
				<span className="settings-stepper-suffix">{suffix}</span>
			)}
			<button type="button" aria-label="增大" data-tooltip="增大" disabled={value >= max} onClick={() => step(1)}>
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
					<SettingsRow
						label="界面字体"
						description="内置霞鹜文楷与 Maple Mono CN（分包加载）；系统默认使用平台字体栈。"
						control={
							<Dropdown
								value={ui.fontFamily}
								options={[
									{ value: "system", label: "系统默认" },
									{ value: "wenkai", label: "霞鹜文楷" },
									{ value: "maple", label: "Maple Mono CN" },
								]}
								onChange={(fontFamily) => {
									void onUpdate({ ui: { fontFamily: fontFamily as "system" | "wenkai" | "maple" } }, "字体已更新");
								}}
							/>
						}
					/>
				</SettingsCard>
			</SettingsSection>

			<SettingsSection title="工作步骤与视图" description="控制对话流中工具调用细节、步骤折叠行为与代码工作视图。">
				<SettingsCard>
					<SettingsRow
						label="工作步骤展示"
						description="选择希望看到多少工具调用细节。"
						control={
							<Dropdown
								value={ui.workStepDetail}
								options={[
									{ value: "minimal", label: "简洁" },
									{ value: "standard", label: "标准" },
									{ value: "detailed", label: "详细" },
									{ value: "full", label: "全部" },
								]}
								onChange={(value) => {
									void onUpdate(
										{ ui: { workStepDetail: value as "minimal" | "standard" | "detailed" | "full" } },
										"工作步骤展示已更新",
									);
								}}
							/>
						}
					/>
					<SettingsRow
						label="工作步骤收起时机"
						description="选择何时自动收起工作步骤。"
						control={
							<Dropdown
								value={ui.collapseTiming}
								options={[
									{ value: "never", label: "不自动收起" },
									{ value: "immediately", label: "立即" },
									{ value: "afterToolCall", label: "每次工具调用后" },
									{ value: "afterAnswer", label: "回答结束后" },
								]}
								onChange={(value) => {
									void onUpdate(
										{
											ui: {
												collapseTiming: value as "never" | "immediately" | "afterToolCall" | "afterAnswer",
											},
										},
										"收起时机已更新",
									);
								}}
							/>
						}
					/>
					<SettingsRow
						label="收起后显示的回复"
						description="工作步骤收起后，保留哪些助手回复（关键回复即将支持）。"
						control={
							<Dropdown
								value={ui.collapsedReplies}
								options={[
									{ value: "all", label: "全部回复" },
									{ value: "last", label: "仅最后一条" },
									{ value: "key", label: "仅关键回复" },
									{ value: "none", label: "无" },
								]}
								onChange={(value) => {
									void onUpdate(
										{ ui: { collapsedReplies: value as "all" | "last" | "key" | "none" } },
										"收起后回复已更新",
									);
								}}
							/>
						}
					/>
					<SettingsRow
						label="显示代码工作视图"
						description="开启后，在工作台显示轨迹与本轮代码差异入口，可切换 Agent 预设。"
						control={
							<Toggle
								checked={ui.codeWorkspace}
								onChange={(checked) => {
									void onUpdate({ ui: { codeWorkspace: checked } }, "代码工作视图已更新");
								}}
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

const APPROVAL_OPTIONS: ReadonlyArray<{ readonly value: "ask" | "auto" | "yolo"; readonly label: string }> = [
	{ value: "ask", label: "每次询问" },
	{ value: "auto", label: "自动（高危审查）" },
	{ value: "yolo", label: "完全访问" },
];

const NOTIFY_OPTIONS: ReadonlyArray<{ readonly value: "auto" | "bell" | "desktop" | "off"; readonly label: string }> = [
	{ value: "auto", label: "自动" },
	{ value: "bell", label: "提示音" },
	{ value: "desktop", label: "桌面通知" },
	{ value: "off", label: "关闭" },
];

/** 校验函数：返回 undefined 表示合法，否则返回面向用户的错误原因。 */
type FieldValidator = (value: string) => string | undefined;

function validateHttpProxy(value: string): string | undefined {
	if (!value.trim()) return undefined;
	try {
		const url = new URL(value);
		if (url.protocol !== "http:" && url.protocol !== "https:") return "仅支持 http / https";
	} catch {
		return "URL 格式不正确";
	}
	return undefined;
}

function validateShellPath(value: string): string | undefined {
	const trimmed = value.trim();
	if (trimmed.length === 0) return undefined;
	// 应为可执行文件路径：绝对路径或含路径分隔符；不允许包含空字节。
	if (trimmed.includes("\0")) return "路径不合法";
	if (!trimmed.includes("/") && !trimmed.includes("\\")) return "需为可执行文件的完整路径";
	return undefined;
}

/** 通用自动保存输入框：本地草稿 + 校验 + 防抖提交；非法值不保存并在失焦时回退。 */
function AutoSaveInput({
	value,
	validate,
	onCommit,
	placeholder,
}: {
	readonly value: string;
	readonly validate: FieldValidator;
	readonly onCommit: (value: string) => void;
	readonly placeholder?: string;
}): JSX.Element {
	const [draft, setDraft] = useState(value);
	const timer = useRef<number | undefined>(undefined);
	useEffect(() => setDraft(value), [value]);
	useEffect(() => () => window.clearTimeout(timer.current), []);
	const error = validate(draft);
	const onChange = (next: string): void => {
		setDraft(next);
		window.clearTimeout(timer.current);
		if (validate(next) !== undefined) return;
		timer.current = window.setTimeout(() => onCommit(next), 500);
	};
	return (
		<div className="validated-input">
			<input
				className={`text-input general-input ${error === undefined ? "" : "is-invalid"}`}
				value={draft}
				placeholder={placeholder}
				aria-invalid={error !== undefined}
				onChange={(event) => onChange(event.target.value)}
				onBlur={() => {
					window.clearTimeout(timer.current);
					if (validate(draft) === undefined) onCommit(draft);
					else setDraft(value);
				}}
			/>
			{error === undefined ? null : <span className="validated-input-error">{error}</span>}
		</div>
	);
}

/** 常规页：会话默认行为、运行环境与运行参数；均为用户日常可改的全局默认值。 */
function GeneralSettings({
	settings,
	onUpdate,
}: {
	readonly settings: SettingsSnapshot;
	readonly onUpdate: (patch: SettingsPatch, message?: string) => Promise<SettingsSnapshot | undefined>;
}): JSX.Element {
	const config = settings.config;

	return (
		<>
			<SettingsSection title="默认行为" description="新建会话时采用的审批与通知默认值；修改后自动保存。">
				<SettingsCard>
					<SettingsRow
						label="审批档位"
						description="工具调用前是否询问：每次询问、自动执行（高危交由审查模型）、完全访问。"
						control={
							<Dropdown
								value={config.approval}
								options={APPROVAL_OPTIONS.map((option) => ({ value: option.value, label: option.label }))}
								onChange={(value) => void onUpdate({ approval: value as SettingsPatch["approval"] })}
							/>
						}
					/>
					<SettingsRow
						label="通知方式"
						description="任务结束时的提醒方式；自动按系统能力选择。"
						control={
							<Dropdown
								value={config.ui.notify}
								options={NOTIFY_OPTIONS.map((option) => ({ value: option.value, label: option.label }))}
								onChange={(value) =>
									void onUpdate({
										ui: { notify: value as "auto" | "bell" | "desktop" | "off" },
									})
								}
							/>
						}
					/>
				</SettingsCard>
			</SettingsSection>

			<SettingsSection title="运行环境" description="Shell 与网络代理；修改代理后需重启应用生效，修改后自动保存。">
				<SettingsCard>
					<SettingsRow
						label="终端 Shell"
						description="留空使用系统默认 Shell。"
						control={
							<AutoSaveInput
								value={config.shellPath ?? ""}
								validate={validateShellPath}
								onCommit={(value) => void onUpdate({ shellPath: value.trim().length === 0 ? null : value.trim() })}
								placeholder="留空使用系统默认"
							/>
						}
					/>
					<SettingsRow
						label="HTTP 代理"
						description="例如 http://127.0.0.1:7890；留空则不使用代理。"
						control={
							<AutoSaveInput
								value={config.httpProxy ?? ""}
								validate={validateHttpProxy}
								onCommit={(value) => void onUpdate({ httpProxy: value.trim().length === 0 ? null : value.trim() })}
								placeholder="http://127.0.0.1:7890"
							/>
						}
					/>
				</SettingsCard>
			</SettingsSection>

			<SettingsSection
				title="运行限制"
				description="单回合步数上限、工具输出落盘阈值与流式空闲超时（秒）；0 表示使用默认或不限制。修改后自动保存。"
			>
				<SettingsCard>
					<SettingsRow
						label="最大步数"
						description="单回合最多执行的步数；0 为不限制。"
						control={
							<NumberStepper
								value={config.limits.maxTurns}
								min={0}
								max={1000}
								onChange={(value) => void onUpdate({ limits: { maxTurns: value } })}
							/>
						}
					/>
					<SettingsRow
						label="输出落盘阈值"
						description="工具输出超过该 Token 数时写入文件而非内联；0 为不落盘。"
						control={
							<NumberStepper
								value={config.limits.spillThreshold}
								min={0}
								max={100_000_000}
								step={1024}
								onChange={(value) => void onUpdate({ limits: { spillThreshold: value } })}
							/>
						}
					/>
					<SettingsRow
						label="流式空闲超时（秒）"
						description="流式响应无增量的等待上限；0 为使用默认。"
						control={
							<NumberStepper
								value={config.limits.streamIdleTimeoutSec}
								min={0}
								max={3600}
								onChange={(value) => void onUpdate({ limits: { streamIdleTimeoutSec: value } })}
							/>
						}
					/>
				</SettingsCard>
			</SettingsSection>

			<SettingsSection title="重试" description="模型请求失败时的重试次数与最大退避间隔；修改后自动保存。">
				<SettingsCard>
					<SettingsRow
						label="最大重试次数"
						description="单次请求失败后的重试上限。"
						control={
							<NumberStepper
								value={config.retry.maxRetries}
								min={0}
								max={10}
								onChange={(value) => void onUpdate({ retry: { maxRetries: value } })}
							/>
						}
					/>
					<SettingsRow
						label="最大退避（毫秒）"
						description="重试间隔的上限。"
						control={
							<NumberStepper
								value={config.retry.maxDelayMs}
								min={0}
								max={600_000}
								step={1000}
								onChange={(value) => void onUpdate({ retry: { maxDelayMs: value } })}
							/>
						}
					/>
				</SettingsCard>
			</SettingsSection>

			<SettingsSection
				title="上下文压缩"
				description="上下文占用达到阈值时自动压缩；保留最近比例用于避免丢失近期信息。修改后自动保存。"
			>
				<SettingsCard>
					<SettingsRow
						label="压缩阈值"
						description="上下文占用达到该百分比时自动压缩，如 80%。"
						control={
							<NumberStepper
								value={config.compaction.compactAt}
								min={0}
								max={1}
								step={0.05}
								percent
								onChange={(value) => void onUpdate({ compaction: { compactAt: value } })}
							/>
						}
					/>
					<SettingsRow
						label="保留最近比例"
						description="压缩时保留的最近上下文百分比。"
						control={
							<NumberStepper
								value={config.compaction.keepRecent}
								min={0}
								max={1}
								step={0.05}
								percent
								onChange={(value) => void onUpdate({ compaction: { keepRecent: value } })}
							/>
						}
					/>
					<SettingsRow
						label="摘要超时（秒）"
						description="压缩摘要的模型调用时限；0 为使用默认。"
						control={
							<NumberStepper
								value={config.compaction.summaryTimeoutSec}
								min={0}
								max={600}
								onChange={(value) => void onUpdate({ compaction: { summaryTimeoutSec: value } })}
							/>
						}
					/>
				</SettingsCard>
			</SettingsSection>
		</>
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
	mcpBlocked,
	onHealth,
	onReconnect,
	onAdd,
	onEdit,
	onDelete,
	onReload,
	onSkillAdd,
	onSkillDelete,
	onSkillImport,
	onSkillRefresh,
}: {
	readonly summary: ConfigSummary | undefined;
	readonly skills: readonly SkillSummary[];
	readonly mcp: readonly McpStatus[];
	readonly mcpHealth: readonly string[];
	readonly mcpBlocked: boolean;
	readonly onHealth: () => Promise<void>;
	readonly onReconnect: (name: string) => Promise<void>;
	readonly onAdd: () => void;
	readonly onEdit: (name: string) => Promise<void>;
	readonly onDelete: (name: string) => Promise<void>;
	readonly onReload: () => Promise<void>;
	readonly onSkillAdd: () => void;
	readonly onSkillDelete: (path: string) => Promise<void>;
	readonly onSkillImport: () => Promise<void>;
	readonly onSkillRefresh: () => Promise<void>;
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
				{tab === "skills" ? (
					<SkillsPanel
						skills={skills}
						summary={summary}
						mcpBlocked={mcpBlocked}
						onAdd={onSkillAdd}
						onDelete={onSkillDelete}
						onImport={onSkillImport}
						onRefresh={onSkillRefresh}
					/>
				) : null}
				{tab === "mcp" ? (
					<McpPanel
						mcp={mcp}
						mcpHealth={mcpHealth}
						mcpBlocked={mcpBlocked}
						onHealth={onHealth}
						onReconnect={onReconnect}
						onAdd={onAdd}
						onEdit={onEdit}
						onDelete={onDelete}
						onReload={onReload}
					/>
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

/** Skills：按来源分组，用户技能可添加/导入/删除，项目与共享目录技能只读。 */
function SkillsPanel({
	skills,
	summary,
	mcpBlocked,
	onAdd,
	onDelete,
	onImport,
	onRefresh,
}: {
	readonly skills: readonly SkillSummary[];
	readonly summary: ConfigSummary | undefined;
	readonly mcpBlocked: boolean;
	readonly onAdd: () => void;
	readonly onDelete: (path: string) => Promise<void>;
	readonly onImport: () => Promise<void>;
	readonly onRefresh: () => Promise<void>;
}): JSX.Element {
	const [query, setQuery] = useState("");
	const [addMenuOpen, setAddMenuOpen] = useState(false);
	const addMenuRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (!addMenuOpen) return;
		const close = (event: PointerEvent): void => {
			if (!addMenuRef.current?.contains(event.target as Node)) setAddMenuOpen(false);
		};
		const onKey = (event: KeyboardEvent): void => {
			if (event.key === "Escape") setAddMenuOpen(false);
		};
		document.addEventListener("pointerdown", close);
		document.addEventListener("keydown", onKey);
		return () => {
			document.removeEventListener("pointerdown", close);
			document.removeEventListener("keydown", onKey);
		};
	}, [addMenuOpen]);

	// 搜索按名称与描述过滤；只有用户级技能（~/.moros/skills）可删。
	const needle = query.trim().toLowerCase();
	const matched =
		needle.length === 0
			? skills
			: skills.filter((skill) => `${skill.name} ${skill.description}`.toLowerCase().includes(needle));
	const userSkills = matched.filter((skill) => skill.scope === "user");
	const readonlySkills = matched.filter((skill) => skill.scope === "project");
	const renderRow = (skill: SkillSummary): JSX.Element => (
		<div className="skill-row" key={`${skill.scope}:${skill.path}`}>
			<span className="ext-row-icon">
				<SparklesIcon size={14} />
			</span>
			<span className="ext-row-main">
				<strong>{skill.name}</strong>
				<span className="ext-row-desc">{skill.description || "无描述"}</span>
			</span>
			{skill.scope === "user" ? (
				<span className="mcp-actions">
					<button className="ghost-button small" disabled={mcpBlocked} onClick={() => void onDelete(skill.path)}>
						删除
					</button>
				</span>
			) : (
				<span className="pill">只读</span>
			)}
		</div>
	);
	return (
		<>
			<div className="ext-toolbar">
				<div className="ext-search">
					<SearchIcon size={13} />
					<input
						value={query}
						onChange={(event) => setQuery(event.target.value)}
						placeholder="搜索技能"
						aria-label="搜索技能"
					/>
				</div>
				<button className="ghost-button small ext-icon-button" aria-label="刷新技能" onClick={() => void onRefresh()}>
					<RefreshIcon size={14} />
				</button>
				<div className="ext-add-menu" ref={addMenuRef}>
					<button
						className="primary-button small ext-icon-button"
						aria-label="添加技能"
						aria-expanded={addMenuOpen}
						disabled={mcpBlocked}
						onClick={() => setAddMenuOpen((open) => !open)}
					>
						<PlusIcon size={16} />
					</button>
					{addMenuOpen ? (
						<div className="ext-add-dropdown">
							<button
								type="button"
								onClick={() => {
									setAddMenuOpen(false);
									onAdd();
								}}
							>
								<FileTextIcon size={14} />
								创建技能
							</button>
							<button
								type="button"
								onClick={() => {
									setAddMenuOpen(false);
									void onImport();
								}}
							>
								<FolderIcon size={14} />
								上传技能
							</button>
						</div>
					) : null}
				</div>
			</div>
			{mcpBlocked ? <div className="mcp-busy-hint">当前有回合正在运行，期间不能添加或删除技能。</div> : null}
			{skills.length === 0 ? (
				<div className="settings-empty-hint">
					没有可用技能。点右上角 + 新建，或上传一个含 <code>SKILL.md</code> 的目录。
				</div>
			) : matched.length === 0 ? (
				<div className="settings-empty-hint">没有匹配的技能。</div>
			) : (
				<div className="skill-list">
					{userSkills.map(renderRow)}
					{readonlySkills.length > 0 ? (
						<>
							<div className="ext-group-title">项目与共享技能（只读）</div>
							{readonlySkills.map(renderRow)}
						</>
					) : null}
				</div>
			)}
			{summary !== undefined && summary.skipped.length > 0 ? (
				<div className="inline-notice notice-warn">
					跳过条目：{summary.skipped.map((item) => `${item.path}（${item.reason}）`).join("；")}
				</div>
			) : null}
		</>
	);
}

/** MCP 连接状态的中文文案：用语义词替代原始枚举值，便于一眼读懂。 */
function mcpStatusLabel(status: string): string {
	switch (status) {
		case "connected":
			return "已连接";
		case "connecting":
			return "连接中";
		case "unreachable":
			return "连接失败";
		case "disabled":
			return "已禁用";
		default:
			return "未连接";
	}
}

/** MCP：外部工具服务器的连接状态与管理，回合运行中禁止增删改。 */
function McpPanel({
	mcp,
	mcpHealth,
	mcpBlocked,
	onHealth,
	onReconnect,
	onAdd,
	onEdit,
	onDelete,
	onReload,
}: {
	readonly mcp: readonly McpStatus[];
	readonly mcpHealth: readonly string[];
	readonly mcpBlocked: boolean;
	readonly onHealth: () => Promise<void>;
	readonly onReconnect: (name: string) => Promise<void>;
	readonly onAdd: () => void;
	readonly onEdit: (name: string) => Promise<void>;
	readonly onDelete: (name: string) => Promise<void>;
	readonly onReload: () => Promise<void>;
}): JSX.Element {
	const connected = mcp.filter((server) => server.status === "connected").length;
	return (
		<SettingsSection title="MCP" description="外部工具服务器为 Agent 提供额外工具；添加或编辑后连接到下一回合生效。">
			<div className="section-head">
				<span className="mcp-summary">
					{mcp.length === 0 ? "未配置 server" : `${connected} / ${mcp.length} 已连接`}
				</span>
				<span className="ext-actions">
					<button className="ghost-button small" onClick={() => void onHealth()}>
						<RefreshIcon size={13} />
						健康检查
					</button>
					<button className="ghost-button small" disabled={mcpBlocked} onClick={() => void onReload()}>
						<RefreshIcon size={13} />
						重新加载
					</button>
					<button className="primary-button small" disabled={mcpBlocked} onClick={onAdd}>
						<PlusIcon size={14} />
						添加连接器
					</button>
				</span>
			</div>
			{mcpBlocked ? (
				<div className="mcp-busy-hint">当前有回合正在运行，期间不能新增、编辑或删除 MCP 服务器。</div>
			) : null}
			{mcp.length === 0 ? (
				<div className="settings-empty-hint">没有配置 MCP server。点「添加连接器」新建一个。</div>
			) : (
				<div className="mcp-list">
					{mcp.map((server) => {
						const isConnected = server.status === "connected";
						return (
							<div className={`mcp-row ${mcpBlocked ? "is-busy" : ""}`} key={server.name}>
								<span className={`status-dot status-${isConnected ? "ok" : "error"}`} />
								<span className="ext-row-main">
									<strong>{server.name}</strong>
									<span className="ext-row-desc">{server.detail || "无详情"}</span>
								</span>
								<span className={`pill ${isConnected ? "" : "warn"}`}>{mcpStatusLabel(server.status)}</span>
								<span className="mcp-actions">
									<button className="ghost-button small" disabled={mcpBlocked} onClick={() => void onEdit(server.name)}>
										编辑
									</button>
									<button className="ghost-button small" onClick={() => void onReconnect(server.name)}>
										重连
									</button>
									<button
										className="ghost-button small"
										disabled={mcpBlocked}
										onClick={() => void onDelete(server.name)}
									>
										删除
									</button>
								</span>
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

function Toggle({
	checked,
	disabled,
	onChange,
}: {
	readonly checked: boolean;
	readonly disabled?: boolean;
	/** 提供时开关可点击；缺省时保持只读展示（编辑器预览等占位项使用）。 */
	readonly onChange?: (checked: boolean) => void;
}): JSX.Element {
	const readOnly = disabled === true || onChange === undefined;
	return (
		<button
			type="button"
			role="switch"
			aria-checked={checked}
			disabled={readOnly}
			className={`settings-toggle ${checked ? "is-on" : ""} ${readOnly ? "is-disabled" : ""}`}
			onClick={() => {
				if (!readOnly) onChange(!checked);
			}}
		>
			<span className="settings-toggle-knob" />
		</button>
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
