import { useEffect, useRef, useState, type JSX } from "react";
import { createPortal } from "react-dom";

import { CheckIcon, ChevronDownIcon } from "./Icons.tsx";

/** 可搜索单选项；label 为主文本，description 为补充说明。 */
export interface SearchSelectOption {
	readonly value: string;
	readonly label: string;
	readonly description?: string;
}

interface MenuPosition {
	readonly left: number;
	readonly top?: number;
	readonly bottom?: number;
	readonly width: number;
	readonly maxHeight: number;
}

/**
 * 可搜索单选下拉：输入框位于触发器内部，直接输入即可过滤选项。
 * 菜单通过 portal 挂到 body；选中后回填值，失焦或关闭时恢复已选值。
 */
export function SearchSelect({
	value,
	options,
	onChange,
	placeholder,
	ariaLabel,
}: {
	readonly value: string;
	readonly options: readonly SearchSelectOption[];
	readonly onChange: (value: string) => void;
	readonly placeholder: string;
	readonly ariaLabel: string;
}): JSX.Element {
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	const [inputValue, setInputValue] = useState("");
	const [activeIndex, setActiveIndex] = useState(0);
	const [position, setPosition] = useState<MenuPosition | undefined>(undefined);
	const rootRef = useRef<HTMLDivElement>(null);
	const inputRef = useRef<HTMLInputElement>(null);
	const menuRef = useRef<HTMLDivElement>(null);
	const selected = options.find((option) => option.value === value);
	const needle = query.trim().toLowerCase();
	const filtered =
		needle.length === 0
			? options
			: options.filter(
					(option) =>
						option.value.toLowerCase().includes(needle) ||
						option.label.toLowerCase().includes(needle) ||
						option.description?.toLowerCase().includes(needle) === true,
				);

	useEffect(() => {
		if (!open) setInputValue(selected?.value ?? "");
	}, [open, selected?.value]);

	useEffect(() => {
		if (open) setActiveIndex(0);
	}, [open, query]);

	useEffect(() => {
		if (!open) return;
		const close = (): void => {
			setOpen(false);
			setQuery("");
			setInputValue(selected?.value ?? "");
		};
		const onPointerDown = (event: PointerEvent): void => {
			const target = event.target as Node;
			if (rootRef.current?.contains(target) === true || menuRef.current?.contains(target) === true) return;
			close();
		};
		const onKeyDown = (event: KeyboardEvent): void => {
			if (event.key === "Escape") close();
		};
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
	}, [open, selected?.value]);

	const showMenu = (): void => {
		const rect = rootRef.current?.getBoundingClientRect();
		if (rect === undefined) return;
		const width = Math.min(Math.max(rect.width, 320), window.innerWidth - 16);
		const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
		const spaceBelow = window.innerHeight - rect.bottom - 12;
		const spaceAbove = rect.top - 12;
		const openUp = spaceBelow < 260 && spaceAbove > spaceBelow;
		const maxHeight = Math.max(160, Math.min(340, (openUp ? spaceAbove : spaceBelow) - 8));
		setPosition(
			openUp
				? { left, bottom: window.innerHeight - rect.top + 4, width, maxHeight }
				: { left, top: rect.bottom + 4, width, maxHeight },
		);
		setOpen(true);
	};

	const openMenu = (): void => {
		setQuery("");
		setInputValue(selected?.value ?? "");
		showMenu();
	};

	const closeMenu = (): void => {
		setOpen(false);
		setQuery("");
		setInputValue(selected?.value ?? "");
	};

	const select = (option: SearchSelectOption): void => {
		onChange(option.value);
		setInputValue(option.value);
		setQuery("");
		setOpen(false);
	};

	return (
		<div className="search-select" ref={rootRef}>
			<div className={`search-select-trigger ${open ? "is-open" : ""}`}>
				<input
					ref={inputRef}
					className="search-select-input"
					value={inputValue}
					placeholder={placeholder}
					role="combobox"
					aria-label={ariaLabel}
					aria-expanded={open}
					aria-autocomplete="list"
					aria-controls="search-select-options"
					onFocus={(event) => {
						if (!open) openMenu();
						event.currentTarget.select();
					}}
					onClick={() => {
						if (!open) openMenu();
					}}
					onChange={(event) => {
						const next = event.target.value;
						setInputValue(next);
						setQuery(next);
						if (!open) showMenu();
					}}
					onKeyDown={(event) => {
						if (event.key === "ArrowDown") {
							event.preventDefault();
							setActiveIndex((index) => Math.min(index + 1, Math.max(0, filtered.length - 1)));
							return;
						}
						if (event.key === "ArrowUp") {
							event.preventDefault();
							setActiveIndex((index) => Math.max(index - 1, 0));
							return;
						}
						if (event.key === "Escape") {
							event.preventDefault();
							closeMenu();
							return;
						}
						if (event.key === "Enter") {
							const option = filtered[activeIndex] ?? filtered[0];
							if (option !== undefined) {
								event.preventDefault();
								select(option);
							}
						}
					}}
				/>
				<button
					type="button"
					className="search-select-chevron"
					aria-label={open ? "收起模型列表" : "展开模型列表"}
					onClick={() => {
						if (open) closeMenu();
						else inputRef.current?.focus();
					}}
				>
					<ChevronDownIcon size={15} />
				</button>
			</div>
			{open && position !== undefined
				? createPortal(
						<div
							ref={menuRef}
							id="search-select-options"
							className="search-select-menu"
							role="listbox"
							aria-label={ariaLabel}
							style={{
								left: position.left,
								width: position.width,
								maxHeight: position.maxHeight,
								...(position.top === undefined ? {} : { top: position.top }),
								...(position.bottom === undefined ? {} : { bottom: position.bottom }),
							}}
						>
							<div className="search-select-options">
								{filtered.length === 0 ? (
									<div className="search-select-empty">没有匹配的模型</div>
								) : (
									filtered.map((option, index) => {
										const isSelected = option.value === value;
										return (
											<button
												key={option.value}
												type="button"
												role="option"
												aria-selected={isSelected}
												className={`search-select-option ${isSelected ? "is-selected" : ""} ${index === activeIndex ? "is-active" : ""}`}
												onMouseEnter={() => setActiveIndex(index)}
												onClick={() => select(option)}
											>
												<span className="search-select-copy">
													<span className="search-select-label">{option.label}</span>
													{option.description === undefined ? null : (
														<span className="search-select-description">{option.description}</span>
													)}
												</span>
												{isSelected ? <CheckIcon size={14} /> : null}
											</button>
										);
									})
								)}
							</div>
						</div>,
						document.body,
					)
				: null}
		</div>
	);
}
