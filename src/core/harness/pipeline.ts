import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";

import micromatch from "micromatch";

import { OutputCollector } from "#src/core/tools/output-collector.ts";
import { approvalScope } from "#src/core/harness/approval-scope.ts";
import { createPolicy } from "#src/core/harness/policy.ts";
import { resolveSandboxPath } from "#src/core/harness/path-sandbox.ts";
import { assessCommandRisk, FILE_TOOL_RISK, isAutoApproved, type RiskAssessment } from "#src/core/harness/risk.ts";
import type {
	ApprovalDecision,
	ApprovalRequest,
	Mode,
	PipelineOptions,
	ReviewVerdict,
	ToolDefinition,
	ToolResult,
} from "#src/core/harness/types.ts";
import { isMissingPath, isNotFound } from "#src/core/fs-error.ts";

const DENYLIST = [
	"rm -rf /",
	"rm -rf /*",
	"mkfs*",
	// "format *" 带空格：拦截磁盘格式化（format C:），但不误伤 PowerShell 的
	// Format-List / Format-Table 输出管道（真实测试复现的误伤，见 §7.4）
	"format *",
	"dd if=* of=/dev/*",
	"reg delete *",
	"shutdown*",
	":(){:|:&};:*",
] as const;

interface SnapshotTarget {
	readonly absolutePath: string;
	readonly relativePath: string;
	readonly before: string | null;
}

/** 所有工具调用唯一入口，按固定次序完成校验、授权、快照、执行与审计。 */
export class ToolPipeline {
	readonly #options: PipelineOptions;
	readonly #tools: ReadonlyMap<string, ToolDefinition>;
	readonly #now: () => number;
	#mode: Mode;
	#approval: "ask" | "auto" | "yolo";
	/**
	 * 用户以 `allow-session` 放行过的作用域（见 approval-scope.ts）。
	 *
	 * 由调用方注入而不是管线自建：管线每轮对话都会新建，自建集合会让「本会话」在下一轮
	 * 就失忆，用户批准过的命令前缀又要重问一遍。
	 */
	readonly #sessionApproved: Set<string>;

	constructor(options: PipelineOptions) {
		this.#options = options;
		this.#tools = new Map(options.tools.map((tool) => [tool.name, tool]));
		this.#sessionApproved = options.sessionApproved ?? new Set();
		this.#now = options.monotonicNow ?? (() => performance.now());
		this.#mode = options.mode;
		this.#approval = options.approval;
	}

	/** 为后续调用替换策略配置；已经通过审批或正在执行的调用不变更。 */
	setPolicy(mode: Mode, approval: "ask" | "auto" | "yolo"): void {
		this.#mode = mode;
		this.#approval = approval;
	}

	/** 运行已注册工具；调用、结果与管控事件统一追加到会话事件流。 */
	async run(
		name: string,
		rawArgs: unknown,
		corr: string,
		signal?: AbortSignal,
		toolCallId?: string,
	): Promise<ToolResult> {
		const { events, sessionId, projectRoot } = this.#options;
		const tool = this.#tools.get(name);
		// 管线保证每个工具调用都有调用 ID：调用方没给就现场生成，事件流里不再出现无 ID 的记录
		const callId = toolCallId ?? randomUUID();
		const callEvent = await events.append({
			type: "tool.call",
			corr,
			payload: { tool: name, args: redactArguments(rawArgs), toolCallId: callId },
		});

		if (!tool) return this.#failure(name, "tool-not-found", `Unknown tool: ${name}`, corr, "error", {}, callId);
		if (signal?.aborted) return this.#failure(name, "aborted", "Tool call was cancelled", corr, "error", {}, callId);
		const parsed = tool.schema.safeParse(rawArgs);
		if (!parsed.success)
			return this.#failure(name, "invalid-arguments", parsed.error.message, corr, "error", {}, callId);
		const args: unknown = parsed.data;
		const resolvedPaths: string[] = [];
		let resolving = "";
		try {
			for (const path of tool.paths?.(args) ?? []) {
				resolving = path;
				resolvedPaths.push(
					await resolveSandboxPath(projectRoot, path, {
						allowMissingLeaf: tool.resource === "write",
						// spill 豁免只给只读工具（ADR-9）：模型按结果里的路径回读超限输出的全文
						...(tool.resource === "read" && this.#options.spillDirectory
							? { spillDirectory: this.#options.spillDirectory }
							: {}),
					}),
				);
			}
		} catch (error) {
			// 原始 ENOENT 带着 realpath 与绝对路径，模型很难直接看出是哪个参数错了
			const message = isNotFound(error) ? `Path does not exist: ${resolving || "(unknown path)"}` : errorText(error);
			return this.#failure(name, isNotFound(error) ? "not-found" : "sandbox", message, corr, "error", {}, callId);
		}

		const executedArgs = tool.applyResolvedPaths ? tool.applyResolvedPaths(args, resolvedPaths) : args;
		const command = tool.command?.(args);
		const policy = createPolicy(this.#mode, this.#options.plan === true);
		// 风险分级只对带命令文本的工具生效；文件写入由路径沙箱与快照兜底
		const risk = command === undefined ? FILE_TOOL_RISK : assessCommandRisk(command);
		// denylist 三档一律硬拦截：档位只放弃「问」，不放弃「拦」。审批档位不能把已知的
		// 破坏性命令变成可执行——这与 Claude Code 的 bypass 断路器、Gemini CLI 的 deny 规则一致。
		if (command !== undefined && isDeniedCommand(command)) {
			return this.#failure(
				name,
				"denylist",
				"Command blocked by built-in denylist",
				corr,
				"limit.blocked",
				{ rule: "denylist", command: redactCommand(command) },
				callId,
			);
		}

		const access = policy.access[tool.resource];
		if (access === "deny")
			return this.#failure(
				name,
				"policy",
				`Tool ${name} is not allowed in ${policy.id} mode`,
				corr,
				"error",
				{},
				callId,
			);
		const approvalResult = await this.#approveIfRequired(tool, args, access, risk, command, corr, signal);
		if (!approvalResult.approved)
			return this.#failure(name, "approval", approvalResult.message, corr, "error", {}, callId);

		let snapshots: SnapshotTarget[] = [];
		if (resolvedPaths.length > 0 && tool.resource === "write" && policy.snapshot) {
			try {
				snapshots = await this.#snapshotBefore(resolvedPaths);
				await this.#options.snapshots.appendRecord(sessionId, {
					id: approvalResult.snapshotId,
					phase: "before",
					seq: callEvent.seq,
					files: snapshots.map((snapshot) => ({
						path: snapshot.relativePath,
						op: snapshot.before === null ? "create" : "modify",
						before: snapshot.before,
						after: null,
					})),
				});
			} catch (error) {
				return this.#failure(name, "snapshot", errorText(error), corr, "error", {}, callId);
			}
		}

		const startedAt = this.#now();
		const spillDirectory = this.#options.spillDirectory ?? join(tmpdir(), "moros-spill");
		const collector = new OutputCollector({
			threshold: this.#options.spillThreshold ?? 8192,
			directory: spillDirectory,
			name: `${callEvent.seq}-${name}`,
		});
		let streamedOutput = false;
		let result: ToolResult;
		try {
			result = await tool.execute(executedArgs, {
				toolCallId: callId,
				sessionId,
				projectRoot,
				policy,
				...(signal ? { signal } : {}),
				writeOutput: async (chunk) => {
					streamedOutput = true;
					this.#options.onToolOutput?.(callId, chunk);
					await collector.write(chunk);
				},
			});
		} catch (error) {
			result = { content: errorText(error), isError: true };
		}

		try {
			if (result.content) {
				if (!streamedOutput) await collector.write(result.content);
				else await collector.write(`\n${result.content}`);
			}
			const collected = await collector.finish();
			if (snapshots.length > 0)
				await this.#recordSnapshotAfter(
					snapshots,
					result.changedPaths ?? [],
					sessionId,
					corr,
					approvalResult.snapshotId,
				);
			const failed = result.isError ?? false;
			const elapsedMs = Math.max(0, this.#now() - startedAt);
			await events.append({
				type: "tool.result",
				corr,
				// spillPath 是结构化通道：审计与界面不必从结果文本里反解路径（§8.8）
				payload: {
					tool: name,
					result: collected.text,
					isError: failed,
					elapsedMs,
					toolCallId: callId,
					...(collected.spillPath === undefined ? {} : { spillPath: collected.spillPath }),
					...(collected.truncated ? { truncated: true } : {}),
				},
			});
			return { ...result, content: collected.text };
		} catch (error) {
			const collected = await collector.finish().catch(() => undefined);
			return this.#failure(
				name,
				"tool-finalization",
				errorText(error),
				corr,
				"error",
				collected?.spillPath ? { spillPath: collected.spillPath } : {},
				callId,
			);
		}
	}

	/** 回滚最近一次文件变更，并追加反向快照以支持再次回滚。 */
	async rollbackStep(): Promise<void> {
		const records = await this.#options.snapshots.readRecords(this.#options.sessionId);
		const record = [...records].reverse().find((entry) => entry.phase !== "before");
		if (!record) return;
		await this.#rollback(
			record.files.map((file) => ({ path: file.path, target: file.before, current: file.after })),
			"step",
		);
	}

	/**
	 * 恢复到指定快照记录（checkpoint）：把该记录里文件的 before 状态写回。
	 * @param id 快照记录 id。
	 * @returns 恢复与删除的文件数。
	 * @throws 记录不存在时抛出错误。
	 */
	async restoreCheckpoint(id: string): Promise<{ restored: number; removed: number }> {
		const records = await this.#options.snapshots.readRecords(this.#options.sessionId);
		const record = records.find((entry) => entry.id === id);
		if (!record) throw new Error(`Checkpoint ${id} does not exist`);
		await this.#rollback(
			record.files.map((file) => ({ path: file.path, target: file.before, current: file.after })),
			"step",
		);
		return {
			restored: record.files.filter((file) => file.before !== null).length,
			removed: record.files.filter((file) => file.before === null).length,
		};
	}

	/** 按首次快照状态恢复本会话全部已改文件。 */
	async rollbackTask(): Promise<void> {
		const records = await this.#options.snapshots.readRecords(this.#options.sessionId);
		const initial = new Map<string, { target: string | null; current: string | null }>();
		for (const record of records) {
			if (record.phase !== "before") continue;
			for (const file of record.files) {
				if (!initial.has(file.path)) initial.set(file.path, { target: file.before, current: null });
			}
		}
		await this.#rollback(
			[...initial].map(([path, value]) => ({ path, ...value })),
			"task",
		);
	}

	/**
	 * 审批闸门：按档位与命令风险决定放行、静默放行还是挂卡等人。
	 *
	 * - yolo：不问就放，但 denylist 已在前面硬拦；
	 * - auto：low/medium 按规则静默放行；high 先交模型审查，审查通过才放行，
	 *   审查拒绝或不可用（error）都退回人工——审查只减少打扰，不替代人；
	 * - ask：一律挂卡，风险等级随卡片展示，供使用者判断该不该点同意。
	 */
	async #approveIfRequired(
		tool: ToolDefinition,
		args: unknown,
		access: "allow" | "approve" | "deny",
		risk: RiskAssessment,
		command: string | undefined,
		corr: string,
		signal?: AbortSignal,
	): Promise<{ approved: boolean; message: string; snapshotId: string }> {
		const id = randomUUID();
		if (access !== "approve") return { approved: access === "allow", message: "Tool access denied", snapshotId: id };
		if (this.#approval === "yolo") return { approved: true, message: "", snapshotId: id };
		if (this.#approval === "auto" && isAutoApproved(risk.level)) {
			await this.#options.events.append({
				type: "approval.granted",
				corr,
				payload: { id, tool: tool.name, automatic: true, risk: risk.level, decisionMs: 0 },
			});
			return { approved: true, message: "", snapshotId: id };
		}
		let reviewNote: string | undefined;
		const reviewCommand = this.#options.reviewCommand;
		if (this.#approval === "auto" && reviewCommand !== undefined) {
			const verdict = await this.#review(reviewCommand, tool.name, command, risk, corr, signal);
			if (verdict.decision === "allow") {
				await this.#options.events.append({
					type: "approval.granted",
					corr,
					payload: { id, tool: tool.name, automatic: true, reviewed: true, risk: risk.level, decisionMs: 0 },
				});
				return { approved: true, message: "", snapshotId: id };
			}
			// 审查拒绝或不可用：把理由带给人工，让人带着审查意见再判断一次
			reviewNote = verdict.reason;
		}
		// 作用域 = 工具 + 命令前缀（shell）或工具名（其余），见 approval-scope.ts
		const scopeKey = approvalScope(tool.name, args).key;
		if (this.#sessionApproved.has(scopeKey)) {
			await this.#options.events.append({
				type: "approval.granted",
				corr,
				payload: { id, tool: tool.name, automatic: true, sessionApproved: true, risk: risk.level, decisionMs: 0 },
			});
			return { approved: true, message: "", snapshotId: id };
		}
		const request: ApprovalRequest = {
			id,
			tool: tool.name,
			args: redactArguments(args),
			reason:
				reviewNote === undefined
					? `Tool requires approval: ${tool.name} (${risk.level} risk · ${risk.rule})`
					: `Tool requires approval: ${tool.name} (${risk.level} risk · ${risk.rule}); reviewer: ${reviewNote}`,
			risk: risk.level,
		};
		await this.#options.events.append({ type: "approval.requested", corr, payload: request });
		const startedAt = this.#now();
		const decision = await requestApprovalWithTimeout(this.#options.requestApproval, request, signal);
		const sessionApproved = decision === "allow-session";
		if (sessionApproved) this.#sessionApproved.add(scopeKey);
		const approved = sessionApproved || decision === "allow";
		const decisionMs = Math.max(0, this.#now() - startedAt);
		await this.#options.events.append({
			type: approved ? "approval.granted" : "approval.denied",
			corr,
			payload: {
				id,
				tool: tool.name,
				decisionMs,
				risk: risk.level,
				...(sessionApproved ? { sessionApproved: true } : {}),
			},
		});
		return { approved, message: `Approval denied for ${tool.name}`, snapshotId: id };
	}

	/** 送审并把结论写进事件流；审查者抛错时按 error 收尾，调用方据此退回人工。 */
	async #review(
		reviewCommand: NonNullable<PipelineOptions["reviewCommand"]>,
		tool: string,
		command: string | undefined,
		risk: RiskAssessment,
		corr: string,
		signal?: AbortSignal,
	): Promise<ReviewVerdict> {
		const startedAt = this.#now();
		let verdict: ReviewVerdict;
		try {
			verdict = await reviewCommand({ tool, command: command ?? "", risk }, signal);
		} catch (error) {
			verdict = { decision: "error", reason: error instanceof Error ? error.message : "Review failed" };
		}
		await this.#options.events.append({
			type: "approval.reviewed",
			corr,
			payload: {
				tool,
				risk: risk.level,
				decision: verdict.decision,
				reason: verdict.reason,
				latencyMs: Math.max(0, this.#now() - startedAt),
				...(verdict.model === undefined ? {} : { model: verdict.model }),
			},
		});
		return verdict;
	}

	async #snapshotBefore(paths: readonly string[]): Promise<SnapshotTarget[]> {
		const snapshots: SnapshotTarget[] = [];
		for (const absolutePath of paths) {
			const relativePath = relative(this.#options.projectRoot, absolutePath);
			try {
				const before = await this.#options.snapshots.put(await readFile(absolutePath));
				snapshots.push({ absolutePath, relativePath, before });
			} catch (error) {
				if (!isMissingPath(error)) throw error;
				snapshots.push({ absolutePath, relativePath, before: null });
			}
		}
		return snapshots;
	}

	async #recordSnapshotAfter(
		snapshots: readonly SnapshotTarget[],
		changedPaths: readonly string[],
		sessionId: string,
		corr: string,
		snapshotId: string,
	): Promise<void> {
		const allowedPaths = new Map(snapshots.map((snapshot) => [snapshot.absolutePath, snapshot]));
		const changed: Array<{ snapshot: SnapshotTarget; after: string | null }> = [];
		for (const changedPath of changedPaths) {
			const absolutePath = await resolveSandboxPath(this.#options.projectRoot, changedPath, { allowMissingLeaf: true });
			const snapshot = allowedPaths.get(absolutePath);
			if (!snapshot) throw new Error("A write tool reported a path that was not snapshotted before execution");
			let after: string | null = null;
			try {
				after = await this.#options.snapshots.put(await readFile(absolutePath));
			} catch (error) {
				if (!isMissingPath(error)) throw error;
			}
			if (after === snapshot.before) continue;
			changed.push({ snapshot, after });
		}

		const files: Array<{
			path: string;
			op: "create" | "modify" | "delete";
			before: string | null;
			after: string | null;
		}> = [];
		for (const { snapshot, after } of changed) {
			const op: "create" | "modify" | "delete" =
				snapshot.before === null ? "create" : after === null ? "delete" : "modify";
			files.push({ path: snapshot.relativePath, op, before: snapshot.before, after });
			await this.#options.events.append({
				type: "file.changed",
				corr,
				payload: { path: snapshot.relativePath, op, before: snapshot.before, after, snapshotId },
			});
		}
		if (files.length > 0) {
			await this.#options.snapshots.appendRecord(sessionId, {
				id: snapshotId,
				phase: "after",
				seq: this.#options.events.lastSeq,
				files,
			});
		}
	}

	async #rollback(
		entries: readonly { path: string; target: string | null; current: string | null }[],
		scope: "step" | "task",
	): Promise<void> {
		// 预检（ADR-15）：先确认全部快照对象可读，再做任何写操作——中途撞坏对象会把
		// 工作区留在半恢复态，且反向记录与 rollback.done 都不会落盘
		for (const entry of entries) {
			if (entry.target !== null) await this.#options.snapshots.get(entry.target);
		}
		const inverseFiles: Array<{
			path: string;
			op: "create" | "modify" | "delete";
			before: string | null;
			after: string | null;
		}> = [];
		const rollbackSnapshotId = randomUUID();
		for (const entry of entries) {
			const path = await resolveSandboxPath(this.#options.projectRoot, entry.path, { allowMissingLeaf: true });
			let current: string | null = null;
			try {
				current = await this.#options.snapshots.put(await readFile(path));
			} catch (error) {
				if (!isMissingPath(error)) throw error;
			}
			if (entry.target === null) {
				await rm(path, { force: true });
			} else {
				await mkdir(dirname(path), { recursive: true });
				const temporary = `${path}.${randomUUID()}.rollback`;
				await writeFile(temporary, await this.#options.snapshots.get(entry.target), { flag: "wx" });
				await rename(temporary, path);
			}
			const op = current === null ? "create" : entry.target === null ? "delete" : "modify";
			inverseFiles.push({ path: entry.path, op, before: current, after: entry.target });
			await this.#options.events.append({
				type: "file.changed",
				payload: { path: entry.path, op, before: current, after: entry.target, snapshotId: rollbackSnapshotId },
			});
		}
		if (inverseFiles.length > 0) {
			await this.#options.snapshots.appendRecord(this.#options.sessionId, {
				id: rollbackSnapshotId,
				phase: "rollback",
				seq: this.#options.events.lastSeq,
				files: inverseFiles,
			});
		}
		await this.#options.events.append({
			type: "rollback.done",
			payload: { scope, files: entries.map((entry) => entry.path) },
		});
	}

	async #failure(
		tool: string,
		kind: string,
		message: string,
		corr: string,
		eventType: "error" | "limit.blocked" = "error",
		summary: Record<string, unknown> = {},
		toolCallId: string,
	): Promise<ToolResult> {
		if (eventType === "limit.blocked") {
			await this.#options.events.append({
				type: "limit.blocked",
				corr,
				payload: {
					rule: kind === "denylist" ? "denylist" : "rate-limit",
					kind,
					message,
					command: typeof summary.command === "string" ? summary.command : undefined,
				},
			});
		} else {
			await this.#options.events.append({ type: "error", corr, payload: { kind, message, recoverable: true } });
		}
		await this.#options.events.append({
			type: "tool.result",
			corr,
			payload: { tool, result: message, isError: true, elapsedMs: 0, toolCallId },
		});
		return { content: message, isError: true };
	}
}

async function requestApprovalWithTimeout(
	requestApproval: PipelineOptions["requestApproval"],
	request: ApprovalRequest,
	signal?: AbortSignal,
): Promise<ApprovalDecision> {
	if (!requestApproval) return "deny";
	if (signal?.aborted) return "deny";
	return new Promise((resolve) => {
		let settled = false;
		const finish = (approved: ApprovalDecision) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			signal?.removeEventListener("abort", abort);
			resolve(approved);
		};
		const abort = () => finish("deny");
		const timeout = setTimeout(() => finish("deny"), 120_000);
		signal?.addEventListener("abort", abort, { once: true });
		requestApproval(request, signal).then(finish, () => finish("deny"));
	});
}

function isDeniedCommand(command: string): boolean {
	const normalized = command
		.replace(/\\\\[\s\S]/g, " ")
		.replace(/#[^\r\n]*/g, " ")
		.replace(/[\r\n]+/g, ";")
		.replace(/\s+/g, " ")
		.toLowerCase();
	const segments = normalized
		.split(/[;&|]+/)
		.map((segment) => segment.trim())
		.filter(Boolean);
	return segments.some((segment) =>
		DENYLIST.some((pattern) => {
			const normalizedPattern = pattern.toLowerCase();
			return (
				segment === normalizedPattern ||
				segment.startsWith(`${normalizedPattern} `) ||
				micromatch.isMatch(segment, normalizedPattern)
			);
		}),
	);
}

function redactCommand(command: string): string {
	return command.replace(/(api[_-]?key|token|password)=\S+/gi, "$1=***");
}

function redactArguments(value: unknown, key = ""): unknown {
	if (typeof value === "string") {
		if (/api.?key|secret|token|password/i.test(key)) return "***";
		return redactCommand(value);
	}
	if (Array.isArray(value)) return value.map((item) => redactArguments(item));
	if (!value || typeof value !== "object") return value;
	return Object.fromEntries(
		Object.entries(value).map(([childKey, child]) => [childKey, redactArguments(child, childKey)]),
	);
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : "Tool execution failed";
}
