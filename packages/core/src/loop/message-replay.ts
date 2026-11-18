import type { EventRecord, UserInputImage } from "../events/schema.ts";
import { imageOmittedPlaceholder } from "../llm/image-limits.ts";
import type { CanonicalMessage, CanonicalPart } from "../llm/types.ts";
import { planImageRetention } from "./image-budget.ts";

/**
 * 从事件流重建模型上下文。
 *
 * Agent Loop 的恢复与手动压缩（/compact）共用这一份重放逻辑，保证两条路径对同一条
 * 事件流得到完全相同的消息序列与事件序号。`compaction.done` 事件带摘要时，被压缩区间
 * 的消息折叠成一条 system 摘要——原始事件流不动，但后续请求与重启都使用压缩后的上下文。
 */

/** 一次工具调用的模型侧形态（来自 llm.response 事件的 toolCalls）。 */
export interface ToolInvocation {
	readonly id: string;
	readonly name: string;
	readonly arguments: Record<string, unknown>;
}

/** 重放结果：消息、每条消息对应的事件序号，以及运行控制所需的计数。 */
export interface ReplayedContext {
	readonly messages: CanonicalMessage[];
	/** 与 messages 一一对应的事件 seq（折叠后的摘要使用区间末条事件的 seq） */
	readonly seqs: number[];
	readonly turns: number;
	readonly pendingCalls: ReadonlyArray<{ readonly corr: string; readonly invocation: ToolInvocation }>;
	readonly lastSeq: number;
	readonly consecutiveFailures: number;
}

/**
 * 把完整事件流重放为模型消息序列。
 * @param records 按 seq 升序的会话事件。
 * @param loadImage 按附件元数据读取 Base64 图片；带图消息需要它。
 */
export async function replayMessages(
	records: readonly EventRecord[],
	loadImage?: (image: UserInputImage) => Promise<string>,
	maxConsecutiveFailures = 5,
): Promise<ReplayedContext> {
	const messages: CanonicalMessage[] = [];
	const seqs: number[] = [];
	const pending = new Map<string, { corr: string; invocation: ToolInvocation }>();
	const retainedImages = planRetainedImages(records);
	let turns = 0;
	let consecutiveFailures = 0;

	for (const event of records) {
		if (event.type === "user.input") {
			messages.push(
				await createUserMessage(event.payload.text, event.payload.images ?? [], loadImage, (image) =>
					retainedImages.has(image.attachmentId),
				),
			);
			seqs.push(event.seq);
		} else if (event.type === "llm.response") {
			turns += 1;
			const toolCalls = parseToolCalls(event.payload.toolCalls);
			messages.push({ role: "assistant", content: event.payload.text, ...(toolCalls.length > 0 ? { toolCalls } : {}) });
			seqs.push(event.seq);
			for (const call of toolCalls) pending.set(call.id, { corr: event.corr ?? "", invocation: call });
		} else if (event.type === "tool.result") {
			const call = pending.get(event.payload.toolCallId);
			if (call) {
				messages.push({
					role: "tool",
					toolCallId: call.invocation.id,
					content: event.payload.result,
					...(event.payload.isError ? { isError: true } : {}),
				});
				seqs.push(event.seq);
				pending.delete(call.invocation.id);
			}
			consecutiveFailures = event.payload.isError ? consecutiveFailures + 1 : 0;
		} else if (event.type === "breakpoint.paused" && event.payload.reason === "circuit-break") {
			consecutiveFailures = maxConsecutiveFailures;
		}
	}

	return {
		messages: foldCompacted(messages, seqs, records),
		seqs,
		turns,
		pendingCalls: [...pending.values()],
		lastSeq: records.at(-1)?.seq ?? 0,
		consecutiveFailures,
	};
}

/**
 * 按 `compaction.done` 的摘要折叠被压缩区间。
 *
 * 事件按落盘顺序处理；同一区间被多次压缩时以后一次为准。折叠后的摘要消息使用区间末条
 * 事件的 seq，保证后续新事件不会落进已折叠区间。
 */
function foldCompacted(
	messages: CanonicalMessage[],
	seqs: number[],
	records: readonly EventRecord[],
): CanonicalMessage[] {
	let current = messages;
	let currentSeqs = seqs;
	for (const event of records) {
		if (event.type !== "compaction.done") continue;
		const summary = event.payload.summary;
		const { fromSeq, toSeq } = event.payload;
		const indexes: number[] = [];
		for (const [index, seq] of currentSeqs.entries()) {
			if (seq >= fromSeq && seq <= toSeq) indexes.push(index);
		}
		if (indexes.length === 0) continue;
		const first = indexes[0]!;
		const dropped = new Set(indexes);
		const keptMessages: CanonicalMessage[] = [];
		const keptSeqs: number[] = [];
		for (const [index, message] of current.entries()) {
			if (!dropped.has(index)) {
				keptMessages.push(message);
				keptSeqs.push(currentSeqs[index]!);
				continue;
			}
			if (index === first) {
				keptMessages.push({ role: "system", content: `Earlier conversation summary:\n${summary.trim()}` });
				keptSeqs.push(toSeq);
			}
		}
		current = keptMessages;
		currentSeqs = keptSeqs;
	}
	return current;
}

/**
 * 回放时保留哪些历史图片。
 *
 * 只看事件里的 `bytes` 元数据，不读附件、不解码 Base64：一张图是否值得恢复，在打开
 * 文件之前就能决定。保留范围与发请求时的裁剪策略一致，避免「恢复时全解码、发送时再
 * 丢掉」的无效开销。
 */
function planRetainedImages(records: readonly EventRecord[]): ReadonlySet<string> {
	const images = records.flatMap((event) =>
		event.type === "user.input" ? (event.payload.images ?? []) : ([] as UserInputImage[]),
	);
	const keep = planImageRetention(images.map((image) => image.bytes));
	const retained = new Set<string>();
	for (const [index, image] of images.entries()) {
		if (keep[index]) retained.add(image.attachmentId);
	}
	return retained;
}

/**
 * 构造用户消息；带图时按附件元数据读取图片数据。
 * @param text 用户输入文本。
 * @param images 图片附件元数据。
 * @param loadImage 读取 Base64 的注入入口；被 `keepImage` 拦下的图片不会调用它。
 * @param keepImage 是否真正加载某张图；缺省全部加载。回放用它跳过超预算的旧图。
 */
export async function createUserMessage(
	text: string,
	images: readonly UserInputImage[],
	loadImage?: (image: UserInputImage) => Promise<string>,
	keepImage?: (image: UserInputImage) => boolean,
): Promise<CanonicalMessage> {
	if (images.length === 0) return { role: "user", content: text };
	const content: CanonicalPart[] = text ? [{ type: "text", text }] : [];
	for (const image of images) {
		if (keepImage !== undefined && !keepImage(image)) {
			content.push({ type: "text", text: imageOmittedPlaceholder(image.mediaType, image.bytes) });
			continue;
		}
		if (!loadImage) throw new Error("Image attachment loader is not configured");
		content.push({ type: "image", mediaType: image.mediaType, data: await loadImage(image) });
	}
	return { role: "user", content };
}

/** 解析 llm.response 事件里的工具调用参数；形状不对的条目跳过。 */
export function parseToolCalls(value: unknown): ToolInvocation[] {
	if (!Array.isArray(value)) return [];
	const calls: ToolInvocation[] = [];
	for (const item of value) {
		if (!item || typeof item !== "object" || Array.isArray(item)) continue;
		const call = item as Record<string, unknown>;
		if (typeof call.id !== "string" || typeof call.name !== "string" || !isRecord(call.arguments)) continue;
		calls.push({ id: call.id, name: call.name, arguments: call.arguments });
	}
	return calls;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}
