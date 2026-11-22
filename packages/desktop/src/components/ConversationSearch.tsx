import { useEffect, useMemo, useRef, useState, type JSX } from "react";

import type { EventRecord } from "@moros/core/events/schema.ts";
import { SearchIcon, XIcon } from "./Icons.tsx";

/** 一条搜索结果；turnKey 对应 Transcript 中 .turn 的 id（turn-<user.input seq>）。 */
export interface ConversationSearchHit {
	readonly seq: number;
	readonly kind: string;
	readonly snippet: string;
	readonly turnKey: string;
	/** 匹配片段在 snippet 中的起止位置，用于高亮。 */
	readonly matchStart: number;
	readonly matchEnd: number;
}

/** 取事件里可搜索的文本与类型标签；无文本的事件返回 undefined。 */
function searchable(event: EventRecord): { text: string; kind: string } | undefined {
	switch (event.type) {
		case "user.input":
			return { text: event.payload.text, kind: "用户" };
		case "llm.response":
			return {
				text: `${event.payload.text}\n${event.payload.reasoning ?? ""}`.trim(),
				kind: "助手",
			};
		case "tool.call":
			return { text: `${event.payload.tool} ${safeString(event.payload.args)}`, kind: "工具" };
		case "tool.result":
			return { text: `${event.payload.tool} ${event.payload.result}`, kind: "工具结果" };
		case "error":
			return { text: `${event.payload.kind} ${event.payload.message}`, kind: "错误" };
		case "file.changed":
			return { text: `${event.payload.op} ${event.payload.path}`, kind: "文件" };
		case "model.changed":
			return { text: `模型 ${event.payload.from} → ${event.payload.to}`, kind: "模型" };
		case "limit.blocked":
			return {
				text: event.payload.message ?? event.payload.command ?? event.payload.kind ?? "请求被拦截",
				kind: "拦截",
			};
		default:
			return undefined;
	}
}

function safeString(value: unknown): string {
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value) ?? "";
	} catch {
		return "";
	}
}

/**
 * 在当前会话事件里搜索子串（大小写不敏感）。
 * @returns 命中列表，按事件顺序；turnKey 为往前最近一条 user.input 的 seq 对应的 turn id。
 */
export function searchEvents(events: readonly EventRecord[], query: string): readonly ConversationSearchHit[] {
	const needle = query.trim().toLowerCase();
	if (needle.length === 0) return [];
	const hits: ConversationSearchHit[] = [];
	let lastUserSeq = 0;
	for (const event of events) {
		if (event.type === "user.input") lastUserSeq = event.seq;
		const entry = searchable(event);
		if (entry === undefined) continue;
		const index = entry.text.toLowerCase().indexOf(needle);
		if (index === -1) continue;
		const snippetStart = Math.max(0, index - 30);
		const snippetEnd = Math.min(entry.text.length, index + needle.length + 60);
		hits.push({
			seq: event.seq,
			kind: entry.kind,
			snippet: entry.text.slice(snippetStart, snippetEnd).replaceAll("\n", " ").trim(),
			turnKey: `turn-${lastUserSeq}`,
			matchStart: index - snippetStart,
			matchEnd: index - snippetStart + needle.length,
		});
	}
	return hits;
}

/** 高亮 snippet 中匹配的片段。 */
function Highlight({
	text,
	start,
	end,
}: {
	readonly text: string;
	readonly start: number;
	readonly end: number;
}): JSX.Element {
	if (start < 0 || end > text.length || start >= end) return <>{text}</>;
	return (
		<>
			{text.slice(0, start)}
			<mark>{text.slice(start, end)}</mark>
			{text.slice(end)}
		</>
	);
}

/** 对话内搜索弹层：输入即过滤，点击结果跳转到对应回合。 */
export function ConversationSearch({
	events,
	query,
	onQueryChange,
	onJump,
	onClose,
}: {
	readonly events: readonly EventRecord[];
	readonly query: string;
	readonly onQueryChange: (value: string) => void;
	readonly onJump: (turnKey: string) => void;
	readonly onClose: () => void;
}): JSX.Element {
	const inputRef = useRef<HTMLInputElement>(null);
	useEffect(() => inputRef.current?.focus(), []);
	const hits = useMemo(() => searchEvents(events, query), [events, query]);

	return (
		<div className="conversation-search">
			<div className="search-box conv-search-box">
				<SearchIcon size={14} />
				<input
					ref={inputRef}
					value={query}
					placeholder="搜索本会话对话内容"
					onChange={(event) => onQueryChange(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === "Escape") onClose();
						if (event.key === "Enter" && hits.length > 0) onJump(hits[0]!.turnKey);
					}}
				/>
				<button className="icon-button" aria-label="关闭搜索" data-tooltip="关闭搜索" onClick={onClose}>
					<XIcon size={13} />
				</button>
			</div>
			{query.trim().length === 0 ? (
				<div className="conv-search-hint">输入关键词搜索本会话的对话内容</div>
			) : hits.length === 0 ? (
				<div className="conv-search-hint">无匹配</div>
			) : (
				<div className="conv-search-results">
					{hits.map((hit) => (
						<button className="conv-search-row" key={hit.seq} onClick={() => onJump(hit.turnKey)}>
							<span className="conv-search-kind">{hit.kind}</span>
							<span className="conv-search-snippet">
								<Highlight text={hit.snippet} start={hit.matchStart} end={hit.matchEnd} />
							</span>
						</button>
					))}
				</div>
			)}
		</div>
	);
}
