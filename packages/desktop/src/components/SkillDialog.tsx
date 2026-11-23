import { useEffect, useState, type JSX } from "react";

import type { SkillDocumentResult, SkillDraftInput } from "../shared/contract.ts";
import { errorMessage } from "../api/api.ts";
import { XIcon } from "./Icons.tsx";

/**
 * 添加/编辑用户技能的对话框。名称新建时可填、编辑时禁用（路径即身份）。
 * 只能写 ~/.moros/skills 下的用户技能，由后端做目录约束。
 */
export function SkillDialog({
	open,
	detail,
	onClose,
	onSave,
}: {
	readonly open: boolean;
	/** 编辑目标；缺省为新增。 */
	readonly detail: SkillDocumentResult | undefined;
	onClose(): void;
	onSave(draft: SkillDraftInput): Promise<void>;
}): JSX.Element | null {
	const editing = detail !== undefined;
	const [name, setName] = useState("");
	const [description, setDescription] = useState("");
	const [body, setBody] = useState("");
	const [error, setError] = useState<string | undefined>(undefined);
	const [saving, setSaving] = useState(false);

	useEffect(() => {
		if (!open) return;
		setName(detail?.name ?? "");
		setDescription(detail?.description ?? "");
		setBody(detail?.body ?? "");
		setError(undefined);
		setSaving(false);
	}, [open, detail]);

	if (!open) return null;

	const submit = async (): Promise<void> => {
		if (saving) return;
		if (name.trim().length === 0) {
			setError("请填写技能名（小写字母、数字、连字符）");
			return;
		}
		if (body.trim().length === 0) {
			setError("指令正文不能为空");
			return;
		}
		setSaving(true);
		setError(undefined);
		try {
			await onSave({ name: name.trim(), description: description.trim(), body });
			onClose();
		} catch (cause) {
			setError(errorMessage(cause));
		} finally {
			setSaving(false);
		}
	};

	return (
		<div className="modal-backdrop" onClick={onClose}>
			<div
				className="modal discover-modal"
				role="dialog"
				aria-label={editing ? "编辑技能" : "添加技能"}
				onClick={(event) => event.stopPropagation()}
			>
				<div className="modal-head">
					<h2>{editing ? "编辑技能" : "添加技能"}</h2>
					<button className="icon-button" aria-label="关闭" onClick={onClose}>
						<XIcon size={16} />
					</button>
				</div>
				<div className="mcp-dialog-body">
					<label className="mcp-field">
						<span className="detail-label">技能名（kebab-case）</span>
						<input
							className="form-input"
							value={name}
							disabled={editing}
							onChange={(event) => setName(event.target.value)}
							placeholder="deploy-docs"
							aria-label="技能名"
						/>
						{editing ? <span className="form-hint">编辑时技能名不可改</span> : null}
					</label>
					<label className="mcp-field">
						<span className="detail-label">一句话描述</span>
						<input
							className="form-input"
							value={description}
							onChange={(event) => setDescription(event.target.value)}
							placeholder="这个技能在什么场景下使用"
							aria-label="技能描述"
						/>
					</label>
					<label className="mcp-field">
						<span className="detail-label">指令正文（Markdown）</span>
						<textarea
							className="form-area"
							value={body}
							onChange={(event) => setBody(event.target.value)}
							rows={12}
							aria-label="指令正文"
						/>
					</label>
					{error === undefined ? null : <div className="inline-notice notice-error">{error}</div>}
				</div>
				<div className="modal-actions">
					<button className="ghost-button" onClick={onClose}>
						取消
					</button>
					<button className="primary-button" disabled={saving} onClick={() => void submit()}>
						{saving ? "保存中…" : editing ? "保存" : "添加"}
					</button>
				</div>
			</div>
		</div>
	);
}
