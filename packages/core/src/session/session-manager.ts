import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rm, rmdir, stat } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { z } from "zod";

import { atomicWriteFile } from "../atomic-file.ts";
import { EventStore } from "./event-store.ts";
import { normalizeProjectRoot, projectDirName } from "./project-dir.ts";
import { createSessionId, type RandomBytes } from "./session-id.ts";
import {
	DEFAULT_SESSION_TITLE,
	firstLine,
	firstUserTextFromLines,
	isUnnamedSessionTitle,
	resolveSessionTitle,
	sanitizeSessionTitle,
} from "./session-title.ts";
import { EventSchema } from "../events/schema.ts";
import type { EventRecord, NewEvent } from "../events/schema.ts";
import { isMissingPath, isExists } from "../fs-error.ts";

const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

const SessionMetaSchema = z.object({
	id: z.string().regex(SESSION_ID_PATTERN),
	title: z.string(),
	projectRoot: z.string(),
	createdAt: z.string().datetime({ offset: true }),
	/** 最后活动时间：事件流末条事件的 ts，列表排序与会话菜单的时间列都用它。 */
	updatedAt: z.string().datetime({ offset: true }),
	mode: z.enum(["standard", "creator"]),
	/** 归档标记：列表默认隐藏，事件流仍是唯一事实源。 */
	archived: z.boolean().default(false),
	forkedFrom: z
		.string()
		.regex(/^[A-Za-z0-9_-]+$/)
		.optional(),
});

/** 列表投影：改名与归档写入旁路文件，避免列表扫描全量事件。 */
const SessionStateSchema = z.object({
	title: z.string().min(1).optional(),
	archived: z.boolean().optional(),
});

type SessionState = z.infer<typeof SessionStateSchema>;

export type SessionMeta = z.infer<typeof SessionMetaSchema>;

/** 会话目录内的事件流文件名；会话元数据的唯一来源是这里的事件。 */
const STREAM_FILENAME = "stream.jsonl";
/** 改名/归档的列表投影文件名；缺失时回退到事件流派生。 */
const STATE_FILENAME = "session.state.json";
/** 头部窗口：首条 user.input 恒在 seq 2~3，16 KB 足够容纳带图片元数据的长首条消息。 */
const HEAD_WINDOW_BYTES = 16 * 1024;
/** 尾部窗口：取末条事件的 ts 作为最后活动时间。 */
const TAIL_WINDOW_BYTES = 8 * 1024;

/** 管理单个会话的元数据视图与事件追加入口。 */
export class Session {
	readonly events: EventStore;
	readonly meta: SessionMeta;
	/** 会话目录：附件、报告等边车文件都放在该目录下。 */
	readonly directory: string;

	constructor(meta: SessionMeta, events: EventStore, directory: string) {
		this.meta = meta;
		this.events = events;
		this.directory = directory;
	}

	/** 追加一个通过 schema 校验的领域事件。 */
	append(event: NewEvent): Promise<EventRecord> {
		return this.events.append(event);
	}
}

export interface SessionManagerOptions {
	readonly now?: () => Date;
	/** 会话 ID 的随机字节源；缺省走 `node:crypto.randomBytes`，测试可注入固定值。 */
	readonly randomBytes?: RandomBytes;
	readonly onRecoveryWarning?: (message: string) => void;
}

/**
 * 管理本地会话存储：按项目目录组织、一个会话一个目录、元数据由事件流派生。
 *
 * 布局：`<root>/sessions/<项目哈希>/<会话ID>/stream.jsonl`。项目目录名由项目路径确定性
 * 派生（projectDirName），启动时无需扫描即可定位；`<id>` 目录内是会话的全部文件。
 * 会话 ID 是 26 字符小写 ULID（session-id.ts）；旧版 17 位本地时间戳目录名仍
 * 能被 `open` / `list` 读回，两者可混存。旧布局（`<root>/sessions/<id>/events.jsonl`）
 * 不再读取，扫描时自然跳过。
 */
export class SessionManager {
	readonly #root: string;
	readonly #now: () => Date;
	readonly #random: RandomBytes | undefined;
	readonly #onRecoveryWarning: (message: string) => void;

	constructor(root: string, options: SessionManagerOptions = {}) {
		this.#root = root;
		this.#now = options.now ?? (() => new Date());
		this.#random = options.randomBytes;
		this.#onRecoveryWarning = options.onRecoveryWarning ?? (() => undefined);
	}

	/** 创建项目目录下的新会话目录并追加 session.created 事件。 */
	async create(
		projectRoot: string,
		options: { mode?: "standard" | "creator"; title?: string; id?: string; forkedFrom?: string } = {},
	): Promise<Session> {
		const resolvedRoot = resolve(projectRoot);
		const projectDirectory = join(this.#root, "sessions", projectDirName(resolvedRoot));
		const id = await this.#reserveSessionDirectory(
			projectDirectory,
			options.id ?? createSessionId(this.#now(), this.#random),
			options.id === undefined,
		);
		const now = this.#now();
		const meta = SessionMetaSchema.parse({
			id,
			title: options.title ?? DEFAULT_SESSION_TITLE,
			projectRoot: resolvedRoot,
			createdAt: now.toISOString(),
			updatedAt: now.toISOString(),
			mode: options.mode ?? "creator",
			...(options.forkedFrom === undefined ? {} : { forkedFrom: options.forkedFrom }),
		});
		const directory = join(projectDirectory, id);
		const session = new Session(meta, this.#createEventStore(directory), directory);
		await session.append({
			type: "session.created",
			payload: {
				title: meta.title,
				projectRoot: resolvedRoot,
				mode: meta.mode,
				...(meta.forkedFrom === undefined ? {} : { forkedFrom: meta.forkedFrom }),
			},
		});
		return session;
	}

	/**
	 * 打开会话：按 ID 在所有项目目录中定位会话目录，加载事件流并从中派生元数据。
	 * @throws ID 非法或会话不存在时抛出错误；事件流损坏（seq 不连续）由 EventStore 校验抛出。
	 */
	async open(id: string): Promise<Session> {
		const directory = await this.#locateSessionDirectory(id);
		const events = this.#createEventStore(directory);
		await events.load();
		const meta = deriveSessionMeta(id, await events.read());
		return new Session(meta, events, directory);
	}

	/**
	 * 修改会话标题：追加 `session.renamed` 事件并更新列表投影。
	 * @param session 目标会话。
	 * @param title 新标题（控制字符已清洗，最长 60 码位）。
	 * @throws 标题为空时抛出错误。
	 */
	async rename(session: Session, title: string): Promise<void> {
		const clean = firstLine(sanitizeSessionTitle(title)).replace(/\s+/g, " ");
		if (clean.length === 0) throw new Error("Session title must not be empty");
		await session.append({ type: "session.renamed", payload: { title: clean } });
		await this.#writeState(session.directory, { title: clean });
	}

	/**
	 * 会话是否可被 LLM 自动命名：无显式命名投影（state.title）且 created 标题是
	 * 「未命名」哨兵。用户改名与后台生成都会写入 state.title；fork（Fork of …）、
	 * Code review、Subagent task 等创建即命名的会话由 created 标题排除。
	 * 后台标题任务在调度与写回前各检查一次；写回前的复查即改名竞态的 CAS。
	 */
	async isAutoTitleable(session: Session): Promise<boolean> {
		const state = await this.#readState(session.directory);
		if (state.title !== undefined) return false;
		const createdTitle = await this.#readCreatedTitle(session.directory);
		return createdTitle !== undefined && isUnnamedSessionTitle(createdTitle);
	}

	/** 只读流首行取 created 标题；缺失或损坏时返回 undefined（宁可跳过命名也不误接管）。 */
	async #readCreatedTitle(directory: string): Promise<string | undefined> {
		try {
			const handle = await open(join(directory, STREAM_FILENAME), "r");
			try {
				const head = await handle.read(Buffer.alloc(HEAD_WINDOW_BYTES), 0, HEAD_WINDOW_BYTES, 0);
				const firstLineText = head.buffer.subarray(0, head.bytesRead).toString("utf8").split("\n", 1)[0] ?? "";
				const event = EventSchema.parse(JSON.parse(firstLineText));
				return event.type === "session.created" ? event.payload.title : undefined;
			} finally {
				await handle.close();
			}
		} catch {
			return undefined;
		}
	}

	/**
	 * 归档或取消归档会话：追加事件并更新列表投影。
	 * @param session 目标会话。
	 * @param archived 是否归档。
	 */
	async archive(session: Session, archived: boolean): Promise<void> {
		await session.append({ type: "session.archived", payload: { archived } });
		await this.#writeState(session.directory, { archived });
	}

	/**
	 * 把用户输入的会话标识解析成完整 ID：精确命中优先，否则尝试唯一前缀匹配。
	 *
	 * 26 位 ULID 手输成本高，CLI 与 TUI 都可以只给前几位；歧义时列出全部候选，
	 * 让调用方提示用户补长前缀，不擅自选一个。精确命中只做目录定位，不读事件流。
	 */
	async resolveId(spec: string): Promise<string> {
		if (!SESSION_ID_PATTERN.test(spec)) throw new Error("Invalid session id");
		try {
			await this.#locateSessionDirectory(spec);
			return spec;
		} catch {
			// 精确 ID 不存在，继续做前缀匹配
		}
		const matches = (await this.list()).filter((meta) => meta.id.startsWith(spec));
		const [only] = matches;
		if (matches.length === 1 && only !== undefined) return only.id;
		if (matches.length === 0) throw new Error(`Session ${spec} does not exist`);
		throw new Error(`Ambiguous session prefix "${spec}": ${matches.map((meta) => meta.id).join(", ")}`);
	}

	/**
	 * 列出本地会话元数据，按最后活动时间升序。
	 *
	 * 每个会话只读事件流头部与尾部各一小块：首行派生标题与项目，尾行给出最后活动时间，
	 * 不读全量事件流。
	 * @param projectRoot 提供时按项目哈希直查目录，只返回该项目的会话。
	 */
	async list(projectRoot?: string): Promise<SessionMeta[]> {
		const sessionsRoot = join(this.#root, "sessions");
		let entries: Dirent[];
		try {
			entries = await readdir(sessionsRoot, { withFileTypes: true });
		} catch (error) {
			if (isMissingPath(error)) return [];
			// 目录级读取失败（EACCES/EPERM 等）降级为空列表并告警，不把调用方（含 TUI 启动）炸死
			this.#onRecoveryWarning(`Cannot read sessions directory ${sessionsRoot}: ${errorText(error)}`);
			return [];
		}
		const normalized = projectRoot ? normalizeProjectRoot(projectRoot) : undefined;
		const projectDirectories = projectRoot
			? [join(sessionsRoot, projectDirName(projectRoot))]
			: entries.filter((entry) => entry.isDirectory()).map((entry) => join(sessionsRoot, entry.name));
		const metas: SessionMeta[] = [];
		for (const projectDirectory of projectDirectories) {
			let children: Dirent[];
			try {
				children = await readdir(projectDirectory, { withFileTypes: true });
			} catch (error) {
				if (isMissingPath(error)) continue;
				// 单个项目目录不可读只牺牲该项目：其余项目的会话照常列出
				this.#onRecoveryWarning(`Cannot read project session directory ${projectDirectory}: ${errorText(error)}`);
				continue;
			}
			for (const child of children) {
				if (!child.isDirectory()) continue;
				const meta = await this.#tryReadMeta(join(projectDirectory, child.name), child.name);
				if (!meta) continue;
				// 哈希碰撞兜底：同目录可能混入其他项目的会话（概率可忽略），按明文路径过滤
				if (normalized && normalizeProjectRoot(meta.projectRoot) !== normalized) continue;
				metas.push(meta);
			}
		}
		// 最后活动越晚越靠后：--last 取末尾一项，TUI 反转后即「最近使用的在最前」。
		return metas.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
	}

	/**
	 * 删除会话：整个会话目录直接销毁，不保留回收站；项目目录变空后顺带回收，
	 * 避免反复新建/清理空会话留下大量空壳。
	 * @throws 会话不存在时抛出错误。
	 */
	async delete(id: string): Promise<void> {
		const directory = await this.#locateSessionDirectory(id);
		await rm(directory, { recursive: true });
		const projectDirectory = dirname(directory);
		try {
			if ((await readdir(projectDirectory)).length === 0) await rmdir(projectDirectory);
		} catch {
			// 并发创建/删除可能让目录非空或已被别的进程回收；清理是 best-effort，
			// 不影响「会话已删除」这个结果
		}
	}

	/**
	 * 返回会话目录路径；附件、报告等边车文件都放在该目录下。
	 * @throws 会话不存在时抛出错误。
	 */
	async directory(id: string): Promise<string> {
		return this.#locateSessionDirectory(id);
	}

	/**
	 * 从源会话分叉出新会话：新会话以独立的 session.created 开头（带 forkedFrom），
	 * 随后复制源会话 seq ≤ uptoSeq 的其余事件；seq 由新事件流重新编号，ts 保留原始时间。
	 * 源会话不受影响。
	 * @param source 源会话句柄。
	 * @param uptoSeq 复制到的事件序号；缺省复制全部。
	 * @returns 新会话与复制的事件条数。
	 */
	async fork(source: Session, uptoSeq?: number): Promise<{ session: Session; copied: number }> {
		const events = await source.events.read();
		const lastSeq = events.at(-1)?.seq ?? 0;
		const limit = uptoSeq === undefined ? lastSeq : Math.max(0, Math.min(uptoSeq, lastSeq));
		const toCopy = events.filter((event) => event.seq > 1 && event.seq <= limit);
		const session = await this.create(source.meta.projectRoot, {
			mode: source.meta.mode,
			title: `Fork of ${source.meta.title}`,
			forkedFrom: source.meta.id,
		});
		for (const event of toCopy) {
			// type 与 payload 来自同一条已通过 EventSchema 校验的记录，这里只是原样重新配对
			await session.append({
				type: event.type,
				payload: event.payload,
				...(event.corr === undefined ? {} : { corr: event.corr }),
				ts: event.ts,
			} as NewEvent);
		}
		return { session, copied: toCopy.length };
	}

	/**
	 * 预留会话目录并返回确定的会话 ID。
	 * ULID 的 80 位随机段让撞名几乎不可能发生；万一撞上（或测试注入了固定随机源），
	 * 默认生成的 ID 追加随机后缀重试，显式指定 ID 已存在则直接报错。
	 */
	async #reserveSessionDirectory(projectDirectory: string, requestedId: string, allowSuffix: boolean): Promise<string> {
		if (!SESSION_ID_PATTERN.test(requestedId)) throw new Error("Invalid session id");
		await mkdir(projectDirectory, { recursive: true });
		let candidate = requestedId;
		for (;;) {
			try {
				await mkdir(join(projectDirectory, candidate), { recursive: false });
				return candidate;
			} catch (error) {
				if (!isExists(error)) throw error;
				if (!allowSuffix) throw new Error(`Session ${requestedId} already exists`);
				candidate = `${requestedId}-${randomUUID().slice(0, 4)}`;
			}
		}
	}

	/** 在所有项目目录中定位会话目录；旧布局没有二级会话目录，不会命中。 */
	async #locateSessionDirectory(id: string): Promise<string> {
		if (!SESSION_ID_PATTERN.test(id)) throw new Error("Invalid session id");
		const sessionsRoot = join(this.#root, "sessions");
		let entries: Dirent[];
		try {
			entries = await readdir(sessionsRoot, { withFileTypes: true });
		} catch (error) {
			if (isMissingPath(error)) throw new Error(`Session ${id} does not exist`);
			throw error;
		}
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			const candidate = join(sessionsRoot, entry.name, id);
			try {
				const info = await stat(candidate);
				if (info.isDirectory()) return candidate;
			} catch {
				// 不存在则继续找下一个项目目录
			}
		}
		throw new Error(`Session ${id} does not exist`);
	}

	/**
	 * 只读事件流头部与尾部各一小块派生列表元数据；文件缺失、损坏或首行不是
	 * session.created 的会话被跳过。头部窗口同时给出首条 user.input（派生标题），
	 * 尾行给出「最后活动时间」（排序键）。全程两次 read、不读全量事件流，也不依赖
	 * 文件 mtime（复制/备份会篡改 mtime）。
	 */
	async #tryReadMeta(directory: string, id: string): Promise<SessionMeta | undefined> {
		let headText = "";
		let updatedAt: string | undefined;
		try {
			const handle = await open(join(directory, STREAM_FILENAME), "r");
			try {
				const head = await handle.read(Buffer.alloc(HEAD_WINDOW_BYTES), 0, HEAD_WINDOW_BYTES, 0);
				headText = head.buffer.subarray(0, head.bytesRead).toString("utf8");
				const info = await handle.stat();
				const tailSize = Math.min(info.size, TAIL_WINDOW_BYTES);
				const tail = await handle.read(Buffer.alloc(tailSize), 0, tailSize, Math.max(0, info.size - tailSize));
				updatedAt = lastEventTimestamp(tail.buffer.subarray(0, tail.bytesRead));
			} finally {
				await handle.close();
			}
			const lines = headText.split("\n");
			const event = EventSchema.parse(JSON.parse(lines[0] ?? ""));
			if (event.type !== "session.created") {
				// 首行不是 session.created：目录存在但流损坏，静默跳过会让会话无声消失（ADR-15）
				this.#onRecoveryWarning(
					`Skipped session directory ${directory}: first event is ${event.type || "invalid"}, not session.created`,
				);
				return undefined;
			}
			const state = await this.#readState(directory);
			return SessionMetaSchema.parse({
				id,
				title: state.title ?? resolveSessionTitle(event.payload.title, firstUserTextFromLines(lines)),
				projectRoot: event.payload.projectRoot,
				createdAt: event.ts,
				updatedAt: updatedAt ?? event.ts,
				mode: event.payload.mode,
				archived: state.archived ?? false,
				...(event.payload.forkedFrom === undefined ? {} : { forkedFrom: event.payload.forkedFrom }),
			});
		} catch (error) {
			// 目录/流缺失是正常状态（未建会话）；其余读取或校验失败跳过前先告警，给用户留下诊断痕迹
			if (!isMissingPath(error)) {
				this.#onRecoveryWarning(`Skipped session directory ${directory}: ${errorText(error)}`);
			}
			return undefined;
		}
	}

	#createEventStore(directory: string): EventStore {
		return new EventStore(join(directory, STREAM_FILENAME), {
			now: this.#now,
			onRecoveryWarning: this.#onRecoveryWarning,
		});
	}

	/** 读取列表投影；缺失或损坏时返回空对象，事件流仍是权威来源。 */
	async #readState(directory: string): Promise<SessionState> {
		try {
			return SessionStateSchema.parse(JSON.parse(await readFile(join(directory, STATE_FILENAME), "utf8")));
		} catch {
			return {};
		}
	}

	/** 合并写列表投影（原子替换）。 */
	async #writeState(directory: string, patch: SessionState): Promise<void> {
		const current = await this.#readState(directory);
		await atomicWriteFile(join(directory, STATE_FILENAME), `${JSON.stringify({ ...current, ...patch })}\n`);
	}
}

/** 从完整事件流派生会话元数据；缺少 session.created 视为存储损坏。 */
function deriveSessionMeta(id: string, events: readonly EventRecord[]): SessionMeta {
	const created = events.find(
		(event): event is Extract<EventRecord, { type: "session.created" }> => event.type === "session.created",
	);
	if (!created) throw new Error(`Session ${id} is missing a session.created event`);
	const firstUser = events.find(
		(event): event is Extract<EventRecord, { type: "user.input" }> => event.type === "user.input",
	);
	let title = resolveSessionTitle(created.payload.title, firstUser?.payload.text);
	let mode = created.payload.mode;
	let archived = false;
	for (const event of events) {
		if (event.type === "mode.switched") mode = event.payload.to;
		if (event.type === "session.renamed") title = event.payload.title;
		if (event.type === "session.archived") archived = event.payload.archived;
	}
	return SessionMetaSchema.parse({
		id,
		title,
		projectRoot: created.payload.projectRoot,
		createdAt: created.ts,
		updatedAt: events.at(-1)?.ts ?? created.ts,
		mode,
		archived,
		...(created.payload.forkedFrom === undefined ? {} : { forkedFrom: created.payload.forkedFrom }),
	});
}

/**
 * 从事件流尾部字节里找最后一条完整 JSONL 记录的 ts。
 * 尾部是从任意字节位置截取的，首行可能是半条记录；从后往前逐行尝试解析即可，
 * 崩溃留下的不完整尾行也会被跳过。
 */
function lastEventTimestamp(bytes: Buffer): string | undefined {
	const lines = bytes.toString("utf8").split("\n");
	for (let index = lines.length - 1; index >= 0; index -= 1) {
		const line = lines[index] ?? "";
		if (line.length === 0) continue;
		try {
			const raw: unknown = JSON.parse(line);
			if (typeof raw === "object" && raw !== null && "ts" in raw && typeof raw.ts === "string") {
				return raw.ts;
			}
		} catch {
			// 截断的半行，继续往前找
		}
	}
	return undefined;
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
