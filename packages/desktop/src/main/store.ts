import { readdir, readFile, rm } from "node:fs/promises";
import { basename, join } from "node:path";

import { z } from "zod";

import { atomicWriteFile } from "@moros/core/atomic-file.ts";
import { DEFAULT_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH, MIN_SIDEBAR_WIDTH, type RecentProject } from "../shared/contract.ts";

const RecentProjectSchema = z.object({
	root: z.string().min(1),
	name: z.string().min(1),
	lastOpenedAt: z.string().datetime({ offset: true }),
});

const BoundsSchema = z.object({
	x: z.number().int(),
	y: z.number().int(),
	width: z.number().int().positive(),
	height: z.number().int().positive(),
});

/** 最近项目数量上限；桌面端只做切换入口，不做项目档案管理。 */
const MAX_RECENT = 12;

/** 置顶只影响侧栏排序，本地保存时设置上限，避免状态文件无限增长。 */
const MAX_PINNED_SESSIONS = 50;

const SessionIdSchema = z
	.string()
	.regex(/^[A-Za-z0-9_-]+$/)
	.max(200);

const SidebarWidthSchema = z.number().int().min(MIN_SIDEBAR_WIDTH).max(MAX_SIDEBAR_WIDTH);

const DesktopStateSchema = z.object({
	recentProjects: z.array(RecentProjectSchema).default([]),
	window: BoundsSchema.optional(),
	maximized: z.boolean().default(false),
	// 字段级容错：单个损坏的 pin 列表不应连带丢掉最近项目与窗口状态。
	pinnedSessionIds: z.array(SessionIdSchema).max(MAX_PINNED_SESSIONS).catch([]).default([]),
	sidebarWidth: SidebarWidthSchema.catch(DEFAULT_SIDEBAR_WIDTH).default(DEFAULT_SIDEBAR_WIDTH),
});

type DesktopState = z.infer<typeof DesktopStateSchema>;

/**
 * 桌面端本地状态：最近项目与窗口位置。
 *
 * 这些是「哪个窗口打开过什么」的宿主信息，不属于 Core 配置；放在 Electron userData
 * 目录，避免污染 `~/.moros/config.toml` 的 CLI 语义。
 */
export class DesktopStore {
	readonly #path: string;
	#state: DesktopState = {
		recentProjects: [],
		maximized: false,
		pinnedSessionIds: [],
		sidebarWidth: DEFAULT_SIDEBAR_WIDTH,
	};

	private constructor(path: string) {
		this.#path = path;
	}

	static async open(userDataDir: string): Promise<DesktopStore> {
		// 清扫上次进程硬退出残留的原子写临时文件（atomicWriteFile 只在捕获到错误时清理）
		try {
			const prefix = `${join(userDataDir, "desktop-state.json")}.`;
			for (const entry of await readdir(userDataDir)) {
				if (entry.startsWith(prefix) && entry.endsWith(".tmp")) {
					await rm(join(userDataDir, entry), { force: true });
				}
			}
		} catch {
			// 清扫失败不阻塞启动；残留文件无害，只是占磁盘
		}
		const store = new DesktopStore(join(userDataDir, "desktop-state.json"));
		await store.#load();
		return store;
	}

	recentProjects(): readonly RecentProject[] {
		return this.#state.recentProjects;
	}

	windowBounds(): { x: number; y: number; width: number; height: number } | undefined {
		return this.#state.window;
	}

	isMaximized(): boolean {
		return this.#state.maximized;
	}

	/** 记住项目并置顶；路径重复时更新时间而不是新增一条。 */
	async rememberProject(root: string, name = basename(root)): Promise<void> {
		const entry: RecentProject = { root, name, lastOpenedAt: new Date().toISOString() };
		const recent = [entry, ...this.#state.recentProjects.filter((item) => item.root !== root)].slice(0, MAX_RECENT);
		this.#state = { ...this.#state, recentProjects: recent };
		await this.#save();
	}

	async forgetProject(root: string): Promise<void> {
		const recent = this.#state.recentProjects.filter((item) => item.root !== root);
		if (recent.length === this.#state.recentProjects.length) return;
		this.#state = { ...this.#state, recentProjects: recent };
		await this.#save();
	}

	/** 侧栏置顶会话 ID；旧状态文件返回空数组。 */
	pinnedSessionIds(): readonly string[] {
		return this.#state.pinnedSessionIds;
	}

	/**
	 * 设置或取消会话置顶；置顶顺序按最近操作时间向前排列，去重且受上限约束。
	 * @param id 完整的会话 ID，由调用方校验归属；这里只校验格式。
	 * @param pinned true 置顶，false 取消置顶。
	 * @returns 更新后的置顶 ID 列表。
	 */
	async setPinned(id: string, pinned: boolean): Promise<readonly string[]> {
		const existing = this.#state.pinnedSessionIds.filter((entry) => entry !== id);
		this.#state = {
			...this.#state,
			pinnedSessionIds: pinned ? [id, ...existing].slice(0, MAX_PINNED_SESSIONS) : existing,
		};
		await this.#save();
		return this.#state.pinnedSessionIds;
	}

	/** 侧栏宽度；旧状态文件返回默认值。 */
	sidebarWidth(): number {
		return this.#state.sidebarWidth;
	}

	/** 持久化侧栏宽度，越界值钳制到允许的范围内；无变化时跳过落盘。 */
	async setSidebarWidth(width: number): Promise<number> {
		if (!Number.isFinite(width)) return this.#state.sidebarWidth;
		const clamped = Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, Math.round(width)));
		if (clamped === this.#state.sidebarWidth) return clamped;
		this.#state = { ...this.#state, sidebarWidth: clamped };
		await this.#save();
		return clamped;
	}

	/** 会话删除后清理置顶记录；没有变化时跳过落盘。 */
	async unpinSessions(ids: readonly string[]): Promise<void> {
		const removed = new Set(ids);
		const pinnedSessionIds = this.#state.pinnedSessionIds.filter((id) => !removed.has(id));
		if (pinnedSessionIds.length === this.#state.pinnedSessionIds.length) return;
		this.#state = { ...this.#state, pinnedSessionIds };
		await this.#save();
	}

	async rememberWindow(
		bounds: { x: number; y: number; width: number; height: number } | undefined,
		maximized: boolean,
	): Promise<void> {
		this.#state = {
			...this.#state,
			...(bounds === undefined ? {} : { window: bounds }),
			maximized,
		};
		await this.#save();
	}

	async #load(): Promise<void> {
		let raw: string;
		try {
			raw = await readFile(this.#path, "utf8");
		} catch {
			return;
		}
		try {
			const parsed: unknown = JSON.parse(raw);
			const result = DesktopStateSchema.safeParse(parsed);
			if (result.success) this.#state = result.data;
		} catch {
			// 损坏的本地状态只影响窗口位置与最近项目；继续用默认值启动，不阻断应用。
		}
	}

	async #save(): Promise<void> {
		await atomicWriteFile(this.#path, `${JSON.stringify(this.#state, null, 2)}\n`);
	}
}
