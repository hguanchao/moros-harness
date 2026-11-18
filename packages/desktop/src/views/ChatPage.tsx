import { useEffect, useMemo, useRef, useState, type JSX } from "react";

import type { ApprovalCard } from "../shared/contract.ts";
import { call, errorMessage } from "../api/api.ts";
import { Composer } from "../components/Composer.tsx";
import { AlertIcon, CheckIcon, ChevronDownIcon, SparklesIcon, XIcon } from "../components/Icons.tsx";
import { Markdown } from "../components/Markdown.tsx";
import { useApp } from "../store/state.tsx";
import { buildTimeline, Transcript } from "../components/Transcript.tsx";

const IMPLEMENTATION_PREFIX = "Implement this plan:\n\n";
const IMPLEMENTATION_SUFFIX = "\n\nRe-read the files you need before changing them.";

export function ChatPage(): JSX.Element {
	const { state, dispatch } = useApp();
	const current = state.current;
	const project = state.project;
	const scrollRef = useRef<HTMLDivElement | null>(null);
	const stickToBottom = useRef(true);
	const [loadingOlder, setLoadingOlder] = useState(false);

	const events = current === undefined ? [] : (state.events[current.meta.id] ?? []);
	const live = current === undefined ? undefined : (state.live[current.meta.id] ?? current.live);
	const subagents = current === undefined ? {} : (state.subagents[current.meta.id] ?? {});
	const turns = useMemo(
		() => (live === undefined ? [] : buildTimeline(events, live, subagents)),
		[events, live, subagents],
	);
	const approvals = [...state.approvals].sort((left, right) => {
		const leftCurrent = current !== undefined && left.sessionId === current.meta.id ? 0 : 1;
		const rightCurrent = current !== undefined && right.sessionId === current.meta.id ? 0 : 1;
		return leftCurrent - rightCurrent;
	});
	const trustBlocked = project?.trust.required === true && project.trust.decision === null;
	const activePlan = turns
		.flatMap((turn) => turn.blocks)
		.filter((block): block is Extract<typeof block, { kind: "plan" }> => block.kind === "plan")
		.at(-1)?.text;

	useEffect(() => {
		stickToBottom.current = true;
	}, [current?.meta.id]);

	useEffect(() => {
		if (!stickToBottom.current) return;
		const element = scrollRef.current;
		if (element === null) return;
		const frame = requestAnimationFrame(() => {
			element.scrollTop = element.scrollHeight;
		});
		return () => cancelAnimationFrame(frame);
	}, [events.length, live?.text, live?.reasoning, current?.meta.id]);

	const report = (error: unknown): void => {
		dispatch({ type: "notice", level: "error", message: errorMessage(error) });
	};

	const loadOlder = async (): Promise<void> => {
		if (current === undefined || events.length === 0) return;
		setLoadingOlder(true);
		try {
			const page = await call(window.moros.sessionsEvents(current.meta.id, events[0]?.seq, 200));
			dispatch({ type: "events", sessionId: current.meta.id, events: page, mode: "prepend" });
		} catch (error) {
			report(error);
		} finally {
			setLoadingOlder(false);
		}
	};

	const approvePlan = (plan: string): void => {
		if (current === undefined) return;
		void (async () => {
			try {
				await call(window.moros.sessionSetPlan(false));
				await call(
					window.moros.chatSend({
						sessionId: current.meta.id,
						text: `${IMPLEMENTATION_PREFIX}${plan.trim()}${IMPLEMENTATION_SUFFIX}`,
					}),
				);
			} catch (error) {
				report(error);
			}
		})();
	};

	return (
		<div className="chat-page">
			<header className="main-bar">
				<div className="main-bar-left">
					<span className="conversation-title">{current?.meta.title ?? project?.name ?? "Moros Harness"}</span>
					{current?.plan === true ? <span className="pill">计划模式</span> : null}
					{current?.readOnly === true ? <span className="pill warn">只读</span> : null}
				</div>
			</header>

			<div
				className="conversation"
				ref={scrollRef}
				onScroll={(event) => {
					const element = event.currentTarget;
					stickToBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
				}}
			>
				<div className="transcript">
					{current !== undefined && events.length > 0 && (events[0]?.seq ?? 1) > 1 ? (
						<button className="load-older" disabled={loadingOlder} onClick={() => void loadOlder()}>
							{loadingOlder ? "加载中…" : "加载更早消息"}
						</button>
					) : null}
					{state.loadError !== undefined ? (
						<div className="load-error">
							<AlertIcon size={16} />
							<span>{state.loadError}</span>
						</div>
					) : null}
					<Transcript
						turns={turns}
						planning={current?.plan === true}
						running={current?.running === true}
						onApprovePlan={approvePlan}
						onRevisePlan={() => {
							if (activePlan === undefined) return;
							document.querySelector<HTMLTextAreaElement>(".composer textarea")?.focus();
						}}
					/>
				</div>
			</div>

			<div className="composer-dock">
				{approvals.map((card) => (
					<ApprovalPanel key={card.id} card={card} currentSessionId={current?.meta.id} />
				))}
				<Composer />
				{state.review !== undefined ? <ReviewModal /> : null}
			</div>

			{trustBlocked && project !== undefined ? <TrustGate /> : null}
			{current === undefined && project !== undefined ? (
				<div className="chat-empty">
					<p>正在打开会话…</p>
				</div>
			) : null}
		</div>
	);
}

function ApprovalPanel({
	card,
	currentSessionId,
}: {
	readonly card: ApprovalCard;
	readonly currentSessionId: string | undefined;
}): JSX.Element {
	const { dispatch } = useApp();
	const [expanded, setExpanded] = useState(false);
	const [busy, setBusy] = useState(false);
	const respond = async (decision: "allow" | "deny" | "allow-session"): Promise<void> => {
		if (busy) return;
		setBusy(true);
		try {
			await call(window.moros.approvalRespond(card.id, decision));
		} catch (error) {
			dispatch({ type: "notice", level: "error", message: errorMessage(error) });
		} finally {
			setBusy(false);
		}
	};
	return (
		<div className={`approval-card risk-${card.risk}`}>
			<div className="approval-head">
				<AlertIcon size={16} />
				<span className="approval-title">需要审批 · {card.tool}</span>
				<span className={`risk-badge risk-${card.risk}`}>{card.risk}</span>
				{currentSessionId !== undefined && card.sessionId !== currentSessionId ? (
					<span className="pill">来自另一个会话</span>
				) : null}
			</div>
			<div className="approval-reason">{card.reason}</div>
			<div className="approval-summary">{card.summary}</div>
			<button className="approval-expand" onClick={() => setExpanded(!expanded)}>
				{expanded ? "收起参数" : "查看参数"}
				<ChevronDownIcon size={13} />
			</button>
			{expanded ? <pre className="approval-preview">{card.preview}</pre> : null}
			<div className="approval-actions">
				<button className="primary-button" disabled={busy} onClick={() => void respond("allow")}>
					<CheckIcon size={14} />
					允许一次
				</button>
				{card.saveShort !== undefined ? (
					<button className="ghost-button" disabled={busy} onClick={() => void respond("allow-session")}>
						本会话允许 {card.saveShort}
					</button>
				) : null}
				<button className="danger-button" disabled={busy} onClick={() => void respond("deny")}>
					<XIcon size={14} />
					拒绝
				</button>
			</div>
		</div>
	);
}

function TrustGate(): JSX.Element {
	const { state, dispatch } = useApp();
	const project = state.project;
	if (project === undefined) return <></>;
	const accept = async (remember: boolean): Promise<void> => {
		try {
			const trust = await call(window.moros.trustAccept(remember));
			dispatch({ type: "trust", trust });
			const models = await call(window.moros.modelsList());
			dispatch({ type: "models", models });
		} catch (error) {
			dispatch({ type: "notice", level: "error", message: errorMessage(error) });
		}
	};
	const deny = async (): Promise<void> => {
		try {
			const trust = await call(window.moros.trustDeny());
			dispatch({ type: "trust", trust });
			const models = await call(window.moros.modelsList());
			dispatch({ type: "models", models });
		} catch (error) {
			dispatch({ type: "notice", level: "error", message: errorMessage(error) });
		}
	};
	return (
		<div className="trust-overlay">
			<div className="trust-card">
				<div className="trust-icon">
					<SparklesIcon size={22} />
				</div>
				<h2>信任这个工作区？</h2>
				<p>项目配置、项目技能与 AGENTS.md 会在信任后生效；未信任时只加载全局配置。</p>
				{project.trust.files.length > 0 ? (
					<ul className="trust-files">
						{project.trust.files.map((file) => (
							<li key={file}>{file}</li>
						))}
					</ul>
				) : null}
				<div className="trust-actions">
					<button className="primary-button" onClick={() => void accept(true)}>
						信任并记住
					</button>
					<button className="ghost-button" onClick={() => void accept(false)}>
						仅本次信任
					</button>
					<button className="danger-button" onClick={() => void deny()}>
						不信任
					</button>
				</div>
			</div>
		</div>
	);
}

function ReviewModal(): JSX.Element {
	const { state, dispatch } = useApp();
	const review = state.review;
	if (review === undefined) return <></>;
	return (
		<div className="modal-backdrop" onClick={() => dispatch({ type: "clear-review" })}>
			<div className="modal review-modal" onClick={(event) => event.stopPropagation()}>
				<div className="modal-head">
					<h2>只读审查</h2>
					<button className="icon-button" aria-label="关闭" onClick={() => dispatch({ type: "clear-review" })}>
						<XIcon size={16} />
					</button>
				</div>
				{review.state === "running" ? (
					<div className="review-running">
						<span className="spinner" />
						<span>审查子代理运行中…</span>
					</div>
				) : review.state === "error" ? (
					<div className="inline-notice notice-error">{review.error}</div>
				) : (
					<Markdown text={review.report ?? ""} />
				)}
			</div>
		</div>
	);
}
