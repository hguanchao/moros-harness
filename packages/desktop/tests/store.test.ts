import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DesktopStore } from "../src/main/store.ts";
import { DEFAULT_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH, MIN_SIDEBAR_WIDTH } from "../src/shared/contract.ts";

const directories: string[] = [];

async function tempDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "moros-desktop-store-"));
	directories.push(directory);
	return directory;
}

afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("DesktopStore", () => {
	it("最近项目去重并按打开时间倒序，窗口状态可跨实例恢复", async () => {
		const directory = await tempDirectory();
		const store = await DesktopStore.open(directory);

		await store.rememberProject("/projects/alpha");
		await store.rememberProject("/projects/beta");
		await store.rememberProject("/projects/alpha");
		await store.rememberWindow({ x: 10, y: 20, width: 1200, height: 800 }, true);
		await store.rememberWindow({ x: 10, y: 20, width: 1200, height: 800 }, false);

		expect(store.recentProjects().map((project) => project.name)).toEqual(["alpha", "beta"]);
		expect(store.windowBounds()).toEqual({ x: 10, y: 20, width: 1200, height: 800 });
		expect(store.isMaximized()).toBe(false);

		const reopened = await DesktopStore.open(directory);
		expect(reopened.recentProjects().map((project) => project.root)).toEqual(["/projects/alpha", "/projects/beta"]);
		expect(reopened.windowBounds()).toEqual({ x: 10, y: 20, width: 1200, height: 800 });
	});

	it("损坏的状态文件回退到默认值，不阻断启动", async () => {
		const directory = await tempDirectory();
		await writeFile(join(directory, "desktop-state.json"), "{not json", "utf8");

		const store = await DesktopStore.open(directory);
		expect(store.recentProjects()).toEqual([]);
		expect(store.windowBounds()).toBeUndefined();
		expect(store.isMaximized()).toBe(false);
		expect(store.pinnedSessionIds()).toEqual([]);
	});

	it("置顶 ID 去重并按最近操作排序，跨实例保持", async () => {
		const directory = await tempDirectory();
		const store = await DesktopStore.open(directory);

		expect(await store.setPinned("alpha", true)).toEqual(["alpha"]);
		expect(await store.setPinned("beta", true)).toEqual(["beta", "alpha"]);
		expect(await store.setPinned("alpha", true)).toEqual(["alpha", "beta"]);
		expect(await store.setPinned("missing", false)).toEqual(["alpha", "beta"]);
		await store.unpinSessions(["beta", "missing"]);

		const reopened = await DesktopStore.open(directory);
		expect(reopened.pinnedSessionIds()).toEqual(["alpha"]);
	});

	it("旧状态文件缺少置顶字段时默认为空，损坏字段不影响其它状态", async () => {
		const directory = await tempDirectory();
		await writeFile(
			join(directory, "desktop-state.json"),
			JSON.stringify({
				recentProjects: [{ root: "/projects/alpha", name: "alpha", lastOpenedAt: "2026-01-01T00:00:00.000Z" }],
				window: { x: 1, y: 2, width: 800, height: 600 },
				maximized: true,
			}),
			"utf8",
		);
		const legacy = await DesktopStore.open(directory);
		expect(legacy.pinnedSessionIds()).toEqual([]);
		expect(legacy.recentProjects().map((project) => project.root)).toEqual(["/projects/alpha"]);
		expect(legacy.isMaximized()).toBe(true);

		await writeFile(
			join(directory, "desktop-state.json"),
			JSON.stringify({
				recentProjects: [{ root: "/projects/alpha", name: "alpha", lastOpenedAt: "2026-01-01T00:00:00.000Z" }],
				window: { x: 1, y: 2, width: 800, height: 600 },
				maximized: true,
				pinnedSessionIds: ["valid-id", "../invalid"],
			}),
			"utf8",
		);
		const recovered = await DesktopStore.open(directory);
		expect(recovered.pinnedSessionIds()).toEqual([]);
		expect(recovered.recentProjects().map((project) => project.root)).toEqual(["/projects/alpha"]);
		expect(recovered.windowBounds()).toEqual({ x: 1, y: 2, width: 800, height: 600 });
		expect(recovered.isMaximized()).toBe(true);

		await recovered.setPinned("valid-id", true);
		const raw = JSON.parse(await readFile(join(directory, "desktop-state.json"), "utf8")) as Record<string, unknown>;
		expect(raw.pinnedSessionIds).toEqual(["valid-id"]);
	});

	it("侧栏宽度默认 280px，越界钳制且跨实例保持", async () => {
		const directory = await tempDirectory();
		const store = await DesktopStore.open(directory);
		expect(store.sidebarWidth()).toBe(DEFAULT_SIDEBAR_WIDTH);

		expect(await store.setSidebarWidth(320)).toBe(320);
		expect(await store.setSidebarWidth(320)).toBe(320);
		expect(await store.setSidebarWidth(50)).toBe(MIN_SIDEBAR_WIDTH);
		expect(await store.setSidebarWidth(9999)).toBe(MAX_SIDEBAR_WIDTH);
		expect(await store.setSidebarWidth(Number.NaN)).toBe(MAX_SIDEBAR_WIDTH);

		const reopened = await DesktopStore.open(directory);
		expect(reopened.sidebarWidth()).toBe(MAX_SIDEBAR_WIDTH);
	});

	it("损坏的侧栏宽度回退默认值，不影响其它状态", async () => {
		const directory = await tempDirectory();
		await writeFile(
			join(directory, "desktop-state.json"),
			JSON.stringify({
				recentProjects: [{ root: "/projects/alpha", name: "alpha", lastOpenedAt: "2026-01-01T00:00:00.000Z" }],
				sidebarWidth: "very wide",
			}),
			"utf8",
		);
		const store = await DesktopStore.open(directory);
		expect(store.sidebarWidth()).toBe(DEFAULT_SIDEBAR_WIDTH);
		expect(store.recentProjects().map((project) => project.root)).toEqual(["/projects/alpha"]);
	});
});
