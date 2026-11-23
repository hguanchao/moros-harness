import { useEffect, useState, type JSX } from "react";

import type { SkillDraftInput } from "../shared/contract.ts";
import { errorMessage } from "../api/api.ts";
import { XIcon } from "./Icons.tsx";

/** 新增用户技能的对话框；技能只能加到 ~/.moros/skills，后端做目录约束。 */
export function SkillDialog({
	open,
	onClose,
	onSave,
}: {
	readonly open: boolean;
	onClose(): void;
	onSave(draft: SkillDraftInput): Promise<void>;
}): JSX.Element | null {
	const [name, setName] = useState("");
	const [description, setDescription] = useState("");
	const [body, setBody] = useState("");
	const [error, setError] = useState<string | undefined>(undefined);
	const [saving, setSaving] = useState(false);

	useEffect(() => {
		if (!open) return;
		setName("");
		setDescription("");
		setBody("");
		setError(undefined);
		setSaving(false);
	}, [open]);

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
				aria-label="添加技能"
				onClick={(event) => event.stopPropagation()}
			>
				<div className="modal-head">
					<h2>添加技能</h2>
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
							onChange={(event) => setName(event.target.value)}
							placeholder="deploy-docs"
							aria-label="技能名"
						/>
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
						{saving ? "添加中…" : "添加"}
					</button>
				</div>
			</div>
		</div>
	);
}
