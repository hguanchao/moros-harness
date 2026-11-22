import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from "react";

import type { ApprovalCard } from "../shared/contract.ts";
import { call, errorMessage } from "../api/api.ts";
import { Composer } from "../components/Composer.tsx";
import { EmptyBrand } from "../components/EmptyBrand.tsx";
import { workspaceTarget, workspaceTargetsMatch } from "../utils/workspace.ts";
import { resolveFeedbacks } from "../utils/message-actions.ts";
import { useExitingItems } from "../hooks/use-exiting.ts";
import {
	AlertIcon,
	ArrowDownIcon,
	CheckIcon,
	ChevronDownIcon,
	PanelRightIcon,
	SearchIcon,
	SparklesIcon,
	XIcon,
} from "../components/Icons.tsx";
import { Markdown } from "../components/Markdown.tsx";
import { ConversationPanel } from "../components/ConversationPanel.tsx";
import { ConversationSearch } from "../components/ConversationSearch.tsx";
import { useApp } from "../store/state.tsx";
import { buildTimeline, currentTodoView, Transcript, type WorkStepsConfig } from "../components/Transcript.tsx";
import { TodoPanel } from "../components/TodoPanel.tsx";
import { SelectionQuote } from "../components/SelectionQuote.tsx";

const IMPLEMENTATION_PREFIX = "Implement this plan:\n\n";
const IMPLEMENTATION_SUFFIX = "\n\nRe-read the files you need before changing them.";

export function ChatPage(): JSX.Element {
	const { state, dispatch } = useApp();
	const current = state.current;
	const project = state.project;
	const scrollRef = useRef<HTMLDivElement | null>(null);
	const stickToBottom = useRef(true);
	/** 用户向上滚动离开底部时显示「回到底部」按钮。 */
	const [showScrollBottom, setShowScrollBottom] = useState(false);
	/** 标题栏：对话搜索与右侧面板的开合状态。 */
	const [searchOpen, setSearchOpen] = useState(false);
	const [searchQuery, setSearchQuery] = useState("");
	const [panelOpen, setPanelOpen] = useState(false);

	const events = current === undefined ? [] : (state.events[current.meta.id] ?? []);
	const live = current === undefined ? undefined : (state.live[current.meta.id] ?? current.live);
	const subagents = current === undefined ? {} : (state.subagents[current.meta.id] ?? {});
	const inlineNotices = current === undefined ? [] : (state.inlineNotices[current.meta.id] ?? []);
	// 工作步骤展示设置来自全局 ui 配置；缺省值由 Transcript 的 DEFAULT_WORK_STEPS 兜底。
	const uiConfig = state.settings?.config.ui;
	const workSteps: WorkStepsConfig | undefined =
		uiConfig === undefined
			? undefined
			: {
					detailLevel: uiConfig.workStepDetail,
					collapseTiming: uiConfig.collapseTiming,
					collapsedReplies: uiConfig.collapsedReplies,
				};
	const turns = useMemo(
		() => (live === undefined ? [] : buildTimeline(events, live, subagents)),
		[events, live, subagents],
	);
	// 当前未收尾任务列表（底部常驻面板）；已收尾的由 TodoCard 落入对话流。
	const currentTodo = useMemo(() => currentTodoView(turns), [turns]);
	// 反馈状态由事件流还原（唯一事实源），随事件推送自动刷新。
	const feedbacks = useMemo(() => resolveFeedbacks(events), [events]);
	const handleQuote = useCallback(
		(text: string): void => {
			dispatch({ type: "draft-quote-added", quote: { id: crypto.randomUUID(), text } });
			document.querySelector<HTMLTextAreaElement>(".composer textarea")?.focus();
		},
		[dispatch],
	);
	const handleFeedback = useCallback(
		(seq: number, rating: "up" | "down" | "none"): void => {
			if (current === undefined) return;
			void call(window.moros.messageFeedback(current.meta.id, seq, rating)).catch((error: unknown) =>
				console.error(errorMessage(error)),
			);
		},
		[current],
	);
	const approvals = [...state.approvals].sort((left, right) => {
		const leftCurrent = current !== undefined && left.sessionId === current.meta.id ? 0 : 1;
		const rightCurrent = current !== undefined && right.sessionId === current.meta.id ? 0 : 1;
		return leftCurrent - rightCurrent;
	});
	const exitingApprovals = useExitingItems(state.approvals, approvalKey);
	const approvalSlots = [
		...state.approvals.map((card) => ({ card, leaving: false })),
		...exitingApprovals.map((card) => ({ card, leaving: true })),
	];
	const isDraftPrepared =
		state.draftWorkspace !== undefined &&
		workspaceTargetsMatch(state.draftWorkspace, workspaceTarget(state.draft.project), state.app?.platform ?? "win32");
	const trustBlocked =
		(current !== undefined || isDraftPrepared) && project?.trust.required === true && project.trust.decision === null;
	const activePlan = turns
		.flatMap((turn) => turn.blocks)
		.filter((block): block is Extract<typeof block, { kind: "plan" }> => block.kind === "plan")
		.at(-1)?.text;

	useEffect(() => {
		stickToBottom.current = true;
		setShowScrollBottom(false);
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

	const scrollToBottom = (): void => {
		const element = scrollRef.current;
		if (element === null) return;
		element.scrollTo({ top: element.scrollHeight, behavior: "smooth" });
		stickToBottom.current = true;
		setShowScrollBottom(false);
	};

	/** 搜索结果定位：滚动到对应回合并短暂高亮。 */
	const jumpToTurn = (turnKey: string): void => {
		const target = document.getElementById(turnKey);
		if (target === null) return;
		target.scrollIntoView({ behavior: "smooth", block: "center" });
		target.classList.add("is-search-hit");
		window.setTimeout(() => target.classList.remove("is-search-hit"), 1600);
	};

	const report = (error: unknown): void => {
		// 会话相关操作失败内联到当前会话对话流，不再弹浮动提示。
		if (current !== undefined) {
			dispatch({ type: "inline-notice", sessionId: current.meta.id, tone: "error", text: errorMessage(error) });
		} else {
			console.error(`[moros] ${errorMessage(error)}`);
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

	const dock = (
		<div className="composer-dock">
			{approvalSlots.map((slot) => (
				<ApprovalSlot key={slot.card.id} card={slot.card} leaving={slot.leaving} currentSessionId={current?.meta.id} />
			))}
			<TodoPanel view={currentTodo} running={current?.running === true} />
			<Composer />
			{state.review !== undefined ? <ReviewModal /> : null}
		</div>
	);

	return (
		<div className={`chat-page ${current === undefined ? "is-new-task" : ""}`}>
			{current === undefined ? null : (
				<header className="main-bar">
					<div className="main-bar-left">
						<span className="conversation-title">{current.meta.title}</span>
						{current.readOnly === true ? <span className="pill warn">只读</span> : null}
					</div>
					<div className="main-bar-right">
						<button
							className={`icon-button ${searchOpen ? "is-active" : ""}`}
							aria-label="搜索对话"
							data-tooltip="搜索对话"
							onClick={() => {
								setSearchOpen((open) => !open);
								setPanelOpen(false);
							}}
						>
							<SearchIcon size={16} />
						</button>
						<button
							className={`icon-button ${panelOpen ? "is-active" : ""}`}
							aria-label="会话面板"
							data-tooltip="会话面板"
							onClick={() => {
								setPanelOpen((open) => !open);
								setSearchOpen(false);
							}}
						>
							<PanelRightIcon size={16} />
						</button>
						{searchOpen ? (
							<div className="conversation-search-popover">
								<ConversationSearch
									events={events}
									query={searchQuery}
									onQueryChange={setSearchQuery}
									onJump={jumpToTurn}
									onClose={() => setSearchOpen(false)}
								/>
							</div>
						) : null}
					</div>
				</header>
			)}

			{current === undefined ? (
				<div className="new-task-stage">
					<EmptyBrand
						onExample={(text) => {
							dispatch({ type: "draft-text", text });
							document.querySelector<HTMLTextAreaElement>(".composer textarea")?.focus();
						}}
					/>
					{dock}
				</div>
			) : (
				<>
					<div className="conversation-shell">
						<span className={`turn-lifeline ${live?.running === true ? "is-running" : ""}`} aria-hidden="true" />
						<div
							className="conversation"
							ref={scrollRef}
							onScroll={(event) => {
								const element = event.currentTarget;
								const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
								stickToBottom.current = atBottom;
								setShowScrollBottom(!atBottom);
							}}
						>
							<SelectionQuote onQuote={handleQuote}>
								<div className="transcript">
									{state.loadError !== undefined ? (
										<div className="load-error">
											<AlertIcon size={16} />
											<span>{state.loadError}</span>
										</div>
									) : null}
									<Transcript
										turns={turns}
										inlineNotices={inlineNotices}
										planning={current.plan === true}
										running={current.running === true}
										{...(workSteps === undefined ? {} : { workSteps })}
										feedbacks={feedbacks}
										onFeedback={handleFeedback}
										{...(project === undefined ? {} : { projectRoot: project.root })}
										onApprovePlan={approvePlan}
										onRevisePlan={() => {
											if (activePlan === undefined) return;
											document.querySelector<HTMLTextAreaElement>(".composer textarea")?.focus();
										}}
									/>
								</div>
							</SelectionQuote>
						</div>
						{panelOpen ? (
							<ConversationPanel current={current} events={events} onClose={() => setPanelOpen(false)} />
						) : null}
						{showScrollBottom ? (
							<button
								className="scroll-bottom-button"
								aria-label="回到底部"
								data-tooltip="回到底部"
								onClick={scrollToBottom}
							>
								<ArrowDownIcon size={17} />
							</button>
						) : null}
					</div>
					{dock}
				</>
			)}

			{trustBlocked && project !== undefined ? <TrustGate /> : null}
			{state.isNavigating ? (
				<div className="chat-loading" role="status">
					正在打开会话…
				</div>
			) : null}
		</div>
	);
}

const approvalKey = (card: ApprovalCard): string => card.id;

/** 审批卡槽位：入场/离场用 grid-rows 折叠过渡，卡片出现与消失时 dock 内容不跳变。 */
function ApprovalSlot({
	card,
	leaving,
	currentSessionId,
}: {
	readonly card: ApprovalCard;
	readonly leaving: boolean;
	readonly currentSessionId: string | undefined;
}): JSX.Element {
	const [entered, setEntered] = useState(false);
	useEffect(() => {
		const frame = requestAnimationFrame(() => setEntered(true));
		return () => cancelAnimationFrame(frame);
	}, []);
	return (
		<div className={`approval-slot ${leaving ? "is-leaving" : entered ? "" : "is-entering"}`}>
			<div className="approval-slot-inner">
				<ApprovalPanel card={card} currentSessionId={currentSessionId} />
			</div>
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
			if (currentSessionId !== undefined) {
				dispatch({ type: "inline-notice", sessionId: currentSessionId, tone: "error", text: errorMessage(error) });
			} else {
				console.error(`[moros] ${errorMessage(error)}`);
			}
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
				{card.sessionId !== currentSessionId ? <span className="pill">来自另一个会话</span> : null}
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
					<button
						className="ghost-button"
						disabled={busy}
						data-tooltip={`本会话允许 ${card.saveShort}`}
						onClick={() => void respond("allow-session")}
					>
						本会话允许
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
			console.error(`[moros] ${errorMessage(error)}`);
		}
	};
	const deny = async (): Promise<void> => {
		try {
			const trust = await call(window.moros.trustDeny());
			dispatch({ type: "trust", trust });
			const models = await call(window.moros.modelsList());
			dispatch({ type: "models", models });
		} catch (error) {
			console.error(`[moros] ${errorMessage(error)}`);
		}
	};
	return (
		<div className="trust-overlay">
			<div className="trust-card" role="dialog" aria-modal="true" aria-label="信任这个工作区">
				<div className="modal-head trust-heading">
					<span className="trust-icon">
						<SparklesIcon size={22} />
					</span>
					<h2>信任这个工作区？</h2>
				</div>
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
