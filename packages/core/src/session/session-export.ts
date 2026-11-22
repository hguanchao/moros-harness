import type { EventRecord } from "../events/schema.ts";
import type { SessionMeta } from "./session-manager.ts";

/** 会话导出支持的三种格式；由目标文件扩展名决定。 */
export type SessionExportFormat = "json" | "markdown" | "html";

/** 一次导出的结果；路径为经沙箱校验后的绝对路径。 */
export interface SessionExportResult {
	readonly path: string;
	readonly format: SessionExportFormat;
	readonly bytes: number;
	/** 目标文件原本不存在。 */
	readonly created: boolean;
}

/** 导出渲染中单条文本的上限；完整内容仍在事件流中，导出只做展示裁剪。 */
const MAX_TEXT_CHARS = 8_000;

/**
 * 把会话事件流渲染成指定格式的导出内容。
 * @param meta 会话元数据，用于文件头。
 * @param events 按 seq 升序的完整事件记录。
 * @param format 目标格式。
 * @returns 可直接写入文件的 UTF-8 文本。
 */
export function renderSessionExport(
	meta: SessionMeta,
	events: readonly EventRecord[],
	format: SessionExportFormat,
): string {
	if (format === "json") return renderJson(meta, events);
	if (format === "html") return renderHtml(meta, events);
	return renderMarkdown(meta, events);
}

/** JSON 结构化快照：带显式 schema 版本，events 为可回放的完整事件数组。 */
function renderJson(meta: SessionMeta, events: readonly EventRecord[]): string {
	const snapshot = {
		schema: "moros.session-export",
		version: 1,
		exportedAt: new Date().toISOString(),
		session: {
			id: meta.id,
			title: meta.title,
			projectRoot: meta.projectRoot,
			mode: meta.mode,
			createdAt: meta.createdAt,
		},
		eventCount: events.length,
		lastSeq: events.at(-1)?.seq ?? 0,
		replayable: true,
		events,
	};
	return `${JSON.stringify(snapshot, null, 2)}\n`;
}

/** Markdown 人读记录：按事件顺序渲染，工具结果与参数用代码块承载。 */
function renderMarkdown(meta: SessionMeta, events: readonly EventRecord[]): string {
	const lines = [...headerLines(meta, events.length, events.at(-1)?.seq ?? 0)];
	if (events.length === 0) lines.push("_No events yet._");
	for (const event of events) {
		const text = eventText(event);
		if (text.length === 0) continue;
		lines.push(`## ${eventLabel(event)}`, "", text, "");
	}
	return `${lines.join("\n").trimEnd()}\n`;
}

/** 自包含 HTML：内联样式与转义，无外部资源，可离线打开。 */
function renderHtml(meta: SessionMeta, events: readonly EventRecord[]): string {
	const cards = events
		.map((event) => {
			const text = eventText(event);
			if (text.length === 0) return "";
			return [
				`<section class="event ${escapeHtml(event.type)}">`,
				`<div class="meta">#${event.seq} · ${escapeHtml(event.type)} · ${escapeHtml(event.ts)}</div>`,
				`<h2>${escapeHtml(eventLabel(event))}</h2>`,
				`<pre>${escapeHtml(text)}</pre>`,
				"</section>",
			].join("\n");
		})
		.join("\n");
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Moros Harness session ${escapeHtml(meta.id)}</title>
<style>
:root { color-scheme: light dark; }
body { margin: 0 auto; padding: 2rem; max-width: 60rem; font: 15px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
header { border-bottom: 1px solid #8886; padding-bottom: 1rem; margin-bottom: 1.5rem; }
h1 { font-size: 1.3rem; margin: 0 0 .5rem; }
dl { display: grid; grid-template-columns: max-content 1fr; gap: .25rem 1rem; margin: 0; }
dt { opacity: .7; }
dd { margin: 0; word-break: break-all; }
.event { border: 1px solid #8885; border-radius: .5rem; padding: .75rem 1rem; margin: 0 0 1rem; }
.event .meta { font-size: .8rem; opacity: .65; }
.event h2 { font-size: 1rem; margin: .25rem 0 .5rem; }
pre { margin: 0; white-space: pre-wrap; word-break: break-word; font: 13px/1.5 ui-monospace, Consolas, monospace; }
.event.error pre, .event.limit\\.blocked pre { color: #c55; }
footer { margin-top: 2rem; font-size: .85rem; opacity: .65; }
</style>
</head>
<body>
<header>
<h1>Moros Harness session ${escapeHtml(meta.id)}</h1>
<dl>
<dt>Title</dt><dd>${escapeHtml(meta.title)}</dd>
<dt>Project</dt><dd>${escapeHtml(meta.projectRoot)}</dd>
<dt>Mode</dt><dd>${escapeHtml(meta.mode)}</dd>
<dt>Exported</dt><dd>${escapeHtml(new Date().toISOString())}</dd>
<dt>Events</dt><dd>${events.length} (last seq ${events.at(-1)?.seq ?? 0})</dd>
</dl>
</header>
<main>
${cards || "<p>No events yet.</p>"}
</main>
<footer>Exported from append-only stream.jsonl; replayable with Core.replay().</footer>
</body>
</html>
`;
}

function headerLines(meta: SessionMeta, count: number, lastSeq: number): string[] {
	return [
		`# Moros Harness session ${meta.id}`,
		"",
		`- Title: ${meta.title}`,
		`- Project: \`${meta.projectRoot}\``,
		`- Mode: ${meta.mode}`,
		`- Exported: ${new Date().toISOString()}`,
		`- Events: ${count} (last seq ${lastSeq})`,
		"",
		"> Exported from append-only stream.jsonl; replayable with Core.replay().",
		"",
	];
}

/** 事件在导出文件里的标题；内部请求类事件不单独成节。 */
function eventLabel(event: EventRecord): string {
	switch (event.type) {
		case "user.input":
			return "User";
		case "llm.response":
			return "Assistant";
		case "tool.call":
			return `Tool call: ${event.payload.tool}`;
		case "tool.result":
			return `Tool result: ${event.payload.tool}${event.payload.isError ? " (error)" : ""}`;
		case "approval.requested":
			return `Approval requested: ${event.payload.tool}`;
		case "approval.granted":
			return `Approval granted: ${event.payload.tool}`;
		case "approval.denied":
			return `Approval denied: ${event.payload.tool}`;
		case "approval.reviewed":
			return `Review ${event.payload.decision}: ${event.payload.tool}`;
		case "file.changed":
			return `File change: ${event.payload.op} ${event.payload.path}`;
		case "rollback.done":
			return `Rollback: ${event.payload.scope}`;
		case "breakpoint.paused":
			return "Paused";
		case "breakpoint.resumed":
			return "Resumed";
		case "compaction.done":
			return "Context compacted";
		case "session.created":
			return "Session created";
		case "mode.switched":
			return "Mode switched";
		case "message.feedback":
			return "Message feedback";
		case "model.changed":
			return "Model changed";
		case "error":
			return `Error: ${event.payload.kind}`;
		case "limit.blocked":
			return "Request blocked";
		case "llm.request":
			return "";
		case "session.renamed":
			return "Session renamed";
		case "session.archived":
			return event.payload.archived ? "Session archived" : "Session unarchived";
		case "subagent.started":
			return "Subagent started";
		case "subagent.finished":
			return "Subagent finished";
	}
}

/** 事件的可读正文；结构化参数用 JSON，长文本裁剪并标注。 */
function eventText(event: EventRecord): string {
	switch (event.type) {
		case "llm.request":
			return "";
		case "user.input": {
			const images = event.payload.images?.length ?? 0;
			return event.payload.text || (images > 0 ? `${images} image(s) attached` : "(empty message)");
		}
		case "llm.response": {
			const calls = toolCallNames(event.payload.toolCalls);
			return [event.payload.text, calls.length > 0 ? `${calls.length} tool call(s): ${calls.join(", ")}` : ""]
				.filter(Boolean)
				.join("\n");
		}
		case "tool.call":
			return clip(JSON.stringify(event.payload.args, null, 2) ?? "{}");
		case "tool.result":
			return clip(event.payload.result);
		case "approval.requested":
			return `${event.payload.reason}\n${clip(JSON.stringify(event.payload.args, null, 2) ?? "{}")}`;
		case "approval.granted":
			return event.payload.sessionApproved ? "Allowed for this session" : "Allowed";
		case "approval.denied":
			return "Denied";
		case "approval.reviewed":
			return `${event.payload.decision}: ${event.payload.reason}${event.payload.model ? ` (${event.payload.model})` : ""}`;
		case "file.changed":
			return `${event.payload.op} ${event.payload.path}`;
		case "rollback.done":
			return event.payload.files.join("\n") || "No files changed.";
		case "breakpoint.paused":
		case "breakpoint.resumed":
			return event.payload.reason;
		case "compaction.done":
			return `events ${event.payload.fromSeq}–${event.payload.toSeq}; ${event.payload.summaryChars} chars`;
		case "session.created":
			return `${event.payload.title} (${event.payload.mode})`;
		case "mode.switched":
			return `${event.payload.from} → ${event.payload.to}`;
		case "message.feedback":
			return `seq ${event.payload.targetSeq}: ${event.payload.rating}`;
		case "model.changed":
			return `${event.payload.from} → ${event.payload.to}${event.payload.appliesNextTurn ? " (next turn)" : ""}`;
		case "session.renamed":
			return event.payload.title;
		case "session.archived":
			return event.payload.archived ? "archived" : "unarchived";
		case "subagent.started":
			return clip(event.payload.task);
		case "subagent.finished":
			return `${event.payload.ok ? "ok" : "failed"} · ${event.payload.steps} steps · ${event.payload.durationMs}ms\n${event.payload.preview}`;
		case "error":
			return event.payload.message;
		case "limit.blocked":
			return event.payload.message ?? event.payload.kind ?? event.payload.command ?? "Blocked by policy.";
	}
}

function toolCallNames(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const names: string[] = [];
	for (const item of value) {
		if (
			item &&
			typeof item === "object" &&
			!Array.isArray(item) &&
			typeof (item as Record<string, unknown>).name === "string"
		) {
			names.push((item as Record<string, unknown>).name as string);
		}
	}
	return names;
}

function clip(text: string): string {
	return text.length <= MAX_TEXT_CHARS ? text : `${text.slice(0, MAX_TEXT_CHARS)}\n… (truncated for export)`;
}

function escapeHtml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}
