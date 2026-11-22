import { z } from "zod";

const modeSchema = z.enum(["standard", "creator"]);
const EventBaseSchema = z.object({
	seq: z.number().int().positive(),
	ts: z.string().datetime({ offset: true }),
	corr: z.string().optional(),
});

const UserInputImageSchema = z.object({
	attachmentId: z.string().min(1),
	mediaType: z.enum(["image/png", "image/jpeg", "image/webp", "image/gif"]),
	width: z.number().int().positive(),
	height: z.number().int().positive(),
	bytes: z.number().int().positive(),
	/** 网络图片的来源；本地上传的附件没有该字段。只做审计，不参与渲染与请求。 */
	sourceUrl: z.string().min(1).max(4096).optional(),
});

/** user.input 事件中持久化的图片附件元数据；二进制数据单独存储。 */
export type UserInputImage = z.infer<typeof UserInputImageSchema>;

/**
 * 按事件类型校验 payload 的判别联合，防止持久化无效事件。
 */
export const EventSchema = z.discriminatedUnion("type", [
	EventBaseSchema.extend({
		type: z.literal("session.created"),
		payload: z.object({
			title: z.string(),
			projectRoot: z.string(),
			mode: modeSchema,
			forkedFrom: z
				.string()
				.regex(/^[A-Za-z0-9_-]+$/)
				.optional(),
		}),
	}),
	EventBaseSchema.extend({ type: z.literal("mode.switched"), payload: z.object({ from: modeSchema, to: modeSchema }) }),
	EventBaseSchema.extend({
		type: z.literal("model.changed"),
		payload: z.object({
			/** 旧模型的显示名（模型配置的 name，缺省为 ID）。 */
			from: z.string(),
			/** 新模型的显示名。 */
			to: z.string(),
			/** 旧模型的 provider/model 标识，用于审计与诊断。 */
			fromModel: z.string(),
			/** 新模型的 provider/model 标识。 */
			toModel: z.string(),
			/** 切换发生在回合运行中：模型在下一轮生效，分隔线延后到下一轮显示。 */
			appliesNextTurn: z.boolean(),
		}),
	}),
	EventBaseSchema.extend({ type: z.literal("session.renamed"), payload: z.object({ title: z.string().min(1) }) }),
	EventBaseSchema.extend({ type: z.literal("session.archived"), payload: z.object({ archived: z.boolean() }) }),
	EventBaseSchema.extend({
		type: z.literal("user.input"),
		payload: z.object({ text: z.string(), images: z.array(UserInputImageSchema).optional() }),
	}),
	EventBaseSchema.extend({
		type: z.literal("llm.request"),
		payload: z.object({
			endpoint: z.string(),
			model: z.string(),
			/** 发起请求的路由供应商。旧事件缺失；会话重开时据此折叠恢复会话级模型选择。 */
			provider: z.string().optional(),
			/** 请求使用的推理档位。缺失（旧事件或未配置）时不恢复会话级档位覆盖。 */
			reasoningEffort: z.enum(["off", "minimal", "low", "medium", "high", "max"]).optional(),
			messageCount: z.number().int().nonnegative(),
		}),
	}),
	EventBaseSchema.extend({
		type: z.literal("llm.response"),
		payload: z.object({
			text: z.string(),
			/** 模型推理链全文；供应商未回传或缺省时界面不渲染推理块。 */
			reasoning: z.string().optional(),
			toolCalls: z.array(z.unknown()),
			usage: z.object({
				inputTokens: z.number(),
				outputTokens: z.number(),
				cacheReadTokens: z.number().optional(),
				cacheWriteTokens: z.number().optional(),
			}),
			stopReason: z.string(),
		}),
	}),
	EventBaseSchema.extend({
		type: z.literal("tool.call"),
		payload: z.object({ tool: z.string(), args: z.unknown(), toolCallId: z.string() }),
	}),
	EventBaseSchema.extend({
		type: z.literal("tool.result"),
		payload: z.object({
			tool: z.string(),
			result: z.string(),
			isError: z.boolean(),
			toolCallId: z.string(),
			elapsedMs: z.number().nonnegative().optional(),
			spillPath: z.string().optional(),
			truncated: z.boolean().optional(),
		}),
	}),
	EventBaseSchema.extend({
		type: z.literal("approval.requested"),
		// risk 为可选：引入风险分级之前的历史会话没有这个字段，回放时必须仍能解析
		payload: z.object({
			id: z.string(),
			tool: z.string(),
			args: z.unknown(),
			reason: z.string(),
			risk: z.enum(["low", "medium", "high"]).optional(),
		}),
	}),
	EventBaseSchema.extend({
		type: z.literal("approval.granted"),
		payload: z.object({
			id: z.string().optional(),
			tool: z.string(),
			automatic: z.boolean().optional(),
			sessionApproved: z.boolean().optional(),
			/** 由模型审查放行（auto 档 high 风险走的路径）。 */
			reviewed: z.boolean().optional(),
			risk: z.enum(["low", "medium", "high"]).optional(),
			decisionMs: z.number().nonnegative(),
		}),
	}),
	EventBaseSchema.extend({
		type: z.literal("approval.denied"),
		payload: z.object({
			id: z.string(),
			tool: z.string(),
			risk: z.enum(["low", "medium", "high"]).optional(),
			decisionMs: z.number().nonnegative(),
		}),
	}),
	EventBaseSchema.extend({
		type: z.literal("approval.reviewed"),
		payload: z.object({
			tool: z.string(),
			risk: z.enum(["low", "medium", "high"]),
			decision: z.enum(["allow", "deny", "error"]),
			reason: z.string(),
			model: z.string().optional(),
			latencyMs: z.number().nonnegative().optional(),
		}),
	}),
	EventBaseSchema.extend({
		type: z.literal("file.changed"),
		payload: z.object({
			path: z.string(),
			op: z.enum(["create", "modify", "delete"]),
			before: z.string().nullable(),
			after: z.string().nullable(),
			snapshotId: z.string(),
		}),
	}),
	EventBaseSchema.extend({
		type: z.literal("rollback.done"),
		payload: z.object({ scope: z.enum(["step", "task"]), files: z.array(z.string()) }),
	}),
	EventBaseSchema.extend({
		type: z.literal("breakpoint.paused"),
		payload: z.object({ reason: z.enum(["user", "circuit-break", "turn-limit"]) }),
	}),
	EventBaseSchema.extend({
		type: z.literal("breakpoint.resumed"),
		payload: z.object({ reason: z.enum(["user", "circuit-break", "turn-limit"]) }),
	}),
	EventBaseSchema.extend({
		type: z.literal("compaction.done"),
		payload: z.object({
			fromSeq: z.number().int().nonnegative(),
			toSeq: z.number().int().nonnegative(),
			summaryChars: z.number().int().nonnegative(),
			compactedTokens: z.number().int().nonnegative().optional(),
			summary: z.string(),
		}),
	}),
	EventBaseSchema.extend({
		type: z.literal("subagent.started"),
		payload: z.object({ toolCallId: z.string(), task: z.string() }),
	}),
	EventBaseSchema.extend({
		type: z.literal("subagent.finished"),
		payload: z.object({
			toolCallId: z.string(),
			steps: z.number().int().nonnegative(),
			totalTokens: z.number().int().nonnegative(),
			durationMs: z.number().nonnegative(),
			ok: z.boolean(),
			paused: z.boolean(),
			preview: z.string(),
		}),
	}),
	EventBaseSchema.extend({
		type: z.literal("limit.blocked"),
		payload: z.object({
			rule: z.enum(["denylist", "rate-limit"]).optional(),
			kind: z.string().optional(),
			message: z.string().optional(),
			command: z.string().optional(),
		}),
	}),
	EventBaseSchema.extend({
		type: z.literal("error"),
		payload: z.object({ kind: z.string(), message: z.string(), recoverable: z.boolean() }),
	}),
]);

export const EVENT_TYPES = [
	"session.created",
	"mode.switched",
	"model.changed",
	"session.renamed",
	"session.archived",
	"user.input",
	"llm.request",
	"llm.response",
	"tool.call",
	"tool.result",
	"approval.requested",
	"approval.granted",
	"approval.denied",
	"approval.reviewed",
	"file.changed",
	"rollback.done",
	"breakpoint.paused",
	"breakpoint.resumed",
	"compaction.done",
	"subagent.started",
	"subagent.finished",
	"limit.blocked",
	"error",
] as const;

export type EventRecord = z.infer<typeof EventSchema>;
export type EventType = EventRecord["type"];
export type NewEvent = {
	[Type in EventType]: Omit<Extract<EventRecord, { type: Type }>, "seq" | "ts"> & { ts?: string };
}[EventType];

/**
 * 校验并解析从事件文件读取的外部 JSON。
 * @param value 待解析的 JSON 值。
 * @returns 通过 schema 校验的事件记录。
 * @throws 当事件类型、payload 或元数据无效时抛出 ZodError。
 */
export function parseEvent(value: unknown): EventRecord {
	return EventSchema.parse(value);
}
