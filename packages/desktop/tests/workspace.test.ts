import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
	assertProjectDirectory,
	createProjectDirectory,
	createTaskWorkspace,
	validateProjectName,
} from "../src/main/_workspace.ts";

const directories: string[] = [];

async function tempDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "moros-desktop-workspace-"));
	directories.push(directory);
	return directory;
}

afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("desktop workspace directories", () => {
	it("任务根稳定建立在 userData 下并返回 canonical root", async () => {
		const directory = await tempDirectory();
		const userData = join(directory, "desktop");
		const root = await createTaskWorkspace(userData);

		expect(root).toBe(await realpath(join(userData, "tasks-workspace")));
		expect(await createTaskWorkspace(userData)).toBe(root);
		expect(await readdir(root)).toEqual([]);
	});

	it.each(["", "relative-user-data"])("userData 非绝对路径 %j 不回退 cwd/home", async (input) => {
		await expect(createTaskWorkspace(input)).rejects.toMatchObject({ code: "task-workspace-error" });
	});

	it("任务根已是文件时返回结构化错误，不覆盖文件", async () => {
		const directory = await tempDirectory();
		const path = join(directory, "tasks-workspace");
		await writeFile(path, "keep me");

		await expect(createTaskWorkspace(directory)).rejects.toMatchObject({ code: "task-workspace-error" });
		expect(await readFile(path, "utf8")).toBe("keep me");
	});

	it("选择任务根及指向任务根的目录链接都不能登记为项目", async () => {
		const directory = await tempDirectory();
		const taskRoot = await createTaskWorkspace(join(directory, "desktop"));
		const alias = join(directory, "task-alias");
		await symlink(taskRoot, alias, process.platform === "win32" ? "junction" : "dir");

		await expect(assertProjectDirectory(taskRoot, taskRoot)).rejects.toMatchObject({ code: "invalid-project" });
		await expect(assertProjectDirectory(alias, taskRoot)).rejects.toMatchObject({ code: "invalid-project" });
	});

	it("通过目录链接选择的项目与新建项目父目录都会 canonicalize", async () => {
		const directory = await tempDirectory();
		const parent = join(directory, "parent");
		await mkdir(parent);
		const alias = join(directory, "parent-alias");
		await symlink(parent, alias, process.platform === "win32" ? "junction" : "dir");
		const taskRoot = await createTaskWorkspace(join(directory, "desktop"));

		expect(await assertProjectDirectory(alias, taskRoot)).toBe(await realpath(parent));
		const root = await createProjectDirectory(alias, "new-project", taskRoot);
		expect(root).toBe(await realpath(join(parent, "new-project")));
		expect(await readdir(root)).toEqual([]);
	});

	it.each(["folder", "file"])("已有同名 %s 时创建失败且原内容保留", async (kind) => {
		const directory = await tempDirectory();
		const taskRoot = await createTaskWorkspace(join(directory, "desktop"));
		const existing = join(directory, "existing");
		if (kind === "folder") {
			await mkdir(existing);
			await writeFile(join(existing, "marker.txt"), "keep me");
		} else {
			await writeFile(existing, "keep me");
		}

		await expect(createProjectDirectory(directory, "existing", taskRoot)).rejects.toMatchObject({
			code: "project-exists",
		});
		expect(await readFile(kind === "folder" ? join(existing, "marker.txt") : existing, "utf8")).toBe("keep me");
	});

	it("父目录无效时不创建任何目录", async () => {
		const directory = await tempDirectory();
		const taskRoot = await createTaskWorkspace(join(directory, "desktop"));
		const parent = join(directory, "missing-parent");

		await expect(createProjectDirectory(parent, "project", taskRoot)).rejects.toMatchObject({
			code: "invalid-project",
		});
		await expect(readdir(parent)).rejects.toMatchObject({ code: "ENOENT" });
	});
});

describe("desktop project names", () => {
	it.each([
		"",
		".",
		"..",
		"../outside",
		"nested/project",
		"nested\\project",
		"a..b",
		"line\nbreak",
		"nul\u0000byte",
		"control\u0085",
		"invalid:name",
		"bad?name",
		"bad*name",
		"bad|name",
		"bad<name",
		"bad>name",
		'bad"name',
		"trailing.",
		"trailing ",
		"CON",
		"con.txt",
		"AUX",
		"PRN",
		"NUL",
		"COM1",
		"com9.txt",
		"LPT1",
		"lpt9",
		"COM¹",
		"LPT²",
		"CONIN$",
		"CONOUT$",
		"x".repeat(256),
	])("非法名称 %j 被拒绝", (name) => {
		expect(() => validateProjectName(name)).toThrow();
		try {
			validateProjectName(name);
		} catch (error) {
			expect(error).toMatchObject({ code: "invalid-project-name" });
		}
	});

	it.each(["my-project", "project.v2", ".hidden", "CONSOLE", "COM10", "项目名称"])(
		"有效单段名称 %j 不被改写",
		(name) => {
			expect(() => validateProjectName(name)).not.toThrow();
		},
	);
});
