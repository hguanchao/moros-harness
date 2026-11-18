import { randomUUID } from "node:crypto";

import { EventStore } from "../session/event-store.ts";
import type { LlmClient } from "../llm/client.ts";
import type { CanonicalMessage, ModelRequest, ModelResponse } from "../llm/types.ts";
import type { UserInputImage } from "../events/schema.ts";
import type { ContextCompactor } from "../compaction/compactor.ts";
import { applyImageBudget } from "./image-budget.ts";
import { createUserMessage, replayMessages, type ToolInvocation } from "./message-replay.ts";

export type { ToolInvocation } from "./message-replay.ts";

export interface ToolOutcome {
	readonly content: string;
	readonly isError?: boolean;
	readonly paused?: boolean;
}

export interface ToolExecutor {
	execute(invocation: ToolInvocation, options: { corr: string; signal?: AbortSignal }): Promise<ToolOutcome>;
}

export interface LoopOptions {
	readonly llm: LlmClient;
	readonly request: Omit<ModelRequest, "messages">;
	readonly tools: ToolExecutor;
	readonly events: EventStore;
	readonly systemMessage?: string;
	readonly compactor?: ContextCompactor;
	readonly contextWindow: number;
	readonly maxTurns: number;
	/** 当前策略是否允许用户主动暂停和继续。 */
	readonly breakpoint?: boolean;
	/** 接收主模型请求的流式文本增量；不落盘，仅用于 UI 实时显示。 */
	readonly onText?: (text: string) => void;
	/** 接收推理模型的思考增量；不落盘，仅用于 UI 实时显示。 */
	readonly onReasoning?: (text: string) => void;
	/** 流因空闲超时或提前结束而重试时回调，用于清空 UI 中的未完成增量。 */
	readonly onRetry?: () => void;
	readonly maxConsecutiveFailures?: number;
	readonly now?: () => number;
	readonly createId?: () => string;
	/** 根据事件附件元数据读取 Base64 图片数据。 */
	readonly loadImage?: (image: UserInputImage) => Promise<string>;
}

export interface LoopResult {
	readonly messages: readonly CanonicalMessage[];
	readonly turns: number;
	readonly paused: boolean;
}

/**
 * 一次会话的模型与工具执行循环；从事件流重建上下文，工具只经注入的 Harness 执行器。
 */
export class AgentLoop {
	readonly #options: LoopOptions;
	#paused = false;
	#pauseGate: Promise<void> | undefined;
	#resumePause: (() => void) | undefined;
	#abort = new AbortController();
	#running: Promise<LoopResult> | undefined;
	#messages: CanonicalMessage[] = [];
	#messageSeqs: number[] = [];
	#pendingCalls: Array<{ corr: string; invocation: ToolInvocation }> = [];
	#consecutiveFailures = 0;
	#turns = 0;

	constructor(options: LoopOptions) {
		this.#options = options;
	}

	/** 请求在当前模型或工具步骤完成后暂停；策略关闭断点时返回 false。 */
	pause(): boolean {
		if (this.#options.breakpoint === false) return false;
		this.#paused = true;
		this.#pauseGate ??= new Promise<void>((resolve) => {
			this.#resumePause = resolve;
		});
		return true;
	}

	/** 恢复已暂停的 Loop；首次运行之前调用会在之后的检查点生效。 */
	resume(): boolean {
		if (this.#options.breakpoint === false) return false;
		this.#paused = false;
		this.#resumePause?.();
		this.#resumePause = undefined;
		this.#pauseGate = undefined;
		return true;
	}

	/** 中止当前模型请求、审批等待或工具调用。 */
	abort(reason?: unknown): void {
		this.#abort.abort(reason);
		this.#resumePause?.();
		this.#resumePause = undefined;
		this.#pauseGate = undefined;
	}

	/**
	 * 追加用户输入并运行至助手停止、达到限制或暂停。
	 * @param text 用户输入文本。
	 * @param images 已持久化的图片附件元数据，数据由注入读取器加载。
	 * @returns 当前会话恢复出的完整规范消息及运行状态。
	 */
	run(text: string, images: readonly UserInputImage[] = []): Promise<LoopResult> {
		if (this.#running) return Promise.reject(new Error("Agent loop is already running"));
		this.#abort = new AbortController();
		this.#running = this.#run(text, images).finally(() => {
			this.#running = undefined;
		});
		return this.#running;
	}

	async #run(text: string, images: readonly UserInputImage[]): Promise<LoopResult> {
		const { events } = this.#options;
		await this.#restoreContext();
		if (text || images.length > 0) {
			const userMessage = await createUserMessage(text, images, this.#options.loadImage);
			const userEvent = await events.append({
				type: "user.input",
				payload: { text, ...(images.length > 0 ? { images: [...images] } : {}) },
			});
			this.#messages.push(userMessage);
			this.#messageSeqs.push(userEvent.seq);
			this.#pendingCalls = [];
		}

		while (!this.#abort.signal.aborted) {
			await this.#checkpoint();
			if (this.#abort.signal.aborted) break;
			if (this.#options.maxTurns > 0 && this.#turns >= this.#options.maxTurns) {
				await events.append({ type: "breakpoint.paused", payload: { reason: "turn-limit" } });
				return { messages: this.#messages, turns: this.#turns, paused: true };
			}

			if (this.#pendingCalls.length > 0) {
				const toolResult = await this.#executePendingTools();
				if (toolResult.paused || this.#abort.signal.aborted) {
					return { messages: this.#messages, turns: this.#turns, paused: true };
				}
				continue;
			}

			// 图片按「最近优先」裁剪后再发请求：常驻消息与请求体都只保留预算内的 Base64，
			// 旧图替换为文本占位。数组长度与顺序不变，#messageSeqs 的对应关系不受影响。
			this.#messages = applyImageBudget(this.#messages);
			const compactedMessages = this.#options.compactor
				? (
						await this.#options.compactor.compact(
							this.#messages,
							this.#options.contextWindow,
							this.#abort.signal,
							this.#messageSeqs,
						)
					).messages
				: this.#messages;
			const inputMessages = this.#options.systemMessage
				? [{ role: "system" as const, content: this.#options.systemMessage }, ...compactedMessages]
				: compactedMessages;
			const corr = (this.#options.createId ?? randomUUID)();
			const request = { ...this.#options.request, messages: inputMessages };
			await events.append({
				type: "llm.request",
				corr,
				payload: { endpoint: request.api, model: request.model, messageCount: inputMessages.length },
			});

			let response: ModelResponse;
			try {
				response = await this.#options.llm.complete(request, {
					signal: this.#abort.signal,
					...(this.#options.onText ? { onText: this.#options.onText } : {}),
					...(this.#options.onReasoning ? { onReasoning: this.#options.onReasoning } : {}),
					...(this.#options.onRetry ? { onRetry: this.#options.onRetry } : {}),
				});
			} catch (error) {
				if (this.#abort.signal.aborted) break;
				const message = error instanceof Error ? error.message : "Unknown LLM error";
				await events.append({ type: "error", corr, payload: { kind: "llm", message, recoverable: true } });
				return { messages: this.#messages, turns: this.#turns, paused: false };
			}

			this.#turns += 1;
			await this.#recordResponse(response, corr);
			if (response.toolCalls.length === 0) break;
			this.#pendingCalls = response.toolCalls.map((call) => ({
				corr,
				invocation: { id: call.id, name: call.name, arguments: call.arguments },
			}));
		}
		return { messages: this.#messages, turns: this.#turns, paused: this.#paused };
	}

	async #executePendingTools(): Promise<{ paused: boolean }> {
		const next = this.#pendingCalls[0];
		if (!next) return { paused: false };
		await this.#checkpoint();
		if (this.#abort.signal.aborted) return { paused: true };

		let outcome: ToolOutcome;
		try {
			outcome = await this.#options.tools.execute(next.invocation, {
				corr: next.corr,
				signal: this.#abort.signal,
			});
		} catch (error) {
			outcome = { content: error instanceof Error ? error.message : "Tool execution failed", isError: true };
		}
		this.#pendingCalls.shift();
		this.#messages.push({
			role: "tool",
			toolCallId: next.invocation.id,
			content: outcome.content,
			...(outcome.isError ? { isError: true } : {}),
		});
		this.#messageSeqs.push(this.#options.events.lastSeq);
		this.#consecutiveFailures = outcome.isError ? this.#consecutiveFailures + 1 : 0;

		const maxFailures = this.#options.maxConsecutiveFailures ?? 5;
		if (outcome.paused) return { paused: true };
		if (this.#consecutiveFailures >= maxFailures) {
			await this.#options.events.append({
				type: "breakpoint.paused",
				corr: next.corr,
				payload: { reason: "circuit-break" },
			});
			return { paused: true };
		}
		return { paused: false };
	}

	async #recordResponse(response: ModelResponse, corr: string): Promise<void> {
		const responseEvent = await this.#options.events.append({
			type: "llm.response",
			corr,
			payload: {
				text: response.text,
				toolCalls: response.toolCalls,
				usage: response.usage ?? { inputTokens: 0, outputTokens: 0 },
				stopReason: response.stopReason,
			},
		});
		this.#messages.push({
			role: "assistant",
			content: response.text,
			...(response.toolCalls.length > 0 ? { toolCalls: response.toolCalls } : {}),
		});
		this.#messageSeqs.push(responseEvent.seq);
	}

	async #restoreContext(): Promise<void> {
		if (this.#messages.length > 0) return;
		// 与手动压缩共用同一份重放：compaction.done 带摘要时上下文按区间折叠
		const replayed = await replayMessages(
			await this.#options.events.read(),
			this.#options.loadImage,
			this.#options.maxConsecutiveFailures,
		);
		this.#messages.push(...replayed.messages);
		this.#messageSeqs.push(...replayed.seqs);
		this.#turns += replayed.turns;
		this.#pendingCalls = [...replayed.pendingCalls];
		this.#consecutiveFailures = replayed.consecutiveFailures;
	}

	async #checkpoint(): Promise<void> {
		if (this.#abort.signal.aborted || !this.#paused) return;
		await this.#options.events.append({ type: "breakpoint.paused", payload: { reason: "user" } });
		if (!this.#paused || this.#abort.signal.aborted) return;
		const pauseGate =
			this.#pauseGate ??
			new Promise<void>((resolve) => {
				this.#resumePause = resolve;
			});
		this.#pauseGate = pauseGate;
		await pauseGate;
		if (this.#abort.signal.aborted) return;
		this.#paused = false;
		this.#pauseGate = undefined;
		await this.#options.events.append({ type: "breakpoint.resumed", payload: { reason: "user" } });
	}
}
