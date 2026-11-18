import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DesktopStore } from "../../packages/desktop/src/main/store.ts";

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
		await import("node:fs/promises").then(({ writeFile }) =>
			writeFile(join(directory, "desktop-state.json"), "{not json", "utf8"),
		);

		const store = await DesktopStore.open(directory);
		expect(store.recentProjects()).toEqual([]);
		expect(store.windowBounds()).toBeUndefined();
		expect(store.isMaximized()).toBe(false);
	});
});
