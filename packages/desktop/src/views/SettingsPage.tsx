import { useEffect, useRef, useState, type JSX, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { applyModelMetadata, type ModelMetadata } from "@moros/core/config/model-catalog/fill.ts";
import type { DiscoveredModel } from "@moros/core/config/model-discovery.ts";
import type { ModelCapability, ModelInputType } from "@moros/core/config/schema.ts";
import type { SettingsPatch, SettingsSnapshot, ProviderDraft, ProviderView } from "@moros/core/config/settings.ts";
import type { ReasoningEffort } from "@moros/core/llm/types.ts";
import type { ConfigSummary } from "../shared/contract.ts";
import { call, errorMessage } from "../api/api.ts";
import { Dropdown } from "../components/Dropdown.tsx";
import { MultiSelect, type MultiSelectOption } from "../components/MultiSelect.tsx";
import {
	AlertIcon,
	CheckIcon,
	EyeIcon,
	EyeOffIcon,
	HelpCircleIcon,
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

const API_OPTIONS: ReadonlyArray<readonly [ProviderView["api"], string]> = [
	["anthropic-messages", "Anthropic Messages (/v1/messages)"],
	["chat-completions", "OpenAI Chat Completions (/v1/chat/completions)"],
	["responses", "OpenAI Responses (/v1/responses)"],
];

interface ModelPreset {
	readonly label: string;
	readonly value: number;
}

const CONTEXT_WINDOW_PRESETS: readonly ModelPreset[] = [
	{ label: "64K", value: 64 * 1024 },
	{ label: "256K", value: 256 * 1024 },
	{ label: "500K", value: 500 * 1024 },
	{ label: "1M", value: 1024 * 1024 },
];

const MAX_TOKEN_PRESETS: readonly ModelPreset[] = [
	{ label: "64K", value: 64 * 1024 },
	{ label: "128K", value: 128 * 1024 },
	{ label: "256K", value: 256 * 1024 },
	{ label: "384K", value: 384 * 1024 },
];

interface ModelInputOption extends MultiSelectOption {
	readonly value: ModelInputType;
}

interface ModelCapabilityOption extends MultiSelectOption {
	readonly value: ModelCapability;
}

const MODEL_INPUT_OPTIONS: readonly ModelInputOption[] = [
	{ value: "text", label: "文本", locked: true },
	{ value: "image", label: "图片" },
	{ value: "video", label: "视频" },
	{ value: "pdf", label: "PDF" },
];

const MODEL_CAPABILITY_OPTIONS: readonly ModelCapabilityOption[] = [
	{ value: "structured-output", label: "结构化输出" },
	{ value: "web-search", label: "原生联网搜索" },
	{ value: "mid-conversation-system", label: "对话中系统消息" },
];

type ReasoningLevel = Exclude<ReasoningEffort, "off">;

const REASONING_OPTIONS: readonly { readonly value: ReasoningLevel; readonly label: string }[] = [
	{ value: "minimal", label: "最低" },
	{ value: "low", label: "低" },
	{ value: "medium", label: "中" },
	{ value: "high", label: "高" },
	{ value: "max", label: "最高" },
];

interface ModelForm {
	id: string;
	name: string;
	maxTokens: string;
	contextWindow: string;
	input: ModelInputType[];
	capabilities: ModelCapability[];
	reasoningEfforts: ReasoningLevel[];
}

/** 模型发现列表的一行：上游字段优先，缺失项由 models.dev 快照补全后的最终值。 */
interface DiscoveredRow {
	readonly id: string;
	readonly name: string;
	readonly contextWindow?: number;
	readonly maxTokens?: number;
	readonly reasoning: boolean;
	readonly reasoningEfforts: readonly Exclude<ReasoningEffort, "off">[];
	readonly input: readonly ModelInputType[];
	/** 该模型原本已在列表中，用于打开弹窗时的默认勾选。 */
	readonly added: boolean;
}

/**
 * 合并上游 `/models` 与 models.dev 快照：上游字段优先，缺失才用快照补。
 * reasoning 只要任一来源声明支持即为支持；档位与输入类型按上游优先取。
 */
function mergeDiscoveredModel(model: DiscoveredModel, fallback: ModelMetadata | null): Omit<DiscoveredRow, "added"> {
	const id = model.id.trim();
	const name = model.name?.trim() || fallback?.name?.trim() || "";
	const reasoning = model.reasoning === true || (fallback?.reasoningEfforts?.length ?? 0) > 0;
	const efforts = model.reasoningEfforts?.length ? model.reasoningEfforts : (fallback?.reasoningEfforts ?? []);
	const input = model.input?.length ? model.input : (fallback?.input ?? ["text"]);
	const contextWindow = model.contextWindow ?? fallback?.contextWindow;
	const maxTokens = model.maxTokens ?? fallback?.maxTokens;
	return {
		id,
		name,
		...(contextWindow === undefined ? {} : { contextWindow }),
		...(maxTokens === undefined ? {} : { maxTokens }),
		reasoning,
		reasoningEfforts: efforts,
		input,
	};
}

function ensureInputTypes(values: readonly string[]): ModelInputType[] {
	const selected = MODEL_INPUT_OPTIONS.filter((option) => values.includes(option.value)).map((option) => option.value);
	return selected.includes("text") ? selected : ["text", ...selected];
}

function ensureCapabilities(values: readonly string[]): ModelCapability[] {
	return MODEL_CAPABILITY_OPTIONS.filter((option) => values.includes(option.value)).map((option) => option.value);
}

function inputTypeLabel(value: ModelInputType): string {
	return MODEL_INPUT_OPTIONS.find((option) => option.value === value)?.label ?? value;
}

function reasoningLabel(value: ReasoningLevel): string {
	return REASONING_OPTIONS.find((option) => option.value === value)?.label ?? value;
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
	return {
		id: "",
		name: "",
		maxTokens: "8192",
		contextWindow: "",
		input: ["text"],
		capabilities: [],
		reasoningEfforts: [],
	};
}

function isHttpUrl(value: string): boolean {
	try {
		const url = new URL(value);
		return url.protocol === "http:" || url.protocol === "https:";
	} catch {
		return false;
	}
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

function formFromProvider(provider: ProviderView, fallbackEffort: ReasoningEffort): ProviderForm {
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
			input: [...model.input],
			capabilities: [...(model.capabilities ?? [])],
			reasoningEfforts: model.reasoning
				? (
						model.reasoningEfforts ?? [model.reasoningEffort ?? (fallbackEffort === "off" ? "medium" : fallbackEffort)]
					).filter((effort): effort is ReasoningLevel => effort !== "off")
				: [],
		})),
	};
}

/** 字段标签 + 问号提示：悬停或键盘聚焦时在标签旁显示说明，替代行内小字。 */
function FieldLabel({ children, hint }: { readonly children: ReactNode; readonly hint: string }): JSX.Element {
	return (
		<span className="prov-field-label">
			{children}
			<span
				className="prov-field-help"
				tabIndex={0}
				role="img"
				aria-label={hint}
				onClick={(event) => event.preventDefault()}
			>
				<HelpCircleIcon size={13} />
				<span className="prov-field-tooltip" role="tooltip">
					{hint}
				</span>
			</span>
		</span>
	);
}

/** 模型容量预设：单选后把对应 Token 数写入输入框，自定义数值仍可直接编辑。 */
function ModelPresetOptions({
	name,
	ariaLabel,
	value,
	presets,
	onChange,
}: {
	readonly name: string;
	readonly ariaLabel: string;
	readonly value: string;
	readonly presets: readonly ModelPreset[];
	readonly onChange: (value: string) => void;
}): JSX.Element {
	const numeric = Number(value);
	return (
		<div className="prov-preset-group" role="radiogroup" aria-label={ariaLabel}>
			{presets.map((preset) => {
				const checked = value.trim().length > 0 && numeric === preset.value;
				return (
					<label key={preset.label} className={`prov-preset ${checked ? "is-selected" : ""}`}>
						<input
							type="radio"
							name={name}
							value={preset.value}
							checked={checked}
							onChange={() => onChange(String(preset.value))}
						/>
						<span>{preset.label}</span>
					</label>
				);
			})}
		</div>
	);
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
	const [selected, setSelected] = useState<string | undefined>(() => firstProvider?.name);
	const [isNew, setIsNew] = useState(false);
	const nextDraftNumber = useRef(1);
	const [draft, setDraft] = useState<ProviderForm>(() =>
		firstProvider === undefined ? emptyForm() : formFromProvider(firstProvider, settings.config.reasoningEffort),
	);
	const [revealed, setRevealed] = useState<Record<string, string>>({});
	const [modelEditor, setModelEditor] = useState<ModelEditorState | undefined>(undefined);
	const [fetchedModels, setFetchedModels] = useState<readonly DiscoveredRow[]>([]);
	const [selectedModelIds, setSelectedModelIds] = useState<ReadonlySet<string>>(new Set());
	const [discoverOpen, setDiscoverOpen] = useState(false);
	const [discoverState, setDiscoverState] = useState<"loading" | "ready" | "error">("loading");
	const [discoverError, setDiscoverError] = useState("");
	const [isSavingDiscovered, setIsSavingDiscovered] = useState(false);
	const discoveryEpoch = useRef(0);
	const metadataEpoch = useRef(0);
	const [showKey, setShowKey] = useState(false);
	const [moreOpen, setMoreOpen] = useState(false);
	const [editingName, setEditingName] = useState(false);
	const [renameValue, setRenameValue] = useState("");
	const moreRef = useRef<HTMLDivElement>(null);

	const current =
		selected === undefined ? undefined : settings.providers.find((provider) => provider.name === selected);
	const keyDisplay = selected === undefined ? "" : (revealed[selected] ?? current?.apiKey.display ?? "");
	// 已有密钥且未揭示时用圆点占位，外观与普通填写内容一致但不进入 value。
	const keyPlaceholderDots = !isNew && keyDisplay.length > 0 && draft.apiKey.length === 0;
	const isEditing = isNew || selected !== undefined;
	const set = (patch: Partial<ProviderForm>): void => setDraft((previous) => ({ ...previous, ...patch }));
	const updateModelEditor = (patch: Partial<ModelForm>): void => {
		setModelEditor((previous) =>
			previous === undefined ? undefined : { ...previous, model: { ...previous.model, ...patch } },
		);
	};
	const toggleReasoningEffort = (value: ReasoningLevel): void => {
		setModelEditor((previous) => {
			if (previous === undefined) return undefined;
			const selectedEfforts = new Set(previous.model.reasoningEfforts);
			if (selectedEfforts.has(value)) selectedEfforts.delete(value);
			else selectedEfforts.add(value);
			return {
				...previous,
				model: {
					...previous.model,
					reasoningEfforts: REASONING_OPTIONS.filter((option) => selectedEfforts.has(option.value)).map(
						(option) => option.value,
					),
				},
			};
		});
	};
	const resetDiscovery = (): void => {
		discoveryEpoch.current += 1;
		setDiscoverOpen(false);
		setFetchedModels([]);
		setSelectedModelIds(new Set());
		setDiscoverState("loading");
		setDiscoverError("");
		setIsSavingDiscovered(false);
	};

	useEffect(() => {
		if (!moreOpen) return;
		const onPointerDown = (event: PointerEvent): void => {
			if (moreRef.current !== null && !moreRef.current.contains(event.target as Node)) setMoreOpen(false);
		};
		document.addEventListener("pointerdown", onPointerDown);
		return () => document.removeEventListener("pointerdown", onPointerDown);
	}, [moreOpen]);

	const selectProvider = (provider: ProviderView): void => {
		resetDiscovery();
		setSelected(provider.name);
		setIsNew(false);
		setDraft(formFromProvider(provider, settings.config.reasoningEffort));
		setRevealed({});
		setShowKey(false);
		setModelEditor(undefined);
		setMoreOpen(false);
		setEditingName(false);
	};

	const clearSelection = (): void => {
		resetDiscovery();
		setSelected(undefined);
		setIsNew(false);
		setDraft(emptyForm());
		setRevealed({});
		setShowKey(false);
		setModelEditor(undefined);
		setMoreOpen(false);
		setEditingName(false);
	};

	const startNew = (): void => {
		let name = `新供应商-${nextDraftNumber.current}`;
		while (settings.providers.some((provider) => provider.name === name)) {
			nextDraftNumber.current += 1;
			name = `新供应商-${nextDraftNumber.current}`;
		}
		nextDraftNumber.current += 1;
		resetDiscovery();
		setSelected(undefined);
		setIsNew(true);
		setDraft({ ...emptyForm(), name });
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
				reasoning: model.reasoningEfforts.length > 0,
				...(model.reasoningEfforts.length === 0 ? {} : { reasoningEfforts: model.reasoningEfforts }),
				input: ensureInputTypes(model.input),
				...(model.capabilities.length === 0 ? {} : { capabilities: model.capabilities }),
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
		const name = (isNew ? form.name : (selected ?? "")).trim();
		if (!readyToSave(form, name)) return;
		try {
			await call(window.moros.settingsUpsertProvider(name, buildPayload(form)));
			await onRefresh();
			if (isNew) {
				setIsNew(false);
				setSelected(name);
				setDraft((previous) => ({ ...previous, name, originalName: name }));
				setRevealed({});
				setShowKey(false);
			}
		} catch (error) {
			onNotice("error", errorMessage(error));
		}
	};

	const toggleReveal = async (): Promise<void> => {
		if (isNew || current === undefined || selected === undefined) {
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
		if (isNew || current === undefined || selected === undefined) return;
		setMoreOpen(false);
		if (!window.confirm(`删除供应商 ${selected}？`)) return;
		try {
			await call(window.moros.settingsDeleteProvider(selected));
			await onRefresh();
			const provider = settings.providers.find((item) => item.name !== selected);
			if (provider === undefined) {
				clearSelection();
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
		if (isNew || selected === undefined) return;
		setRenameValue(selected);
		setEditingName(true);
	};

	/** 行内重命名：名称输入框失焦或回车时提交，空值与未变化直接取消。 */
	const commitRename = async (): Promise<void> => {
		const next = renameValue.trim();
		setEditingName(false);
		if (selected === undefined || next.length === 0 || next === selected) return;
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
			input: ensureInputTypes(model.input),
			capabilities: ensureCapabilities(model.capabilities),
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

	const startAddModel = (): void => {
		setModelEditor({ model: emptyModel() });
	};

	const editModel = (index: number, model: ModelForm): void => {
		setModelEditor({ index, model: { ...model } });
	};

	const closeModelEditor = (): void => {
		setModelEditor(undefined);
	};

	/** 从供应商 `/models` 读取可用模型，在弹窗中展示供勾选。 */
	const discoverModels = async (): Promise<void> => {
		const baseUrl = draft.baseUrl.trim();
		if (!isHttpUrl(baseUrl)) {
			onNotice("warn", "请先填写有效的 Base URL");
			return;
		}
		const apiKey = draft.apiKey.trim();
		const hasSavedKey = !isNew && current !== undefined && current.apiKey.source !== "empty";
		if (apiKey.length === 0 && !hasSavedKey) {
			onNotice("warn", "请先填写 API Key");
			return;
		}
		const epoch = ++discoveryEpoch.current;
		setModelEditor(undefined);
		setFetchedModels([]);
		setSelectedModelIds(new Set());
		setDiscoverState("loading");
		setDiscoverError("");
		setDiscoverOpen(true);
		try {
			const models = await call(
				window.moros.settingsDiscoverModels({
					api: draft.api,
					baseUrl,
					...(apiKey.length === 0 ? {} : { apiKey }),
					...(apiKey.length === 0 && selected !== undefined ? { providerName: selected } : {}),
				}),
			);
			if (epoch !== discoveryEpoch.current) return;
			const existing = new Set(draft.models.map((model) => model.id.trim()));
			// 上游字段优先；仅在字段缺失时并发查 models.dev 快照补全。
			const needFallback = models.filter(
				(model) =>
					model.contextWindow === undefined ||
					model.maxTokens === undefined ||
					(model.reasoning !== true && model.reasoningEfforts === undefined) ||
					model.input === undefined,
			);
			const fallbacks = await Promise.all(needFallback.map((model) => lookupMetadata(model.id.trim())));
			const fallbackById = new Map(needFallback.map((model, index) => [model.id.trim(), fallbacks[index]]));
			if (epoch !== discoveryEpoch.current) return;
			const rows = models.map((model) => ({
				...mergeDiscoveredModel(model, fallbackById.get(model.id.trim()) ?? null),
				added: existing.has(model.id.trim()),
			}));
			setFetchedModels(rows);
			// 默认按当前列表勾选，用户可自由调整后保存同步。
			setSelectedModelIds(new Set(rows.filter((row) => row.added).map((row) => row.id)));
			setDiscoverState("ready");
		} catch (error) {
			if (epoch !== discoveryEpoch.current) return;
			setDiscoverError(errorMessage(error));
			setDiscoverState("error");
		}
	};

	const toggleModelSelection = (id: string): void => {
		setSelectedModelIds((previous) => {
			const next = new Set(previous);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	};

	const toggleAllModels = (): void => {
		const allIds = fetchedModels.map((model) => model.id);
		const allSelected = allIds.length > 0 && allIds.every((id) => selectedModelIds.has(id));
		setSelectedModelIds(allSelected ? new Set() : new Set(allIds));
	};

	/** 按模型 ID 查 models.dev 元数据，用于回填表单默认字段；失败返回空元数据。 */
	const lookupMetadata = async (id: string): Promise<ModelMetadata | null> => {
		try {
			return await call(window.moros.settingsLookupModelMetadata(id));
		} catch {
			return null;
		}
	};

	/** 按模型 ID 查元数据并回填表单默认字段；失败静默（手动输入 ID 失焦时调用）。 */
	const applyMetadataForModel = async (id: string): Promise<void> => {
		const trimmed = id.trim();
		if (trimmed.length === 0) return;
		const epoch = ++metadataEpoch.current;
		const metadata = await lookupMetadata(trimmed);
		if (epoch !== metadataEpoch.current || metadata === null) return;
		setModelEditor((previous) =>
			previous === undefined
				? undefined
				: { ...previous, model: applyModelMetadata(previous.model, emptyModel(), metadata) },
		);
	};

	/**
	 * 按勾选状态同步供应商模型列表：勾选的写入/更新，取消勾选的移除。
	 * 不在本次上游列表中的旧模型保持原样（弹窗里无法表达其取舍）。
	 */
	const saveDiscoveredModels = async (): Promise<void> => {
		const upstreamIds = new Set(fetchedModels.map((model) => model.id));
		// 保留与本次发现无关的模型（上游未返回，弹窗中不可见）。
		const untouched = draft.models.filter((model) => !upstreamIds.has(model.id.trim()));
		const chosen = fetchedModels.filter((model) => selectedModelIds.has(model.id));
		const chosenIds = new Set(chosen.map((model) => model.id));
		const toModelForm = (model: DiscoveredRow): ModelForm => ({
			...emptyModel(),
			id: model.id,
			name: model.name,
			contextWindow: model.contextWindow === undefined ? "" : String(model.contextWindow),
			maxTokens: model.maxTokens === undefined ? "8192" : String(model.maxTokens),
			input: ensureInputTypes(model.input),
			reasoningEfforts: model.reasoning ? [...model.reasoningEfforts] : [],
		});
		// 已存在的勾选模型沿用原条目（保留用户自定义修正），仅新增的用上游数据构造。
		const discoveredById = new Map(chosen.map((model) => [model.id, model]));
		let hasCorrection = false;
		const existingForms = draft.models
			.filter((model) => chosenIds.has(model.id.trim()) && upstreamIds.has(model.id.trim()))
			.map((form) => {
				// 旧版本把 max_input_tokens 误当作输出上限，表现为它恰好等于上下文大小。
				// 命中该特征且上游给出不同输出上限时，修正为真实的 max_output_tokens。
				const discovered = discoveredById.get(form.id.trim());
				if (
					discovered?.maxTokens !== undefined &&
					form.maxTokens === form.contextWindow &&
					String(discovered.maxTokens) !== form.maxTokens
				) {
					hasCorrection = true;
					return { ...form, maxTokens: String(discovered.maxTokens) };
				}
				return form;
			});
		const newForms = chosen
			.filter((model) => !existingForms.some((form) => form.id.trim() === model.id))
			.map(toModelForm);
		const nextModels = [...untouched, ...existingForms, ...newForms];
		const changed =
			hasCorrection ||
			nextModels.length !== draft.models.length ||
			nextModels.some((model, index) => model.id !== draft.models[index]?.id);
		if (!changed) {
			resetDiscovery();
			return;
		}
		setIsSavingDiscovered(true);
		try {
			setDraft((previous) => ({ ...previous, models: nextModels }));
			resetDiscovery();
			await autoSave({ models: nextModels });
			onNotice("info", `已同步模型列表，共 ${nextModels.length} 个模型`);
		} finally {
			setIsSavingDiscovered(false);
		}
	};

	const modelHeading =
		modelEditor === undefined ? "模型列表" : modelEditor.index === undefined ? "添加模型" : "编辑模型";
	const showAddModelMenu = modelEditor === undefined;
	const selectedCount = fetchedModels.filter((model) => selectedModelIds.has(model.id)).length;
	const allModelsSelected = fetchedModels.length > 0 && selectedCount === fetchedModels.length;

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
						{isNew ? (
							<div className="provider-card prov-item is-active">
								<ServerIcon size={15} />
								<span className="prov-item-name">{draft.name.trim() || "新供应商"}</span>
								<span className="prov-item-status is-warn" />
							</div>
						) : null}
					</div>
				</aside>

				{isEditing ? (
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
												setRenameValue(selected ?? "");
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
								<FieldLabel hint="供应商 API 的基础地址，通常以 /v1 结尾">Base URL</FieldLabel>
								<input
									className="prov-input"
									value={draft.baseUrl}
									placeholder="https://api.example.com/v1"
									onChange={(event) => set({ baseUrl: event.target.value })}
									onBlur={() => void autoSave()}
								/>
							</label>
							<label className="prov-field">
								<FieldLabel hint="选择供应商兼容的请求协议，需要与 Base URL 匹配">API 格式</FieldLabel>
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
								<FieldLabel
									hint={
										isNew
											? "访问供应商接口所需的密钥，支持 ${ENV} 与 !command 表达式"
											: "留空保持当前密钥，输入新值会覆盖已保存的密钥"
									}
								>
									API Key
								</FieldLabel>
								<span className="prov-key-wrap">
									<input
										className={`prov-input ${keyPlaceholderDots ? "has-key-placeholder" : ""}`}
										type={showKey ? "text" : "password"}
										value={draft.apiKey}
										placeholder={isNew ? "输入 API Key" : keyPlaceholderDots ? "••••••••••••" : ""}
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
								<h3>{modelHeading}</h3>
								{showAddModelMenu ? (
									<Dropdown
										className="prov-model-add"
										value=""
										options={[]}
										onChange={() => undefined}
										title="模型来源"
										trigger={
											<>
												<PlusIcon size={13} />
												<span>添加模型</span>
											</>
										}
										actions={[
											{
												label: "添加模型",
												icon: <PlusIcon size={14} />,
												onSelect: startAddModel,
											},
											{
												label: "获取模型",
												icon: <RefreshIcon size={14} />,
												onSelect: () => void discoverModels(),
											},
										]}
									/>
								) : null}
							</div>
							{modelEditor !== undefined ? (
								<div className="prov-model-panel">
									<div className="prov-model-fields">
										<div className="prov-field">
											<span id="model-id-label">模型 ID</span>
											<input
												className="prov-input"
												aria-labelledby="model-id-label"
												autoFocus
												value={modelEditor.model.id}
												placeholder="例如 claude-sonnet-4"
												onChange={(event) => updateModelEditor({ id: event.target.value })}
												onBlur={(event) => void applyMetadataForModel(event.target.value)}
											/>
										</div>
										<label className="prov-field">
											<span>模型名称</span>
											<input
												className="prov-input"
												value={modelEditor.model.name}
												placeholder="例如 Claude Sonnet 4"
												onChange={(event) => updateModelEditor({ name: event.target.value })}
											/>
										</label>
										<div className="prov-field">
											<span id="model-context-window-label">上下文</span>
											<input
												className="prov-input"
												aria-labelledby="model-context-window-label"
												value={modelEditor.model.contextWindow}
												placeholder="例如 200000"
												onChange={(event) => updateModelEditor({ contextWindow: event.target.value })}
											/>
											<ModelPresetOptions
												name="model-context-window"
												ariaLabel="上下文预设"
												value={modelEditor.model.contextWindow}
												presets={CONTEXT_WINDOW_PRESETS}
												onChange={(value) => updateModelEditor({ contextWindow: value })}
											/>
										</div>
										<div className="prov-field">
											<span id="model-max-tokens-label">最大输出Token</span>
											<input
												className="prov-input"
												aria-labelledby="model-max-tokens-label"
												value={modelEditor.model.maxTokens}
												placeholder="例如 8192"
												onChange={(event) => updateModelEditor({ maxTokens: event.target.value })}
											/>
											<ModelPresetOptions
												name="model-max-tokens"
												ariaLabel="最大输出Token预设"
												value={modelEditor.model.maxTokens}
												presets={MAX_TOKEN_PRESETS}
												onChange={(value) => updateModelEditor({ maxTokens: value })}
											/>
										</div>
										<div className="prov-field">
											<span>输入类型</span>
											<MultiSelect
												ariaLabel="输入类型"
												value={modelEditor.model.input}
												options={MODEL_INPUT_OPTIONS}
												placeholder="选择输入类型"
												onChange={(values) => updateModelEditor({ input: ensureInputTypes(values) })}
											/>
										</div>
										<div className="prov-field">
											<span>模型能力</span>
											<MultiSelect
												ariaLabel="模型能力"
												value={modelEditor.model.capabilities}
												options={MODEL_CAPABILITY_OPTIONS}
												placeholder="选择模型能力"
												onChange={(values) => updateModelEditor({ capabilities: ensureCapabilities(values) })}
											/>
										</div>
										<div className="prov-field prov-field-wide prov-reasoning">
											<span>推理能力</span>
											<div className="prov-checkbox-group" role="group" aria-label="推理能力">
												<button
													type="button"
													className={`prov-checkbox-button ${modelEditor.model.reasoningEfforts.length === 0 ? "is-checked" : ""}`}
													aria-pressed={modelEditor.model.reasoningEfforts.length === 0}
													title="关闭并清空已选推理档位"
													onClick={() => updateModelEditor({ reasoningEfforts: [] })}
												>
													关闭
												</button>
												{REASONING_OPTIONS.map((option) => {
													const selected = modelEditor.model.reasoningEfforts.includes(option.value);
													return (
														<button
															key={option.value}
															type="button"
															className={`prov-checkbox-button ${selected ? "is-checked" : ""}`}
															aria-pressed={selected}
															onClick={() => toggleReasoningEffort(option.value)}
														>
															{option.label}
														</button>
													);
												})}
											</div>
										</div>
									</div>
									<div className="prov-model-panel-actions">
										<button className="ghost-button" onClick={closeModelEditor}>
											取消
										</button>
										<button className="primary-button" onClick={() => commitModel(modelEditor.model)}>
											<CheckIcon size={14} />
											保存模型
										</button>
									</div>
								</div>
							) : draft.models.length === 0 ? (
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
												<div className="prov-model-facts">
													<span>
														<span className="prov-fact-label">上下文</span>
														<span className="prov-fact-value">
															{model.contextWindow.trim().length > 0
																? Number(model.contextWindow).toLocaleString()
																: "—"}
														</span>
													</span>
													<span>
														<span className="prov-fact-label">最大输出</span>
														<span className="prov-fact-value">{Number(model.maxTokens).toLocaleString()}</span>
													</span>
													<span>
														<span className="prov-fact-label">输入类型</span>
														<span className="prov-fact-value" title={model.input.map(inputTypeLabel).join(" / ")}>
															{model.input.map(inputTypeLabel).join(" / ")}
														</span>
													</span>
													<span>
														<span className="prov-fact-label">推理</span>
														<span
															className="prov-fact-value"
															title={
																model.reasoningEfforts.length > 0
																	? model.reasoningEfforts.map(reasoningLabel).join(" / ")
																	: "不支持"
															}
														>
															{model.reasoningEfforts.length > 0
																? model.reasoningEfforts.map(reasoningLabel).join(" / ")
																: "不支持"}
														</span>
													</span>
												</div>
											</div>
											<div className="prov-model-actions">
												<button className="icon-button" title="编辑模型" onClick={() => editModel(index, model)}>
													<PencilIcon size={18} />
												</button>
												<button className="icon-button danger" title="删除模型" onClick={() => deleteModel(index)}>
													<TrashIcon size={18} />
												</button>
											</div>
										</div>
									))}
								</div>
							)}
						</div>
					</section>
				) : (
					<section className="prov-detail prov-detail-empty">
						<div className="prov-empty-state">
							<span className="prov-detail-icon">
								<ServerIcon size={18} />
							</span>
							<h2>还没有自定义供应商</h2>
							<p>添加供应商并填写 Base URL、API Key 和模型后，就可以在聊天中选择使用。</p>
							<button className="primary-button" onClick={startNew}>
								<PlusIcon size={15} />
								添加供应商
							</button>
						</div>
					</section>
				)}
			</div>
			{discoverOpen
				? createPortal(
						<div
							className="modal-backdrop"
							onClick={() => {
								if (!isSavingDiscovered) resetDiscovery();
							}}
						>
							<div className="modal discover-modal" onClick={(event) => event.stopPropagation()}>
								<div className="modal-head">
									<h2>获取模型</h2>
									<button
										className="icon-button"
										aria-label="关闭"
										disabled={isSavingDiscovered}
										onClick={resetDiscovery}
									>
										<XIcon size={16} />
									</button>
								</div>
								{discoverState === "loading" ? (
									<div className="discover-status">
										<span className="spinner" />
										<span>正在获取模型…</span>
									</div>
								) : discoverState === "error" ? (
									<div className="discover-status">
										<div className="inline-notice notice-error">{discoverError}</div>
										<button className="ghost-button" onClick={() => void discoverModels()}>
											重试
										</button>
									</div>
								) : fetchedModels.length === 0 ? (
									<div className="discover-status">没有发现新的模型</div>
								) : (
									<>
										<div className="discover-hint">共 {fetchedModels.length} 个模型，勾选要保留的</div>
										<div className="discover-table">
											<div className="discover-row discover-row-head">
												<span className="discover-check">
													<input
														type="checkbox"
														aria-label="全选"
														checked={allModelsSelected}
														onChange={toggleAllModels}
													/>
												</span>
												<span>模型 ID</span>
												<span>模型名称</span>
												<span className="discover-num">上下文大小</span>
												<span className="discover-num">最大输出 Token</span>
												<span>推理</span>
											</div>
											<div className="discover-list">
												{fetchedModels.map((model) => (
													<label key={model.id} className="discover-row discover-item">
														<span className="discover-check">
															<input
																type="checkbox"
																aria-label={model.id}
																checked={selectedModelIds.has(model.id)}
																onChange={() => toggleModelSelection(model.id)}
															/>
														</span>
														<span className="discover-item-id" title={model.id}>
															{model.id}
														</span>
														<span className="discover-item-name" title={model.name}>
															{model.name || "—"}
														</span>
														<span className="discover-num">
															{model.contextWindow === undefined ? "—" : model.contextWindow.toLocaleString()}
														</span>
														<span className="discover-num">
															{model.maxTokens === undefined ? "—" : model.maxTokens.toLocaleString()}
														</span>
														<span className={model.reasoning ? "discover-yes" : "discover-no"}>
															{model.reasoning ? "支持" : "不支持"}
														</span>
													</label>
												))}
											</div>
										</div>
									</>
								)}
								<div className="modal-actions">
									<span className="discover-selected-count">已选 {selectedCount} 条</span>
									<button className="ghost-button" disabled={isSavingDiscovered} onClick={resetDiscovery}>
										取消
									</button>
									<button
										className="primary-button"
										disabled={discoverState !== "ready" || isSavingDiscovered}
										onClick={() => void saveDiscoveredModels()}
									>
										{isSavingDiscovered ? (
											<>
												<span className="spinner small" />
												保存中…
											</>
										) : (
											<>保存</>
										)}
									</button>
								</div>
							</div>
						</div>,
						document.body,
					)
				: null}
		</div>
	);
}

export function WorkspaceTab({
	settings,
	summary,
	onUpdate,
	onTrust,
	onDeny,
}: {
	readonly settings: SettingsSnapshot | undefined;
	readonly summary: ConfigSummary | undefined;
	readonly onUpdate: (patch: SettingsPatch, message?: string) => Promise<SettingsSnapshot | undefined>;
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
