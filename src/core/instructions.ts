import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { isMissingPath } from "#src/core/fs-error.ts";

/**
 * 工作区指令（ADR-16）：用户级与项目级 AGENTS.md 的发现与读取。
 *
 * 两层语义：用户级（~/.moros/AGENTS.md）是使用者自己的全局偏好，直接生效；项目级
 * （<项目根>/AGENTS.md）是仓库协作约定，属于第三方内容，**必须先过工作区信任**
 * ——信任门由调用方判定，本模块只按 includeProject 决定是否读取。
 * 单文件 32KB 上限：超限截断（按 UTF-8 码点安全截断）并标注，防止上下文膨胀。
 * 读取失败的条目跳过并经 onSkip 上报，不拖累其他层。
 */

/** 单文件的最大字节数；超过即截断并标注。 */
const MAX_INSTRUCTION_BYTES = 32 * 1024;

export interface WorkspaceInstructionFile {
	/** 指令文件的绝对路径（展示给模型，标注来源）。 */
	readonly path: string;
	/** 指令正文；超限时按 UTF-8 码点边界安全截断。 */
	readonly content: string;
	/** 是否发生了截断。 */
	readonly truncated: boolean;
}

export interface WorkspaceInstructions {
	/** 用户级全局指令；文件不存在或读取失败时省略。 */
	readonly user?: WorkspaceInstructionFile;
	/** 项目级指令；仅在已信任且文件存在时提供。 */
	readonly project?: WorkspaceInstructionFile;
}

export interface WorkspaceInstructionsOptions {
	readonly homeDir: string;
	readonly projectRoot: string;
	/** 是否读取项目级指令（调用方已做信任判定）；false 时即使文件存在也不读。 */
	readonly includeProject: boolean;
	/** 条目被跳过时的诊断回调（读取失败、非文件等）。 */
	readonly onSkip?: (message: string) => void;
}

/** 按码点边界安全截断 UTF-8 文本到 maxBytes。 */
function truncateUtf8(content: string, maxBytes: number): { content: string; truncated: boolean } {
	const buffer = Buffer.from(content, "utf8");
	if (buffer.byteLength <= maxBytes) return { content, truncated: false };
	let slice = buffer.subarray(0, maxBytes);
	// 退到完整码点边界：多字节序列的首字节形如 110xxxxx/1110xxxx/11110xxx
	while (slice.length > 0 && (slice[slice.length - 1]! & 0xc0) === 0x80) {
		slice = slice.subarray(0, slice.length - 1);
	}
	return { content: slice.toString("utf8").replace(/\s+$/, ""), truncated: true };
}

async function readInstructionFile(
	path: string,
	onSkip?: (message: string) => void,
): Promise<WorkspaceInstructionFile | undefined> {
	try {
		const raw = await readFile(path, "utf8");
		if (raw.trim().length === 0) {
			onSkip?.(`Skipped empty instruction file ${path}`);
			return undefined;
		}
		const { content, truncated } = truncateUtf8(raw, MAX_INSTRUCTION_BYTES);
		return { path, content, truncated };
	} catch (error) {
		// 文件不存在是常态（多数使用者没有全局/项目指令），静默省略；
		// 其余读取失败（权限、损坏）跳过并上报
		if (!isMissingPath(error)) {
			onSkip?.(`Skipped instruction file ${path}: ${error instanceof Error ? error.message : String(error)}`);
		}
		return undefined;
	}
}

/**
 * 读取工作区指令（ADR-16）。
 *
 * @param options.homeDir 数据目录根（用户级读 `<homeDir>/.moros/AGENTS.md`）。
 * @param options.projectRoot 项目根（项目级读 `<projectRoot>/AGENTS.md`）。
 * @param options.includeProject 是否读取项目级——调用方先做信任判定：
 *        未信任或未决定的项目一律 false。
 * @param options.onSkip 条目跳过时的诊断回调。
 * @returns 两层指令；缺失的层省略，两层皆缺时返回空对象。
 */
export async function loadWorkspaceInstructions(options: WorkspaceInstructionsOptions): Promise<WorkspaceInstructions> {
	const user = await readInstructionFile(join(options.homeDir, ".moros", "AGENTS.md"), options.onSkip);
	const project = options.includeProject
		? await readInstructionFile(join(options.projectRoot, "AGENTS.md"), options.onSkip)
		: undefined;
	return {
		...(user ? { user } : {}),
		...(project ? { project } : {}),
	};
}
