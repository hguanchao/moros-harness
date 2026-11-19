import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { checkoutGitBranch, listGitBranches } from "../src/main/_git.ts";

const execFileAsync = promisify(execFile);

async function hasGit(): Promise<boolean> {
	try {
		await execFileAsync("git", ["--version"], { windowsHide: true });
		return true;
	} catch {
		return false;
	}
}

const gitAvailable = await hasGit();

async function git(args: readonly string[], cwd: string): Promise<void> {
	await execFileAsync("git", [...args], { cwd, windowsHide: true });
}

async function createRepo(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "moros-git-test-"));
	await git(["init"], root);
	await git(["symbolic-ref", "HEAD", "refs/heads/main"], root);
	await git(["config", "user.email", "test@example.com"], root);
	await git(["config", "user.name", "Moros Test"], root);
	await writeFile(join(root, "file.txt"), "initial\n", "utf8");
	await git(["add", "."], root);
	await git(["commit", "-m", "initial"], root);
	await git(["branch", "feature/login"], root);
	return root;
}

describe.skipIf(!gitAvailable)("Git 分支", () => {
	it("非 Git 目录返回空分支列表", async () => {
		const root = await mkdtemp(join(tmpdir(), "moros-git-plain-"));
		try {
			await expect(listGitBranches(root)).resolves.toEqual({ branches: [] });
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("列出本地分支并标记当前分支", async () => {
		const root = await createRepo();
		try {
			const info = await listGitBranches(root);
			expect(info.branches).toEqual(expect.arrayContaining(["main", "feature/login"]));
			expect(info.current).toBe("main");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("干净工作区可以切换分支", async () => {
		const root = await createRepo();
		try {
			await expect(checkoutGitBranch(root, "feature/login")).resolves.toEqual({ branch: "feature/login" });
			await expect(listGitBranches(root)).resolves.toMatchObject({ current: "feature/login" });
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("工作区有未提交改动时拒绝切换", async () => {
		const root = await createRepo();
		try {
			await writeFile(join(root, "file.txt"), "dirty\n", "utf8");
			await expect(checkoutGitBranch(root, "feature/login")).rejects.toMatchObject({
				name: "DesktopGitError",
				code: "worktree-dirty",
			});
			await expect(listGitBranches(root)).resolves.toMatchObject({ current: "main" });
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("不存在的分支返回 branch-not-found", async () => {
		const root = await createRepo();
		try {
			await expect(checkoutGitBranch(root, "feature/missing")).rejects.toMatchObject({
				name: "DesktopGitError",
				code: "branch-not-found",
			});
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
