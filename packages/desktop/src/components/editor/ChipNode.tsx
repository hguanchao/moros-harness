import {
	DecoratorNode,
	type DOMConversionMap,
	type LexicalNode,
	type SerializedLexicalNode,
	type Spread,
	$applyNodeReplacement,
} from "lexical";
import type { JSX } from "react";

import { FileIcon, QuoteIcon, SlidersIcon, SparklesIcon } from "../Icons.tsx";

/** chip 种类：划词引用 / @文件 / $技能 / /命令。 */
export type ChipKind = "quote" | "file" | "skill" | "command";

/** 序列化后的 chip 数据（落 draft.quotes/mentions 用）。 */
export interface ChipData {
	readonly id: string;
	readonly kind: ChipKind;
	readonly value: string;
	readonly label: string;
}

export type SerializedChipNode = Spread<
	{ chipId: string; chipKind: ChipKind; chipValue: string; chipLabel: string },
	SerializedLexicalNode
>;

const CHIP_ICONS = { quote: QuoteIcon, file: FileIcon, skill: SparklesIcon, command: SlidersIcon } as const;

/**
 * 行内原子 chip 节点（DecoratorNode）：图标 + 文本 + ×，光标不能进入，退格整体删除。
 * 与正文同排由浏览器同一次布局计算，光标天然对齐。
 */
export class ChipNode extends DecoratorNode<JSX.Element> {
	__chipId: string;
	__chipKind: ChipKind;
	__chipValue: string;
	__chipLabel: string;

	constructor(id: string, kind: ChipKind, value: string, label: string, key?: string) {
		super(key);
		this.__chipId = id;
		this.__chipKind = kind;
		this.__chipValue = value;
		this.__chipLabel = label;
	}

	static getType(): string {
		return "chip";
	}

	static clone(node: ChipNode): ChipNode {
		return new ChipNode(node.__chipId, node.__chipKind, node.__chipValue, node.__chipLabel, node.__key);
	}

	static importJSON(serialized: SerializedChipNode): ChipNode {
		return $createChipNode(serialized.chipId, serialized.chipKind, serialized.chipValue, serialized.chipLabel);
	}

	exportJSON(): SerializedChipNode {
		return {
			chipId: this.__chipId,
			chipKind: this.__chipKind,
			chipValue: this.__chipValue,
			chipLabel: this.__chipLabel,
			type: "chip",
			version: 1,
		};
	}

	isInline(): boolean {
		return true;
	}

	createDOM(): HTMLElement {
		const dom = document.createElement("span");
		dom.className = "editor-chip-host";
		dom.setAttribute("data-chip-id", this.__chipId);
		return dom;
	}

	updateDOM(): boolean {
		return false; // DOM 由 React decorate 管理
	}

	decorate(): JSX.Element {
		return <ChipDecoration kind={this.__chipKind} label={this.__chipLabel} />;
	}

	static importDOM(): DOMConversionMap | null {
		return null; // 粘贴 HTML 时 chip 当普通文本，不还原
	}
}

/** 创建 chip 节点。 */
export function $createChipNode(id: string, kind: ChipKind, value: string, label: string): ChipNode {
	return $applyNodeReplacement(new ChipNode(id, kind, value, label));
}

export function $isChipNode(node: LexicalNode | null | undefined): node is ChipNode {
	return node instanceof ChipNode;
}

/** 装饰组件：图标 + 文本 + ×，× 删除整块 chip。 */
/** 装饰组件：图标 + 文本；chip 为原子节点，用退格整体删除。 */
function ChipDecoration({ kind, label }: { readonly kind: ChipKind; readonly label: string }): JSX.Element {
	const Icon = CHIP_ICONS[kind];
	return (
		<span className={`editor-chip editor-chip-${kind}`}>
			<span className="editor-chip-icon">
				<Icon size={12} />
			</span>
			<span className="editor-chip-text" title={label}>
				{label}
			</span>
		</span>
	);
}
