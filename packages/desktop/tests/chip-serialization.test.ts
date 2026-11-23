import { describe, expect, it } from "vitest";
import { createEditor } from "lexical";

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
};

describe("serializeEditor / rebuildEditorFromDraft 往返", () => {
	it("重建后序列化得到相同正文与 chip", () => {
		const editor = setup(sample);
		const result = serializeEditor(editor.getEditorState());
		expect(result.text).toBe(sample.text);
		expect(result.quotes).toEqual(sample.quotes);
		expect(result.mentions).toEqual(sample.mentions);
	});

	it("正文不含 chip 显示文字", () => {
		const editor = setup(sample);
		const result = serializeEditor(editor.getEditorState());
		expect(result.text).not.toContain("引用：原文内容");
		expect(result.text).not.toContain("@a.ts");
		expect(result.text).not.toContain("$deploy");
	});

	it("空草稿不产生 chip", () => {
		const editor = setup({ text: "", quotes: [], mentions: [] });
		const result = serializeEditor(editor.getEditorState());
		expect(result.text).toBe("");
		expect(result.quotes).toEqual([]);
		expect(result.mentions).toEqual([]);
	});

	it("chip 是原子节点（$isChipNode 可判定）", () => {
		const editor = setup({
			text: "",
			quotes: [],
			mentions: [{ id: "x", kind: "file", value: "a.txt", label: "@a.txt" }],
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
