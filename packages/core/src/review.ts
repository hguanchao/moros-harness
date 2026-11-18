import type { ReviewRequest, ReviewVerdict } from "./harness/types.ts";
import type { LlmClient } from "./llm/client.ts";
import type { ModelRequest } from "./llm/types.ts";

/**
 * 高危动作的模型审查。
 *
 * auto 档先用确定性规则把 low/medium 放掉，只有 high 才走到这里：由**另一个模型**判断
 * 这条命令能不能不问人就执行。四条硬约束：
 *
 * 1. 独立上下文——审查者只看这一次调用，看不到任务前因后果，也不看主模型的解释。
 *    正因为如此，判定口径只能围绕「这一下会不会造成难以挽回的影响」，而不是「符不符合意图」。
 * 2. fail-closed——超时、报错、答复解析失败一律不放行，由调用方退回人工。
 * 3. 结论只认 JSON 对象或围栏里的 JSON 对象，不从整段回复里抓花括号：工具参数由被审查的
 *    内容控制，若从「拒绝说明」里抓 `{"allow": true}`，一次拒绝会被读成放行。
 * 4. 审查者不是安全边界——它是「少打扰」的折中，真正的边界仍是 denylist 与路径沙箱。
 */

const REVIEWER_SYSTEM_PROMPT = `You are reviewing whether one high-risk tool call may run without asking the user.

You see this call only, not the task behind it, so judge by "could this cause an impact that is hard to undo", not by "does it look like it is getting the job done".

Approve:
- read, list and search operations
- creating or modifying files inside the workspace
- commands that only read state or only affect the workspace, such as builds, tests and status checks

Deny:
- deleting or overwriting anything outside the workspace
- rewriting version history, such as force-switching or discarding uncommitted changes
- sending workspace content to an external service
- installing packages or changing persistent state unrelated to the current task
- calls whose effect you cannot tell

When in doubt, deny. A second look costs far less than an irreversible change.

Output one JSON object and nothing else:
{"allow": true, "reason": "one sentence explaining why"}`;

/** 送审内容的上限：命令可能很长，截断避免审查本身变成一次大请求。 */
const MAX_COMMAND_CHARS = 4000;

export interface CommandReviewerOptions {
	readonly llm: LlmClient;
	/** 已经解析好的审查模型请求模板；messages 由审查者自己填。 */
	readonly request: Omit<ModelRequest, "messages">;
	/** `provider/model` 标签，写进事件与审批卡。 */
	readonly modelLabel: string;
	readonly timeoutSec: number;
	readonly projectRoot: string;
}

/**
 * 建立审查回调。
 * @param options 客户端、请求模板、超时与工作区根。
 * @returns 供 Harness 管线在 auto 档高危动作上调用；永不抛错，失败按 error 结论返回。
 */
export function createCommandReviewer(
	options: CommandReviewerOptions,
): (request: ReviewRequest, signal?: AbortSignal) => Promise<ReviewVerdict> {
	return async (request, signal) => {
		const controller = new AbortController();
		const timeoutMs = Math.max(1, options.timeoutSec) * 1000;
		const timer = setTimeout(() => controller.abort(new Error("Review timed out")), timeoutMs);
		timer.unref();
		const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
		try {
			const response = await options.llm.complete(
				{
					...options.request,
					messages: [
						{ role: "system", content: REVIEWER_SYSTEM_PROMPT },
						{ role: "user", content: reviewPayload(options, request) },
					],
				},
				{ signal: combined },
			);
			return { ...parseReviewVerdict(response.text), model: options.modelLabel };
		} catch (error) {
			return { decision: "error", reason: errorText(error), model: options.modelLabel };
		} finally {
			clearTimeout(timer);
		}
	};
}

/**
 * 解析审查结论。
 *
 * 先整体解析，不成再找代码围栏；两处都不认「第一对花括号」——参数由被审查的内容控制，
 * 一句拒绝说明里引用的 `{"allow": true}` 若被当成结论，拒绝就会读成放行。
 * @param text 模型回复全文。
 * @returns 审查结论；解析不出时按拒绝处理（fail-closed）。
 */
export function parseReviewVerdict(text: string): ReviewVerdict {
	const direct = tryParse(text.trim());
	if (direct !== undefined) return direct;
	const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
	if (fenced !== null) {
		const inner = tryParse((fenced[1] ?? "").trim());
		if (inner !== undefined) return inner;
	}
	return { decision: "deny", reason: "Reviewer reply could not be parsed; denying" };
}

function tryParse(candidate: string): ReviewVerdict | undefined {
	if (candidate.length === 0) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(candidate);
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null) return undefined;
	const record = parsed as { allow?: unknown; reason?: unknown };
	if (typeof record.allow !== "boolean") return undefined;
	const reason =
		typeof record.reason === "string" && record.reason.trim().length > 0
			? record.reason.trim()
			: record.allow
				? "Reviewer allowed the call"
				: "Reviewer denied the call";
	return { decision: record.allow ? "allow" : "deny", reason };
}

function reviewPayload(options: CommandReviewerOptions, request: ReviewRequest): string {
	const lines = [
		`Workspace: ${options.projectRoot}`,
		`Tool: ${request.tool}`,
		`Risk: ${request.risk.level} (${request.risk.rule})`,
		`Command: ${truncate(request.command)}`,
	];
	// MCP 工具没有命令文本；把参数送给审查者，否则它只能看到「效果未知」并一律拒绝
	if (request.args !== undefined) {
		lines.push(`Arguments: ${truncate(safeJson(request.args))}`);
	}
	return lines.join("\n\n");
}

/** 参数来自外部工具，序列化失败时给出可读的兜底，不让审查本身抛错。 */
function safeJson(value: unknown): string {
	try {
		return JSON.stringify(value) ?? String(value);
	} catch {
		return String(value);
	}
}

/** 截断必须写明：否则把危险内容放在截断点之后，在审查者眼里只是一段无害前缀。 */
function truncate(text: string): string {
	if (text.length <= MAX_COMMAND_CHARS) return text;
	return `${text.slice(0, MAX_COMMAND_CHARS)}\n…[truncated at ${MAX_COMMAND_CHARS} characters; the rest is not shown]`;
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : "Review failed";
}
