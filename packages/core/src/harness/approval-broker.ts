import { firstLine } from "../session/session-title.ts";
import { approvalScope } from "./approval-scope.ts";
import type { ApprovalDecision, ApprovalRequest } from "./types.ts";

/** 审批卡展示内容；与管线请求解耦，宿主只消费这个形状。 */
export interface ApprovalPrompt {
	readonly tool: string;
	readonly risk: string;
	readonly detail: string;
	readonly summary?: string;
	readonly preview?: string;
	readonly previewLabel?: string;
	/** 本会话放行作用域短词；缺省时不提供记住档。 */
	readonly saveShort?: string;
}

/** 审批卡给出的三种决定；always 映射为管线 allow-session。 */
export type ApprovalAnswer = "once" | "always" | "deny";

interface PendingApproval {
	readonly request: ApprovalRequest;
	/** 发起审批的会话；宿主据此在切换审批档位时精确放行该会话的挂起卡。 */
	readonly sessionId: string;
	readonly prompt: ApprovalPrompt;
	readonly displayId: number;
	readonly resolve: (decision: ApprovalDecision) => void;
	readonly reject: (error: Error) => void;
	readonly signal?: AbortSignal;
	readonly onAbort?: () => void;
	readonly timer?: NodeJS.Timeout;
}

/**
 * Core 与所有宿主共用的审批队列：Core 侧 request 挂起工具，宿主消费 pending/pendingAll
 * 展示审批卡，再通过 respond 或 resolve 回传决定。
 *
 * 超时（默认 120 秒）与中止信号都按 deny / AbortError 收尾，避免工具永久挂起。
 */
export interface ApprovalBroker {
	request(request: ApprovalRequest, signal?: AbortSignal, sessionId?: string): Promise<ApprovalDecision>;
	current(): ApprovalRequest | undefined;
	pending(): ApprovalPrompt | undefined;
	pendingAll(): readonly ApprovalPrompt[];
	subscribe(listener: (request?: ApprovalRequest) => void): () => void;
	respond(id: string, decision: ApprovalDecision): void;
	pendingId(): number | undefined;
	resolve(answer: ApprovalAnswer, id?: number): void;
	denyAll(): void;
	/** 放行指定会话的全部挂起审批；用于运行中切到完全访问时自动放行当前卡。 */
	allowSession(sessionId: string): void;
}

export interface ApprovalBrokerOptions {
	/** 自动拒绝时间；0 关闭。缺省 120 秒，与管线一致。 */
	readonly timeoutMs?: number;
}

/**
 * 创建审批队列。
 * @param options 超时毫秒数。
 */
export function createApprovalBroker(options: ApprovalBrokerOptions = {}): ApprovalBroker {
	const pending = new Map<string, PendingApproval>();
	const listeners = new Set<(request?: ApprovalRequest) => void>();
	const timeoutMs = options.timeoutMs ?? 120_000;
	let nextDisplayId = 1;

	const latest = (): PendingApproval | undefined => {
		let found: PendingApproval | undefined;
		for (const entry of pending.values()) found = entry;
		return found;
	};
	const publish = (): void => {
		const entry = latest();
		for (const listener of [...listeners]) listener(entry?.request);
	};
	const finish = (id: string, decision: ApprovalDecision): void => {
		const entry = pending.get(id);
		if (!entry) throw new Error(`Approval ${id} is no longer pending`);
		pending.delete(id);
		if (entry.signal && entry.onAbort) entry.signal.removeEventListener("abort", entry.onAbort);
		if (entry.timer) clearTimeout(entry.timer);
		entry.resolve(decision);
		publish();
	};

		return {
		request(request, signal, sessionId) {
			if (pending.has(request.id)) return Promise.reject(new Error(`Approval ${request.id} is already pending`));
			if (signal?.aborted) return Promise.reject(asAbortError(signal.reason));
			return new Promise<ApprovalDecision>((resolve, reject) => {
				const onAbort = (): void => {
					const entry = pending.get(request.id);
					if (!entry) return;
					pending.delete(request.id);
					if (entry.timer) clearTimeout(entry.timer);
					reject(asAbortError(signal?.reason));
					publish();
				};
				const timer =
					timeoutMs > 0
						? setTimeout(() => {
								if (pending.has(request.id)) finish(request.id, "deny");
							}, timeoutMs)
						: undefined;
				timer?.unref();
				const entry: PendingApproval = {
					request,
					sessionId: sessionId ?? "",
					prompt: toPrompt(request),
					displayId: nextDisplayId++,
					resolve,
					reject,
					...(signal ? { signal, onAbort } : {}),
					...(timer ? { timer } : {}),
				};
				pending.set(request.id, entry);
				if (signal) signal.addEventListener("abort", onAbort, { once: true });
				publish();
			});
		},
		current: () => latest()?.request,
		pending: () => latest()?.prompt,
		pendingAll: () => [...pending.values()].map((entry) => entry.prompt),
		subscribe(listener) {
			listeners.add(listener);
			listener(latest()?.request);
			return () => listeners.delete(listener);
		},
		respond: finish,
		pendingId: () => latest()?.displayId,
		resolve(answer, id) {
			const entry = id === undefined ? latest() : [...pending.values()].find((candidate) => candidate.displayId === id);
			if (!entry) return;
			const decision: ApprovalDecision = answer === "always" ? "allow-session" : answer === "once" ? "allow" : "deny";
			finish(entry.request.id, decision);
		},
		denyAll() {
			for (const entry of [...pending.values()]) finish(entry.request.id, "deny");
		},
		allowSession(sessionId) {
			for (const entry of [...pending.values()]) {
				if (entry.sessionId === sessionId) finish(entry.request.id, "allow");
			}
		},
	};
}

/** 把管线请求转成审批卡展示形状；参数截断到一行摘要。 */
function toPrompt(request: ApprovalRequest): ApprovalPrompt {
	const args = typeof request.args === "string" ? request.args : (JSON.stringify(request.args, null, 2) ?? "");
	return {
		tool: request.tool,
		risk: request.risk,
		detail: request.reason,
		summary: `${request.tool} · ${firstLine(args.replaceAll("\n", " "), 120)}`,
		preview: args,
		previewLabel: "Arguments",
		// 作用域与管线同源，避免两处计算结果漂移
		saveShort: approvalScope(request.tool, request.args).label,
	};
}

function asAbortError(reason: unknown): Error {
	if (reason instanceof Error) return reason;
	const error = new Error("Approval request was cancelled");
	error.name = "AbortError";
	return error;
}
