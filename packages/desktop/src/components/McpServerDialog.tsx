import { useEffect, useState, type JSX } from "react";

import type { McpServerDetail, McpServerDraftInput } from "../shared/contract.ts";
import { errorMessage } from "../api/api.ts";
import { formatKeyValueLines, parseArgumentLines, parseKeyValueLines } from "../utils/mcp-form.ts";
import { XIcon } from "./Icons.tsx";

type Transport = "stdio" | "http" | "sse";

/**
 * 添加/编辑 MCP server 的对话框。
 * 只采集表单暴露的字段；timeout/disabled 等高级项由 core writer 编辑时原位保留。
 */
export function McpServerDialog({
	open,
	detail,
	onClose,
	onSave,
}: {
	readonly open: boolean;
	/** 编辑目标；缺省为新增。 */
	readonly detail: McpServerDetail | undefined;
	onClose(): void;
	onSave(name: string, draft: McpServerDraftInput): Promise<void>;
}): JSX.Element | null {
	const editing = detail !== undefined;
	const [name, setName] = useState("");
	const [transport, setTransport] = useState<Transport>("stdio");
	const [command, setCommand] = useState("");
	const [args, setArgs] = useState("");
	const [env, setEnv] = useState("");
	const [url, setUrl] = useState("");
	const [headers, setHeaders] = useState("");
	const [error, setError] = useState<string | undefined>(undefined);
	const [saving, setSaving] = useState(false);

	useEffect(() => {
		if (!open) return;
		setName(detail?.name ?? "");
		setTransport(detail?.type ?? "stdio");
		setCommand(detail?.type === "stdio" ? detail.command : "");
		setArgs(detail?.type === "stdio" ? (detail.args ?? []).join("\n") : "");
		setEnv(detail?.type === "stdio" ? formatKeyValueLines(detail.env) : "");
		setUrl(detail !== undefined && detail.type !== "stdio" ? detail.url : "");
		setHeaders(detail !== undefined && detail.type !== "stdio" ? formatKeyValueLines(detail.headers) : "");
		setError(undefined);
		setSaving(false);
	}, [open, detail]);

	if (!open) return null;

	const submit = async (): Promise<void> => {
		if (saving) return;
		const trimmedName = name.trim();
		if (trimmedName.length === 0) {
			setError("请填写名称");
			return;
		}
		let draft: McpServerDraftInput;
		if (transport === "stdio") {
			if (command.trim().length === 0) {
				setError("stdio 需要填写启动命令");
				return;
			}
			const parsed = parseKeyValueLines(env);
			if (!parsed.ok) {
				setError(`环境变量：${parsed.error}`);
				return;
			}
			draft = { type: "stdio", command: command.trim(), args: parseArgumentLines(args), env: parsed.value };
		} else {
			if (url.trim().length === 0) {
				setError("http / sse 需要填写地址");
				return;
			}
			const parsed = parseKeyValueLines(headers);
			if (!parsed.ok) {
				setError(`请求头：${parsed.error}`);
				return;
			}
			draft = { type: transport, url: url.trim(), headers: parsed.value };
		}
		setSaving(true);
		setError(undefined);
		try {
			await onSave(trimmedName, draft);
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
				aria-label={editing ? "编辑 MCP 服务器" : "添加 MCP 服务器"}
				onClick={(event) => event.stopPropagation()}
			>
				<div className="modal-head">
					<h2>{editing ? "编辑 MCP 服务器" : "添加 MCP 服务器"}</h2>
					<button className="icon-button" aria-label="关闭" onClick={onClose}>
						<XIcon size={16} />
					</button>
				</div>
				<div className="mcp-dialog-body">
					<label className="mcp-field">
						<span className="detail-label">名称</span>
						<input
							className="form-input"
							value={name}
							disabled={editing}
							onChange={(event) => setName(event.target.value)}
							placeholder="docs"
							aria-label="服务器名称"
						/>
						{editing ? <span className="form-hint">编辑时名称不可改</span> : null}
					</label>

					<div className="mcp-field">
						<span className="detail-label">传输方式</span>
						<div className="mcp-transport-switch" role="group" aria-label="传输方式">
							{(["stdio", "http", "sse"] as const).map((item) => (
								<button
									key={item}
									type="button"
									className={`settings-tab ${transport === item ? "is-active" : ""}`}
									aria-pressed={transport === item}
									onClick={() => setTransport(item)}
								>
									{item}
								</button>
							))}
						</div>
					</div>

					{transport === "stdio" ? (
						<>
							<label className="mcp-field">
								<span className="detail-label">启动命令</span>
								<input
									className="form-input"
									value={command}
									onChange={(event) => setCommand(event.target.value)}
									placeholder="npx"
									aria-label="启动命令"
								/>
							</label>
							<label className="mcp-field">
								<span className="detail-label">参数（每行一个）</span>
								<textarea
									className="form-area"
									value={args}
									onChange={(event) => setArgs(event.target.value)}
									rows={3}
									aria-label="启动参数"
								/>
							</label>
							<label className="mcp-field">
								<span className="detail-label">环境变量（KEY=VALUE，每行一个）</span>
								<textarea
									className="form-area"
									value={env}
									onChange={(event) => setEnv(event.target.value)}
									rows={3}
									aria-label="环境变量"
								/>
							</label>
						</>
					) : (
						<>
							<label className="mcp-field">
								<span className="detail-label">地址</span>
								<input
									className="form-input"
									value={url}
									onChange={(event) => setUrl(event.target.value)}
									placeholder="https://example.com/mcp"
									aria-label="服务器地址"
								/>
							</label>
							<label className="mcp-field">
								<span className="detail-label">请求头（KEY=VALUE，每行一个）</span>
								<textarea
									className="form-area"
									value={headers}
									onChange={(event) => setHeaders(event.target.value)}
									rows={3}
									aria-label="请求头"
								/>
							</label>
						</>
					)}

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
