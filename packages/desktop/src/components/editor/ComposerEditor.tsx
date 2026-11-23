import {
	forwardRef,
	useCallback,
	useEffect,
	useImperativeHandle,
	useRef,
	type JSX,
	type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import {
	$createParagraphNode,
	$getRoot,
	$getSelection,
	$isParagraphNode,
	$isRangeSelection,
	type EditorState,
	type LexicalNode,
} from "lexical";
import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { RichTextPlugin } from "@lexical/react/LexicalRichTextPlugin";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { OnChangePlugin } from "@lexical/react/LexicalOnChangePlugin";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { $isTextNode } from "lexical";

import { ChipNode, $createChipNode, type ChipData } from "./ChipNode.tsx";
import { rebuildEditorFromDraft, serializeEditor, type EditorDraft } from "./chip-serialization.ts";

/** 暴露给 Composer 的命令式 API。 */
export interface ComposerEditorHandle {
	/** 在光标处插入 chip。 */
	insertChip: (chip: ChipData) => void;
	/** 删除触发 token（补全选中时清理 /com、@xx、$xx 文本）。 */
	deleteTriggerToken: (length: number) => void;
	/** 当前纯正文（不含 chip 显示文字）。 */
	getText: () => string;
	focus: () => void;
}

export interface ComposerEditorProps {
	readonly draft: EditorDraft;
	/** 本地/外部变化后回写草稿。 */
	readonly onChange: (draft: EditorDraft) => void;
	readonly disabled?: boolean;
	readonly placeholder?: string;
	/** 编辑器键盘事件（外层处理补全拦截、Enter 发送等）。 */
	readonly onKeyDown?: (event: ReactKeyboardEvent<HTMLElement>) => void;
	/** 编辑器获得焦点、光标位置变化时回调（供外层 trigger 补全定位）。 */
	readonly onSelectionChange?: (text: string, cursor: number, rect: DOMRect | undefined) => void;
}

/** 桥接组件：拿 editor 实例、注册命令式 API、处理外部 draft 同步。 */
function EditorBridge({
	draft,
	onChange,
	handleRef,
	disabled,
	onSelectionChange,
}: {
	readonly draft: EditorDraft;
	readonly onChange: (draft: EditorDraft) => void;
	readonly handleRef: { current: ComposerEditorHandle | null };
	readonly disabled?: boolean | undefined;
	readonly onSelectionChange?: ComposerEditorProps["onSelectionChange"];
}): JSX.Element {
	const [editor] = useLexicalComposerContext();
	const applyingExternal = useRef(false);
	const lastSerialized = useRef<string>("");

	// initialConfig.editable 只在初始化生效；disabled 变化后必须显式同步，
	// 否则加载完成/信任确认后输入框仍然不可编辑（contenteditable 一直为 false）。
	useEffect(() => {
		editor.setEditable(!(disabled === true));
	}, [editor, disabled]);

	// 命令式 API
	useEffect(() => {
		handleRef.current = {
			insertChip: (chip) => {
				editor.update(() => {
					// 间距由 .editor-chip 的 CSS margin 负责，这里不插空格文本节点——
					// 空格会进正文、污染送给模型的文本。
					const node = $createChipNode(chip.id, chip.kind, chip.value, chip.label);
					const selection = $getSelection();
					if ($isRangeSelection(selection)) selection.insertNodes([node]);
					else {
						const p = $getRoot().getLastChild();
						if (p && "append" in p) (p as ReturnType<typeof $createParagraphNode>).append(node);
					}
				});
			},
			deleteTriggerToken: (length) => {
				editor.update(() => {
					const selection = $getSelection();
					if (!$isRangeSelection(selection) || length <= 0) return;
					const node = selection.anchor.getNode();
					if (!$isTextNode(node)) return;
					const content = node.getTextContent();
					const end = Math.min(selection.anchor.offset, content.length);
					const start = Math.max(0, end - length);
					node.setTextContent(content.slice(0, start) + content.slice(end));
					node.select(start, start);
				});
			},
			getText: () => serializeEditor(editor.getEditorState()).text,
			focus: () => editor.focus(),
		};
		return () => {
			handleRef.current = null;
		};
	}, [editor, handleRef]);

	// OnChange：本地编辑序列化回草稿；外部同步不回写，避免回环打断 IME。
	const handleChange = useCallback(
		(editorState: EditorState) => {
			if (applyingExternal.current) return;
			const next = serializeEditor(editorState);
			const signature = `${next.text}\u0000${next.quotes.map((q) => q.id).join(",")}\u0000${next.mentions.map((m) => m.id).join(",")}`;
			if (signature === lastSerialized.current) return;
			lastSerialized.current = signature;
			onChange(next);
			if (onSelectionChange !== undefined) {
				const text = next.text;
				// 光标必须用「整段正文的全局偏移」，不能用 anchor.offset（节点内偏移）：
				// chip 把正文切成多个 TextNode，节点内偏移会让多 chip 后的 @/$ token 定位错位。
				const cursor = editorState.read(() => {
					const sel = $getSelection();
					if (!$isRangeSelection(sel)) return text.length;
					const anchorNode = sel.anchor.getNode();
					let offset = 0;
					const visit = (node: LexicalNode): boolean => {
						if (node === anchorNode && $isTextNode(node)) {
							offset += sel.anchor.offset;
							return true;
						}
						if ($isTextNode(node)) {
							offset += node.getTextContentSize();
							return false;
						}
						if ("getChildren" in node && typeof node.getChildren === "function") {
							for (const child of (node as { getChildren(): readonly LexicalNode[] }).getChildren()) {
								if (visit(child)) return true;
							}
						}
						return false;
					};
					for (const child of $getRoot().getChildren()) {
						if (visit(child)) break;
						if ($isParagraphNode(child)) offset += 1; // 段落间的换行，与 serializeEditor 一致
					}
					return offset;
				});
				const domSelection = window.getSelection();
				const rect =
					domSelection !== null && domSelection.rangeCount > 0
						? domSelection.getRangeAt(0).getBoundingClientRect()
						: undefined;
				onSelectionChange(text, Math.min(cursor, text.length), rect);
			}
		},
		[editor, onChange, onSelectionChange],
	);

	// 外部 draft 变化（signature 不同）→ 重建编辑器内容。
	useEffect(() => {
		const signature = `${draft.text}\u0000${draft.quotes.map((q) => q.id).join(",")}\u0000${draft.mentions.map((m) => m.id).join(",")}`;
		if (signature === lastSerialized.current) return;
		applyingExternal.current = true;
		lastSerialized.current = signature;
		editor.update(() => rebuildEditorFromDraft(draft), { discrete: true });
		applyingExternal.current = false;
	}, [draft, editor]);

	return <OnChangePlugin onChange={handleChange} ignoreSelectionChange />;
}

/** 富文本输入区：文字与 chip 同排，光标由 Lexical 原生保证正确。 */
export const ComposerEditor = forwardRef<ComposerEditorHandle, ComposerEditorProps>(function ComposerEditor(
	{ draft, onChange, disabled, placeholder = "描述你的任务，/调用指令，@文件，$技能", onKeyDown, onSelectionChange },
	ref,
) {
	const handleRef = useRef<ComposerEditorHandle | null>(null);
	useImperativeHandle(
		ref,
		() => ({
			insertChip: (chip) => handleRef.current?.insertChip(chip),
			deleteTriggerToken: (length) => handleRef.current?.deleteTriggerToken(length),
			getText: () => handleRef.current?.getText() ?? "",
			focus: () => handleRef.current?.focus(),
		}),
		[],
	);

	const initialConfig = useRef({
		namespace: "moros-composer",
		nodes: [ChipNode],
		onError: (error: Error) => console.error("[moros-composer]", error),
		editable: !disabled,
	}).current;

	// 用捕获阶段：Lexical 在 contenteditable 上注册了原生 keydown，冒泡阶段的外层
	// onKeyDown 晚于它执行：Enter 会先被 Lexical 插入换行、清空补全态，导致外层误发送。
	return (
		<div className={`composer-editor ${disabled === true ? "is-disabled" : ""}`} onKeyDownCapture={onKeyDown}>
			<LexicalComposer initialConfig={initialConfig}>
				<RichTextPlugin
					contentEditable={<ContentEditable className="composer-input" aria-label="消息输入" />}
					placeholder={<div className="composer-placeholder">{placeholder}</div>}
					ErrorBoundary={LexicalErrorBoundary}
				/>
				<HistoryPlugin />
				<EditorBridge
					draft={draft}
					onChange={onChange}
					handleRef={handleRef}
					disabled={disabled}
					onSelectionChange={onSelectionChange}
				/>
			</LexicalComposer>
		</div>
	);
});
