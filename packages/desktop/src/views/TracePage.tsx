import { useEffect, useState, type JSX } from "react";

import type { TraceStep, TraceTurn } from "../shared/contract.ts";
import { call, errorMessage } from "../api/api.ts";
import { firstLine, formatDuration, relativeTime } from "../utils/format.ts";
import { ListTreeIcon, RefreshIcon } from "../components/Icons.tsx";
import { PageHeader } from "../components/PageHeader.tsx";
import { useApp } from "../store/state.tsx";

interface Selection {
	readonly turn: TraceTurn;
	readonly step: TraceStep;
}

export function TracePage(): JSX.Element {
	const { state } = useApp();
	const current = state.current;
	const [turns, setTurns] = useState<readonly TraceTurn[]>([]);
	const [selection, setSelection] = useState<Selection | undefined>(undefined);
	const [error, setError] = useState<string | undefined>(undefined);
	const [version, setVersion] = useState(0);
	const eventCount = current === undefined ? 0 : (state.events[current.meta.id]?.length ?? 0);

	useEffect(() => {
		if (current === undefined) {
			setTurns([]);
			return;
		}
		let cancelled = false;
		void (async () => {
			try {
				const result = await call(window.moros.traceGet(current.meta.id));
				if (cancelled) return;
				setTurns(result);
				setSelection((existing) => {
					if (existing !== undefined) {
						const turn = result.find((entry) => entry.id === existing.turn.id);
						const step = turn?.steps.find((entry) => entry.id === existing.step.id);
						if (turn !== undefined && step !== undefined) return { turn, step };
					}
					for (const turn of result) {
						const step = turn.steps[0];
						if (step !== undefined) return { turn, step };
					}
					return undefined;
				});
				setError(undefined);
			} catch (loadError) {
				if (!cancelled) setError(errorMessage(loadError));
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [current?.meta.id, eventCount, version]);

	if (current === undefined) {
		return (
			<div className="page-empty">
				<ListTreeIcon size={22} />
				<p>先打开一个会话</p>
			</div>
		);
	}

	return (
		<div className="trace-page">
			<PageHeader
				title="执行轨迹"
				subtitle="按回合展开模型请求、工具调用、审批与文件变更；事件流是唯一事实源。"
				actions={
					<>
						<span className="trace-stats">
							{turns.length} 回合 · {turns.reduce((sum, turn) => sum + turn.steps.length, 0)} 步
						</span>
						<button
							className="icon-button"
							data-tooltip="刷新"
							aria-label="刷新"
							onClick={() => setVersion((value) => value + 1)}
						>
							<RefreshIcon size={16} />
						</button>
					</>
				}
			/>
			{error !== undefined ? <div className="inline-notice notice-error">{error}</div> : null}
			<div className="trace-body">
				<div className="trace-list">
					{turns.length === 0 ? <div className="side-empty">当前会话还没有可展示的轨迹</div> : null}
					{turns.map((turn) => (
						<div className="trace-turn" key={turn.id}>
							<div className="trace-turn-head">
								<span className="turn-index">Turn {turn.index}</span>
								<span className="turn-prompt">{firstLine(turn.prompt || "(无输入)", 90)}</span>
								<small>{relativeTime(turn.startedAt)}</small>
							</div>
							<div className="trace-steps">
								{turn.steps.map((step) => (
									<button
										key={step.id}
										className={`trace-step lane-${laneOf(step.kind)} ${
											selection?.step.id === step.id && selection.turn.id === turn.id ? "is-selected" : ""
										}`}
										onClick={() => setSelection({ turn, step })}
									>
										<span className={`trace-dot status-${step.status}`} />
										<span className="trace-tag">{tagOf(step.kind)}</span>
										<span className="trace-title">{step.title}</span>
										{step.durationMs !== undefined ? <small>{formatDuration(step.durationMs)}</small> : null}
									</button>
								))}
							</div>
						</div>
					))}
				</div>
				<div className="trace-detail">
					{selection === undefined ? (
						<div className="page-empty">
							<ListTreeIcon size={20} />
							<p>选择一步查看详情</p>
						</div>
					) : (
						<>
							<div className="trace-detail-head">
								<span className={`trace-tag lane-${laneOf(selection.step.kind)}`}>{tagOf(selection.step.kind)}</span>
								<h3>{selection.step.title}</h3>
								<span className={`status-pill status-${selection.step.status}`}>{selection.step.status}</span>
							</div>
							<div className="trace-meta">
								<span>Turn {selection.turn.index}</span>
								{selection.step.tool !== undefined ? <span>{selection.step.tool}</span> : null}
								{selection.step.risk !== undefined ? <span>risk {selection.step.risk}</span> : null}
								{selection.step.ts !== undefined ? (
									<span>{new Date(selection.step.ts).toLocaleString("zh-CN")}</span>
								) : null}
								{selection.step.durationMs !== undefined ? (
									<span>{formatDuration(selection.step.durationMs)}</span>
								) : null}
							</div>
							{selection.step.args !== undefined ? (
								<div className="detail-block">
									<div className="detail-label">输入</div>
									<pre>{selection.step.args}</pre>
								</div>
							) : null}
							{selection.step.result !== undefined ? (
								<div className="detail-block">
									<div className="detail-label">输出</div>
									<pre className={selection.step.status === "error" ? "is-error" : ""}>{selection.step.result}</pre>
								</div>
							) : null}
						</>
					)}
				</div>
			</div>
		</div>
	);
}

function tagOf(kind: TraceStep["kind"]): string {
	switch (kind) {
		case "llm":
			return "MODEL";
		case "tool":
			return "TOOL";
		case "approval":
			return "APPROVAL";
		case "subagent":
			return "TASK";
		case "file":
			return "FILE";
		case "compaction":
			return "CONTEXT";
		case "error":
			return "ERROR";
		case "system":
			return "SYSTEM";
	}
}

function laneOf(kind: TraceStep["kind"]): "input" | "model" | "tools" | "system" {
	if (kind === "llm") return "model";
	if (kind === "tool" || kind === "subagent" || kind === "approval") return "tools";
	if (kind === "file" || kind === "compaction") return "input";
	return "system";
}
