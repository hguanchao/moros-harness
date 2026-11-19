import { mkdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import { isExists } from "@moros/core/fs-error.ts";
import { normalizeProjectRoot } from "@moros/core/session/project-dir.ts";
import { assertWorkspaceRoot } from "@moros/core/workspace/files.ts";

const TASK_WORKSPACE_DIRECTORY = "tasks-workspace";
const MAX_PROJECT_NAME_LENGTH = 255;
const INVALID_PROJECT_NAME_CHARACTERS = /[<>:"/\\|?*\p{Cc}]/u;
const WINDOWS_RESERVED_PROJECT_NAMES = /^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu;

type WorkspaceErrorCode =
	| "workspace-busy"
	| "task-workspace-error"
	| "invalid-project"
	| "invalid-project-name"
	| "project-exists"
	| "project-create-failed";

/**
 * 主进程工作区业务错误；IPC 只公开 code/message，保留 cause 供内部诊断。
 * @param code 稳定的工作区错误码。
 * @param message 不包含内部路径或堆栈的用户提示。
 * @param options 可选的原始异常原因。
 * @example throw new DesktopWorkspaceError("workspace-busy", "Wait for the current task to finish");
 */
export class DesktopWorkspaceError extends Error {
	readonly code: WorkspaceErrorCode;

	constructor(code: WorkspaceErrorCode, message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "DesktopWorkspaceError";
		this.code = code;
	}
}

/**
 * 创建并 canonicalize 稳定任务根；不会回退到 cwd/home，也不改变 Core 的配置目录。
 * @param userDataDir Electron 的绝对 userData 目录。
 * @returns 可访问任务目录的 realpath。
 * @throws DesktopWorkspaceError 目录不是绝对路径或无法创建/读取时。
 * @example const root = await createTaskWorkspace(app.getPath("userData"));
 */
export async function createTaskWorkspace(userDataDir: string): Promise<string> {
	if (!isAbsolute(userDataDir)) {
		throw new DesktopWorkspaceError("task-workspace-error", "Desktop user data directory must be absolute");
	}
	try {
		const root = join(userDataDir, TASK_WORKSPACE_DIRECTORY);
		await mkdir(root, { recursive: true });
		return await assertWorkspaceRoot(root);
	} catch (error) {
		throw new DesktopWorkspaceError("task-workspace-error", "Could not prepare the default tasks workspace", {
			cause: error,
		});
	}
}

/**
 * 校验普通项目目录并返回 realpath；任务根（包含指向它的链接）不能登记为普通项目。
 * @param input 用户明确提供或原生对话框选择的目录。
 * @param taskRoot 已校验的内部任务根。
 * @returns 项目目录的 canonical root。
 * @throws DesktopWorkspaceError 目录不可访问或与任务根相同时。
 * @example const root = await assertProjectDirectory(selectedPath, taskRoot);
 */
export async function assertProjectDirectory(input: string, taskRoot: string): Promise<string> {
	let root: string;
	try {
		root = await assertWorkspaceRoot(input);
	} catch (error) {
		throw new DesktopWorkspaceError("invalid-project", "The project folder is not accessible", { cause: error });
	}
	if (normalizeProjectRoot(root) === normalizeProjectRoot(taskRoot)) {
		throw new DesktopWorkspaceError("invalid-project", "The tasks workspace cannot be selected as a project");
	}
	return root;
}

/**
 * 校验单个项目文件夹名称；跨平台拒绝路径穿越、控制字符及 Windows 保留名称。
 * @param name 原始名称，不会静默裁剪或替换字符。
 * @returns 无返回值；名称有效时不改变它。
 * @throws DesktopWorkspaceError 名称为空、过长、含非法字符、尾点/空格或保留名时。
 * @example validateProjectName("my-project");
 */
export function validateProjectName(name: string): void {
	if (
		name.length === 0 ||
		name.length > MAX_PROJECT_NAME_LENGTH ||
		name === "." ||
		name.includes("..") ||
		INVALID_PROJECT_NAME_CHARACTERS.test(name) ||
		/[. ]$/u.test(name) ||
		WINDOWS_RESERVED_PROJECT_NAMES.test(name)
	) {
		throw new DesktopWorkspaceError("invalid-project-name", "Choose a valid project folder name");
	}
}

/**
 * 在原生对话框选定的父目录下独占创建项目文件夹；不覆盖目录/文件，不初始化 Git。
 * @param parentInput 用户选择的父目录，创建前会校验并 canonicalize。
 * @param name 已输入的单段文件夹名称。
 * @param taskRoot 内部任务根，不能被此操作创建为普通项目。
 * @returns 新项目目录的 realpath。
 * @throws DesktopWorkspaceError 名称非法、目录已存在或无法创建/读取时。
 * @example const root = await createProjectDirectory(parentPath, "my-project", taskRoot);
 */
export async function createProjectDirectory(parentInput: string, name: string, taskRoot: string): Promise<string> {
	validateProjectName(name);
	let parent: string;
	try {
		parent = await assertWorkspaceRoot(parentInput);
	} catch (error) {
		throw new DesktopWorkspaceError("invalid-project", "The parent folder is not accessible", { cause: error });
	}
	const root = join(parent, name);
	if (normalizeProjectRoot(root) === normalizeProjectRoot(taskRoot)) {
		throw new DesktopWorkspaceError("invalid-project", "The tasks workspace cannot be selected as a project");
	}
	try {
		// 不使用 recursive：已存在的文件夹也必须报冲突，不能当作创建成功。
		await mkdir(root);
	} catch (error) {
		throw new DesktopWorkspaceError(
			isExists(error) ? "project-exists" : "project-create-failed",
			isExists(error)
				? "A folder or file with that project name already exists"
				: "Could not create the project folder",
			{ cause: error },
		);
	}
	return assertProjectDirectory(root, taskRoot);
}
