/**
 * Lexical EditorState <-> 草稿数据（纯文本 + chip 列表）的双向序列化。
 *
 * 草稿里的 text 只含普通正文（不含 chip 显示文字）；chip 作为结构化数据存
 * draft.quotes/mentions。发送时 buildModelInput 用这三者拼模型输入。
 */

import {
	$createParagraphNode,
	$createTextNode,
	$getRoot,
	$isParagraphNode,
	$isTextNode,
	type EditorState,
	type LexicalNode,
} from "lexical";

import type { ChipData, ChipNode } from "./ChipNode.tsx";
import { $createChipNode, $isChipNode } from "./ChipNode.tsx";

export interface EditorDraft {
	readonly text: string;
	readonly quotes: readonly ChipData[];
	readonly mentions: readonly ChipData[];
}

/** 从 EditorState 提取纯正文 + chip 列表。 */
export function serializeEditor(editorState: EditorState): EditorDraft {
	return editorState.read(() => {
		let text = "";
		const quotes: ChipData[] = [];
		const mentions: ChipData[] = [];
		const root = $getRoot();

		const walk = (node: LexicalNode): void => {
			if ($isChipNode(node)) {
				const data: ChipData = {
					id: node.__chipId,
					kind: node.__chipKind,
					value: node.__chipValue,
					label: node.__chipLabel,
				};
				if (data.kind === "quote") quotes.push(data);
				else mentions.push(data);
				return; // chip 文本不进正文
			}
			if ($isTextNode(node)) {
				text += node.getTextContent();
				return;
			}
			if ("getChildren" in node && typeof node.getChildren === "function") {
				for (const child of (node as { getChildren(): readonly LexicalNode[] }).getChildren()) walk(child);
			}
		};

		for (const child of root.getChildren()) {
			walk(child);
			if ($isParagraphNode(child)) text += "\n";
		}
		return { text: text.replace(/\n$/, ""), quotes, mentions };
	});
}

/**
 * 用草稿数据重建编辑器内容（外部 action 修改 draft 时同步）。
 * 在 editor.update() 内调用。
 */
export function rebuildEditorFromDraft(draft: EditorDraft): void {
	const root = $getRoot();
	root.clear();
	const paragraph = $createParagraphNode();
	const chips: readonly ChipData[] = [...draft.quotes, ...draft.mentions];
	if (chips.length === 0 && draft.text.length === 0) {
		root.append(paragraph);
		paragraph.selectEnd();
		return;
	}
	// 简化：chip 追加在正文之后（外部同步路径，如划词引用/示例，通常 chip 在末尾）。
	if (draft.text.length > 0) paragraph.append($createTextNode(draft.text));
	for (const chip of chips) {
		paragraph.append($createChipNode(chip.id, chip.kind, chip.value, chip.label));
	}
	root.append(paragraph);
	// 全量重建会丢掉原 selection，必须显式把光标放回末尾（最后一个 chip 之后），
	// 否则划词引用加进来后光标停在开头，与 @/$ 补全插入 chip 的行为不一致。
	paragraph.selectEnd();
}
