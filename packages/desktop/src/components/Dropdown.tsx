import { useEffect, useRef, useState, type JSX, type ReactNode } from "react";

import { CheckIcon, ChevronDownIcon } from "./Icons.tsx";

/** 下拉选项，可带分组标题、图标与禁用态。 */
export interface DropdownOption {
	readonly value: string;
	readonly label: string;
	/** 选项前的图标。 */
	readonly icon?: ReactNode;
	/** 选项下方的补充说明；存在时菜单项自动增高并允许换行。 */
	readonly description?: string;
	/** 分组名；同一分组的连续选项共用一个小标题。 */
	readonly group?: string;
	readonly disabled?: boolean;
}

/** 菜单底部操作项：只执行动作、不改变当前选中值，例如“创建项目”或开关项。 */
export interface DropdownAction {
	readonly label: string;
	readonly icon?: ReactNode;
	/** 操作下方的补充说明；存在时菜单项自动增高并允许换行。 */
	readonly description?: string;
	/** 是否作为当前单选结果；开启时显示勾选。 */
	readonly selected?: boolean;
	readonly onSelect: () => void;
	readonly disabled?: boolean;
}

/** 触发按钮外观：box 为带边框的独立控件，inline 为嵌入工具栏的轻量控件。 */
type DropdownVariant = "box" | "inline";

/**
 * 主题化下拉框：统一替代原生 select 的系统弹层，明暗主题一致。
 * 支持外部自绘触发器（如带图标的工具栏按钮）与分组选项。
 */
export function Dropdown({
	value,
	options,
	onChange,
	variant = "box",
	placeholder = "请选择",
	trigger,
	className,
	title,
	disabled = false,
	actions = [],
}: {
	readonly value: string;
	readonly options: readonly DropdownOption[];
	readonly onChange: (value: string) => void;
	readonly variant?: DropdownVariant;
	readonly placeholder?: string;
	/** 自定义触发器内容；不传则显示选中项文本 + 箭头。 */
	readonly trigger?: ReactNode;
	readonly className?: string;
	readonly title?: string;
	/** 禁用时不可打开菜单或选择选项。 */
	readonly disabled?: boolean;
	/** 选项之后、分割线下方展示的操作项。 */
	readonly actions?: readonly DropdownAction[];
}): JSX.Element {
	const [open, setOpen] = useState(false);
	const rootRef = useRef<HTMLDivElement>(null);
	const selected = options.find((option) => option.value === value && option.disabled !== true);
	const label = selected?.label ?? placeholder;

	useEffect(() => {
		if (!open) return;
		if (disabled) {
			setOpen(false);
			return;
		}
		const onPointerDown = (event: PointerEvent): void => {
			if (rootRef.current !== null && !rootRef.current.contains(event.target as Node)) setOpen(false);
		};
		const onKeyDown = (event: KeyboardEvent): void => {
			if (event.key === "Escape") setOpen(false);
		};
		document.addEventListener("pointerdown", onPointerDown);
		document.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown);
			document.removeEventListener("keydown", onKeyDown);
		};
	}, [open, disabled]);

	const groups = groupOptions(options);

	return (
		<div className={`dropdown dropdown-${variant} ${className ?? ""}`} ref={rootRef} title={title}>
			<button
				type="button"
				className={`dropdown-trigger ${open ? "is-open" : ""}`}
				aria-haspopup="listbox"
				aria-expanded={open && !disabled}
				disabled={disabled}
				onClick={() => setOpen((previous) => !previous)}
			>
				{trigger ?? (
					<span className="dropdown-label">
						{selected?.icon !== undefined ? <span className="dropdown-option-icon">{selected.icon}</span> : null}
						<span>{label}</span>
					</span>
				)}
				<ChevronDownIcon size={variant === "inline" ? 12 : 15} />
			</button>
			{open && !disabled ? (
				<div className="dropdown-menu" role="listbox">
					{groups.map((group, groupIndex) => (
						<div className="dropdown-group" key={group.name ?? groupIndex}>
							{group.name !== undefined ? <div className="dropdown-group-label">{group.name}</div> : null}
							{group.items.map((option) => (
								<button
									key={option.value}
									type="button"
									role="option"
									data-value={option.value}
									aria-selected={option.value === value}
									className={`dropdown-option ${option.value === value ? "is-selected" : ""} ${option.description === undefined ? "" : "has-description"}`}
									disabled={option.disabled === true}
									onClick={() => {
										onChange(option.value);
										setOpen(false);
									}}
								>
									<DropdownItem icon={option.icon} label={option.label} description={option.description} />
									{option.value === value ? <CheckIcon size={14} /> : null}
								</button>
							))}
						</div>
					))}
					{actions.length > 0 ? (
						<div className={`dropdown-actions ${groups.length === 0 ? "is-first" : ""}`}>
							{actions.map((action, index) => (
								<button
									key={`${action.label}-${index}`}
									type="button"
									className={`dropdown-option ${action.description === undefined ? "" : "has-description"} ${action.selected === true ? "is-selected" : ""}`}
									disabled={action.disabled === true}
									onClick={() => {
										setOpen(false);
										action.onSelect();
									}}
								>
									<DropdownItem icon={action.icon} label={action.label} description={action.description} />
									{action.selected === true ? <CheckIcon size={14} /> : null}
								</button>
							))}
						</div>
					) : null}
				</div>
			) : null}
		</div>
	);
}

/** 选项与操作共用的内容排版：有说明时标题行与说明分开。 */
function DropdownItem({
	icon,
	label,
	description,
}: {
	readonly icon?: ReactNode;
	readonly label: string;
	/** 显式允许 undefined，调用方直接透传可选字段。 */
	readonly description: string | undefined;
}): JSX.Element {
	if (description === undefined) {
		return (
			<span className="dropdown-option-text">
				{icon !== undefined ? <span className="dropdown-option-icon">{icon}</span> : null}
				<span>{label}</span>
			</span>
		);
	}
	return (
		<span className="dropdown-option-text">
			<span className={`dropdown-option-copy ${icon === undefined ? "" : "has-icon"}`}>
				<span className="dropdown-option-title">
					{icon !== undefined ? <span className="dropdown-option-icon">{icon}</span> : null}
					<span>{label}</span>
				</span>
				<span className="dropdown-option-description">{description}</span>
			</span>
		</span>
	);
}

interface OptionGroup {
	readonly name: string | undefined;
	readonly items: readonly DropdownOption[];
}

/** 连续的同名 group 合并为一组；未分组的选项各自归入一个无名组。 */
function groupOptions(options: readonly DropdownOption[]): readonly OptionGroup[] {
	const groups: Array<{ name: string | undefined; items: DropdownOption[] }> = [];
	for (const option of options) {
		const last = groups[groups.length - 1];
		if (last !== undefined && last.name === option.group) {
			last.items.push(option);
		} else {
			groups.push({ name: option.group, items: [option] });
		}
	}
	return groups;
}
