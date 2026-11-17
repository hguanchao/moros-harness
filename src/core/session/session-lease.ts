import { randomUUID } from "node:crypto";
import { open, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** 会话目录里的租约文件名；与 stream.jsonl 同级。 */
const LEASE_FILENAME = "session.lock";

/** 默认心跳间隔：每 5 秒刷新一次占用者时间。 */
const DEFAULT_HEARTBEAT_MS = 5_000;

/** 默认过期时间：30 秒没有心跳视为持有者已失联（崩溃、断电、被强杀）。 */
const DEFAULT_STALE_MS = 30_000;

/** 租约持有者信息；写入锁文件，冲突时原样回给调用方。 */
export interface SessionLeaseOwner {
	/** 持有进程的 PID。 */
	readonly pid: number;
	/** 进程内唯一令牌，区分同一 PID 的多个 Core 实例。 */
	readonly token: string;
	/** 占用开始时间（ISO）。 */
	readonly startedAt: string;
	/** 最近一次心跳时间（ISO）。 */
	readonly heartbeatAt: string;
	/** 宿主类型，仅用于诊断文案（tui / test）。 */
	readonly host?: string;
}

/** 会话已被另一个进程或窗口占用。 */
export class SessionBusyError extends Error {
	readonly owner: SessionLeaseOwner;

	constructor(sessionId: string, owner: SessionLeaseOwner) {
		super(`Session ${sessionId} is in use by ${owner.host ?? "another process"} (pid ${owner.pid})`);
		this.name = "SessionBusyError";
		this.owner = owner;
	}
}

export interface SessionLeaseOptions {
	/** 覆盖 PID，测试注入用。 */
	readonly pid?: number;
	/** 覆盖令牌，测试注入用。 */
	readonly token?: string;
	/** 覆盖时钟，测试过期逻辑用。 */
	readonly now?: () => Date;
	/** 心跳间隔毫秒。 */
	readonly heartbeatMs?: number;
	/** 过期阈值毫秒。 */
	readonly staleMs?: number;
	/** 占用者类型，写入诊断信息。 */
	readonly host?: string;
	/** 强制接管：忽略现有锁并覆盖。 */
	readonly force?: boolean;
}

/**
 * 会话目录级独占租约。
 *
 * 事件流是「读最后一条 → 分配下一个 seq → 追加」，跨进程没有锁时两个窗口会写出重复
 * seq，回放直接损坏。租约用独占创建（`wx`）保证只有一个写入者，靠定时心跳标活；
 * 持有者崩溃后心跳停止，超过阈值即可被后来者接管。锁失败时抛 `SessionBusyError`，
 * 由宿主提示用户关闭另一个窗口或显式强制接管。
 *
 * 锁文件是会话目录里的旁路文件，不进入事件流，也不参与导出。
 */
export class SessionLease {
	readonly #path: string;
	readonly #staleMs: number;
	readonly #heartbeatMs: number;
	#owner: SessionLeaseOwner;
	#timer: NodeJS.Timeout | undefined;
	#released = false;

	private constructor(path: string, owner: SessionLeaseOwner, options: SessionLeaseOptions) {
		this.#path = path;
		this.#owner = owner;
		this.#staleMs = options.staleMs ?? DEFAULT_STALE_MS;
		this.#heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
	}

	/** 当前持有者快照。 */
	get owner(): SessionLeaseOwner {
		return { ...this.#owner };
	}

	/**
	 * 获取会话租约；被占用且未过期时抛 `SessionBusyError`。
	 * @param directory 会话目录。
	 * @param sessionId 会话 ID，只用于报错。
	 * @param options 时钟、PID、强制接管等可注入项。
	 */
	static async acquire(directory: string, sessionId: string, options: SessionLeaseOptions = {}): Promise<SessionLease> {
		const path = join(directory, LEASE_FILENAME);
		const now = options.now ?? (() => new Date());
		const pid = options.pid ?? process.pid;
		const owner: SessionLeaseOwner = {
			pid,
			token: options.token ?? randomUUID(),
			startedAt: now().toISOString(),
			heartbeatAt: now().toISOString(),
			...(options.host === undefined ? {} : { host: options.host }),
		};

		const attempt = async (): Promise<SessionLease | undefined> => {
			let handle: Awaited<ReturnType<typeof open>>;
			try {
				handle = await open(path, "wx");
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
				return undefined;
			}
			try {
				await handle.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
			} finally {
				await handle.close();
			}
			const lease = new SessionLease(path, owner, options);
			lease.#startHeartbeat();
			return lease;
		};

		const first = await attempt();
		if (first) return first;

		const existing = await readOwner(path);
		const stale = existing === undefined || isStale(existing, now(), options.staleMs ?? DEFAULT_STALE_MS);
		if (!options.force && !stale) throw new SessionBusyError(sessionId, existing);
		// 过期或强制接管：删除旧锁后重试一次；并发抢锁失败则按当前持有者报冲突。
		await unlink(path).catch(() => undefined);
		const second = await attempt();
		if (second) return second;
		const winner = await readOwner(path);
		throw new SessionBusyError(sessionId, winner ?? owner);
	}

	/**
	 * 释放租约并停止心跳。锁文件已被其他接管者替换时不会误删。
	 * 可重复调用。
	 */
	async release(): Promise<void> {
		if (this.#released) return;
		this.#released = true;
		if (this.#timer) clearInterval(this.#timer);
		this.#timer = undefined;
		const current = await readOwner(this.#path);
		if (current !== undefined && current.token !== this.#owner.token) return;
		await unlink(this.#path).catch(() => undefined);
	}

	#startHeartbeat(): void {
		if (this.#heartbeatMs <= 0) return;
		this.#timer = setInterval(() => {
			if (this.#released) return;
			this.#owner = { ...this.#owner, heartbeatAt: new Date().toISOString() };
			void writeFile(this.#path, `${JSON.stringify(this.#owner)}\n`, "utf8").catch(() => undefined);
		}, this.#heartbeatMs);
		this.#timer.unref();
	}
}

/** 读取并校验锁文件；损坏或缺失时返回 undefined，按可接管处理。 */
async function readOwner(path: string): Promise<SessionLeaseOwner | undefined> {
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch {
		return undefined;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null) return undefined;
	const owner = parsed as Record<string, unknown>;
	if (
		typeof owner.pid !== "number" ||
		typeof owner.token !== "string" ||
		typeof owner.startedAt !== "string" ||
		typeof owner.heartbeatAt !== "string"
	) {
		return undefined;
	}
	return {
		pid: owner.pid,
		token: owner.token,
		startedAt: owner.startedAt,
		heartbeatAt: owner.heartbeatAt,
		...(typeof owner.host === "string" ? { host: owner.host } : {}),
	};
}

/** 心跳超时或持有进程已不存在时视为过期。 */
function isStale(owner: SessionLeaseOwner, now: Date, staleMs: number): boolean {
	const heartbeat = Date.parse(owner.heartbeatAt);
	if (!Number.isFinite(heartbeat)) return true;
	if (now.getTime() - heartbeat > staleMs) return true;
	return !isProcessAlive(owner.pid);
}

/** 用信号 0 探测进程是否仍存在；EPERM 说明存在但无权限，仍算存活。 */
function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}
