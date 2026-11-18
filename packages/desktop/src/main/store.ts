import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";

import { z } from "zod";

import { atomicWriteFile } from "@moros/core/atomic-file.ts";
import type { RecentProject } from "../shared/contract.ts";

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

const DesktopStateSchema = z.object({
	recentProjects: z.array(RecentProjectSchema).default([]),
	window: BoundsSchema.optional(),
	maximized: z.boolean().default(false),
});

type DesktopState = z.infer<typeof DesktopStateSchema>;

/** 最近项目数量上限；桌面端只做切换入口，不做项目档案管理。 */
const MAX_RECENT = 12;

/**
 * 桌面端本地状态：最近项目与窗口位置。
 *
 * 这些是「哪个窗口打开过什么」的宿主信息，不属于 Core 配置；放在 Electron userData
 * 目录，避免污染 `~/.moros/config.toml` 的 CLI 语义。
 */
export class DesktopStore {
	readonly #path: string;
	#state: DesktopState = { recentProjects: [], maximized: false };

	private constructor(path: string) {
		this.#path = path;
	}

	static async open(userDataDir: string): Promise<DesktopStore> {
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
