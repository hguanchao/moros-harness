import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { GitBranches, GitCheckoutResult } from "../shared/contract.ts";

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 10_000;
const GIT_MAX_BUFFER = 1024 * 1024;

type GitErrorCode = "branch-not-found" | "worktree-dirty" | "git-checkout-failed";

/**
 * Git 分支操作的业务错误；只暴露稳定错误码与用户可读提示。
 * @param code 稳定的分支错误码。
 * @param message 不包含内部路径或 Git 原始输出的提示。
 * @param options 可选的原始异常原因。
 * @example throw new DesktopGitError("worktree-dirty", "项目有未提交的改动");
 */
export class DesktopGitError extends Error {
	readonly code: GitErrorCode;

	constructor(code: GitErrorCode, message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "DesktopGitError";
		this.code = code;
	}
}

/**
 * 查询本地分支与当前分支；非 Git 仓库或 Git 不可用时返回空列表。
 * @param root 已校验的项目根目录。
 * @returns 分支名列表与当前分支；detached HEAD 时 current 缺省。
 * @example const { branches, current } = await listGitBranches("/work/project");
 */
export async function listGitBranches(root: string): Promise<GitBranches> {
	try {
		const inside = await git(root, ["rev-parse", "--is-inside-work-tree"]);
		if (inside.trim() !== "true") return { branches: [] };
		const output = await git(root, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]);
		const branches = output
			.split(/\r?\n/u)
			.map((line) => line.trim())
			.filter((line) => line.length > 0);
		let current: string | undefined;
		try {
			current = (await git(root, ["symbolic-ref", "--short", "-q", "HEAD"])).trim() || undefined;
		} catch {
			current = undefined;
		}
		return { branches, ...(current === undefined ? {} : { current }) };
	} catch {
		return { branches: [] };
	}
}

/**
 * 切换到项目已有分支；当前分支相同则直接成功，工作区有改动时拒绝。
 * @param root 已校验的项目根目录。
 * @param branch 下拉菜单提供的分支名，必须仍存在于 refs/heads。
 * @returns 切换到位的分支。
 * @throws DesktopGitError 分支不存在、工作区有未提交改动或 Git 切换失败时。
 * @example await checkoutGitBranch("/work/project", "feature/login");
 */
export async function checkoutGitBranch(root: string, branch: string): Promise<GitCheckoutResult> {
	const info = await listGitBranches(root);
	if (!info.branches.includes(branch)) {
		throw new DesktopGitError("branch-not-found", "分支不存在或已被删除，请重新选择");
	}
	if (info.current === branch) return { branch };
	let status: string;
	try {
		status = await git(root, ["status", "--porcelain"]);
	} catch (error) {
		throw new DesktopGitError("git-checkout-failed", "无法读取 Git 工作区状态，请稍后重试", { cause: error });
	}
	if (status.trim().length > 0) {
		throw new DesktopGitError("worktree-dirty", "项目有未提交的改动，暂不能切换分支。请先提交或暂存后再试。");
	}
	try {
		await git(root, ["checkout", "--quiet", branch]);
	} catch (error) {
		throw new DesktopGitError("git-checkout-failed", "切换分支失败，请检查 Git 状态后重试", { cause: error });
	}
	return { branch };
}

/** 以参数数组调用 git，不经过 shell；cwd 固定为已校验的项目根。 */
async function git(root: string, args: readonly string[]): Promise<string> {
	const { stdout } = await execFileAsync("git", [...args], {
		cwd: root,
		encoding: "utf8",
		timeout: GIT_TIMEOUT_MS,
		maxBuffer: GIT_MAX_BUFFER,
		windowsHide: true,
	});
	return stdout;
}
