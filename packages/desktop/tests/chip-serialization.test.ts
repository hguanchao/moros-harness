import { describe, expect, it } from "vitest";
import { createEditor, $getSelection, $isRangeSelection } from "lexical";

import { ChipNode, $createChipNode, $isChipNode } from "../src/components/editor/ChipNode.tsx";
import {
	rebuildEditorFromDraft,
	serializeEditor,
	type EditorDraft,
} from "../src/components/editor/chip-serialization.ts";

/** 在 editor.update 内构建测试内容。 */
function setup(draft: EditorDraft): ReturnType<typeof createEditor> {
	const editor = createEditor({ nodes: [ChipNode] });
	editor.update(
		() => {
			rebuildEditorFromDraft(draft);
		},
		{ discrete: true },
	);
	return editor;
}

const sample: EditorDraft = {
	text: "帮我分析这两个文件",
	quotes: [{ id: "q1", kind: "quote", value: "原文内容", label: "引用：原文内容" }],
	mentions: [
		{ id: "m1", kind: "file", value: "src/a.ts", label: "@a.ts" },
		{ id: "s1", kind: "skill", value: "deploy", label: "$deploy" },
	],
	commands: [{ id: "c1", kind: "command", value: "compact", label: "/compact" }],
};

describe("serializeEditor / rebuildEditorFromDraft 往返", () => {
	it("重建后序列化得到相同正文与 chip", () => {
		const editor = setup(sample);
		const result = serializeEditor(editor.getEditorState());
		expect(result.text).toBe(sample.text);
		expect(result.quotes).toEqual(sample.quotes);
		expect(result.mentions).toEqual(sample.mentions);
		expect(result.commands).toEqual(sample.commands);
	});

	it("正文不含 chip 显示文字", () => {
		const editor = setup(sample);
		const result = serializeEditor(editor.getEditorState());
		expect(result.text).not.toContain("引用：原文内容");
		expect(result.text).not.toContain("@a.ts");
		expect(result.text).not.toContain("$deploy");
		expect(result.text).not.toContain("/compact");
	});

	it("空草稿不产生 chip", () => {
		const editor = setup({ text: "", quotes: [], mentions: [], commands: [] });
		const result = serializeEditor(editor.getEditorState());
		expect(result.text).toBe("");
		expect(result.quotes).toEqual([]);
		expect(result.mentions).toEqual([]);
		expect(result.commands).toEqual([]);
	});

	it("重建后光标落在末尾（最后一个 chip 之后），不是开头", () => {
		const editor = setup(sample);
		editor.getEditorState().read(() => {
			const selection = $getSelection();
			expect($isRangeSelection(selection)).toBe(true);
			if ($isRangeSelection(selection)) {
				const anchorNode = selection.anchor.getNode();
				// 末尾是 paragraph element，offset 指向子节点数（最后一个 chip 之后）。
				expect(anchorNode.getType()).toBe("paragraph");
				expect("getChildrenSize" in anchorNode).toBe(true);
				if ("getChildrenSize" in anchorNode) {
					expect(selection.anchor.offset).toBe(anchorNode.getChildrenSize());
				}
			}
		});
	});

	it("chip 是原子节点（$isChipNode 可判定）", () => {
		const editor = setup({
			text: "",
			quotes: [],
			mentions: [{ id: "x", kind: "file", value: "a.txt", label: "@a.txt" }],
			commands: [],
		});
		let found = false;
		editor.getEditorState().read(() => {
			const paragraph = $getRootForTest().getFirstChild();
			found =
				paragraph !== null &&
				"getChildren" in paragraph &&
				(paragraph as { getChildren(): readonly unknown[] }).getChildren().some((child) => $isChipNode(child as never));
		});
		expect(found).toBe(true);
	});
});

// 测试辅助：从 lexical 主入口取 $getRoot
import { $getRoot as $getRootForTest } from "lexical";
