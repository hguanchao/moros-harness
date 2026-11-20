import { useEffect, useRef, useState, type JSX, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";

import { CheckIcon, ChevronDownIcon, XIcon } from "./Icons.tsx";

/** 多选项：locked 项始终选中且不允许取消。 */
export interface MultiSelectOption {
	readonly value: string;
	readonly label: string;
	readonly locked?: boolean;
}

interface MenuPosition {
	readonly left: number;
	readonly top?: number;
	readonly bottom?: number;
	readonly width: number;
	readonly maxHeight: number;
}

/** 触发器最多展示的标签数；两个标签能在模型能力这类较长文案下仍与箭头共存。 */
const MAX_VISIBLE_TAGS = 2;

/**
 * 多选下拉框：触发器用标签展示选中项，菜单通过 portal 挂到 body，避免被设置页滚动容器裁剪。
 * 点击选项不关闭菜单，点击外部或按 Escape 关闭。
 */
export function MultiSelect({
	value,
	options,
	onChange,
	placeholder,
	ariaLabel,
}: {
	readonly value: readonly string[];
	readonly options: readonly MultiSelectOption[];
	readonly onChange: (value: string[]) => void;
	readonly placeholder: string;
	readonly ariaLabel: string;
}): JSX.Element {
	const [open, setOpen] = useState(false);
	const [position, setPosition] = useState<MenuPosition | undefined>(undefined);
	const rootRef = useRef<HTMLDivElement>(null);
	const triggerRef = useRef<HTMLDivElement>(null);
	const menuRef = useRef<HTMLDivElement>(null);
	const selected = new Set(value);
	const selectedOptions = options.filter((option) => selected.has(option.value));
	const visibleOptions = selectedOptions.slice(0, MAX_VISIBLE_TAGS);
	const hiddenOptions = selectedOptions.slice(MAX_VISIBLE_TAGS);

	useEffect(() => {
		if (!open) return;
		const close = (): void => setOpen(false);
		const onPointerDown = (event: PointerEvent): void => {
			const target = event.target as Node;
			if (rootRef.current?.contains(target) === true || menuRef.current?.contains(target) === true) return;
			close();
		};
		const onKeyDown = (event: KeyboardEvent): void => {
			if (event.key === "Escape") close();
		};
		// 页面滚动会改变触发器位置，关闭菜单；菜单自身滚动不关闭。
		const onScroll = (event: Event): void => {
			if (menuRef.current?.contains(event.target as Node) === true) return;
			close();
		};
		document.addEventListener("pointerdown", onPointerDown);
		document.addEventListener("keydown", onKeyDown);
		window.addEventListener("scroll", onScroll, true);
		window.addEventListener("resize", close);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown);
			document.removeEventListener("keydown", onKeyDown);
			window.removeEventListener("scroll", onScroll, true);
			window.removeEventListener("resize", close);
		};
	}, [open]);

	const toggleMenu = (): void => {
		if (open) {
			setOpen(false);
			return;
		}
		const rect = triggerRef.current?.getBoundingClientRect();
		if (rect === undefined) return;
		const width = Math.min(Math.max(rect.width, 300), window.innerWidth - 16);
		const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
		const spaceBelow = window.innerHeight - rect.bottom - 12;
		const spaceAbove = rect.top - 12;
		const openUp = spaceBelow < 240 && spaceAbove > spaceBelow;
		const maxHeight = Math.max(120, Math.min(320, (openUp ? spaceAbove : spaceBelow) - 8));
		setPosition(
			openUp
				? { left, bottom: window.innerHeight - rect.top + 4, width, maxHeight }
				: { left, top: rect.bottom + 4, width, maxHeight },
		);
		setOpen(true);
	};

	const toggleOption = (option: MultiSelectOption): void => {
		if (option.locked === true) return;
		onChange(selected.has(option.value) ? value.filter((item) => item !== option.value) : [...value, option.value]);
	};

	const removeOption = (option: MultiSelectOption): void => {
		if (option.locked === true) return;
		onChange(value.filter((item) => item !== option.value));
	};

	const onTriggerKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
		if (event.target !== event.currentTarget) return;
		if (event.key === "Enter" || event.key === " ") {
			event.preventDefault();
			toggleMenu();
		}
		if (event.key === "Escape") setOpen(false);
	};

	return (
		<div className="multi-select" ref={rootRef}>
			<div
				ref={triggerRef}
				className={`multi-select-trigger ${open ? "is-open" : ""}`}
				role="combobox"
				tabIndex={0}
				aria-haspopup="listbox"
				aria-expanded={open}
				aria-label={ariaLabel}
				title={selectedOptions.length === 0 ? undefined : selectedOptions.map((option) => option.label).join("、")}
				onClick={toggleMenu}
				onKeyDown={onTriggerKeyDown}
			>
				<div className="multi-select-tags">
					{selectedOptions.length === 0 ? (
						<span className="multi-select-placeholder">{placeholder}</span>
					) : (
						<>
							{visibleOptions.map((option) => (
								<span className="multi-select-tag" key={option.value}>
									<span className="multi-select-tag-label">{option.label}</span>
									{option.locked === true ? null : (
										<button
											type="button"
											className="multi-select-tag-remove"
											aria-label={`移除 ${option.label}`}
											onClick={(event) => {
												event.stopPropagation();
												removeOption(option);
											}}
										>
											<XIcon size={10} />
										</button>
									)}
								</span>
							))}
							{hiddenOptions.length === 0 ? null : (
								<span className="multi-select-count" title={hiddenOptions.map((option) => option.label).join("、")}>
									+{hiddenOptions.length}
								</span>
							)}
						</>
					)}
				</div>
				<ChevronDownIcon size={15} />
			</div>
			{open && position !== undefined
				? createPortal(
						<div
							ref={menuRef}
							className="multi-select-menu"
							role="listbox"
							aria-label={ariaLabel}
							aria-multiselectable="true"
							style={{
								left: position.left,
								width: position.width,
								maxHeight: position.maxHeight,
								...(position.top === undefined ? {} : { top: position.top }),
								...(position.bottom === undefined ? {} : { bottom: position.bottom }),
							}}
						>
							{options.map((option) => {
								const isSelected = selected.has(option.value);
								return (
									<button
										key={option.value}
										type="button"
										role="option"
										aria-selected={isSelected}
										aria-disabled={option.locked === true}
										className={`multi-select-option ${isSelected ? "is-selected" : ""} ${option.locked === true ? "is-locked" : ""}`}
										onClick={() => toggleOption(option)}
									>
										<span className="multi-select-option-label">{option.label}</span>
										{isSelected ? <CheckIcon size={14} /> : null}
									</button>
								);
							})}
						</div>,
						document.body,
					)
				: null}
		</div>
	);
}
