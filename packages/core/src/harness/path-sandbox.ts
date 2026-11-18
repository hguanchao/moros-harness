import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, relative, resolve, sep, win32 } from "node:path";

export interface PathSandboxOptions {
	readonly platform?: NodeJS.Platform;
	readonly realpath?: (path: string) => Promise<string>;
	readonly allowMissingLeaf?: boolean;
	/** `~` 展开用的家目录；缺省取宿主家目录，测试可注入。 */
	readonly homeDir?: string;
	/**
	 * harness 管理的 spill 目录（ADR-9）：只读类工具可以读取其中的落盘文件，即使它
	 * 在项目根之外甚至跨盘符——工具结果超限后模型收到的就是「路径 + 1KB 预览」，
	 * 读不了路径等于这个机制白做。写类与命令不享受此豁免；由管线按工具资源传入。
	 */
	readonly spillDirectory?: string;
}

/** 路径超出项目根、使用 UNC/跨盘符路径或触及受保护目录时抛错。 */
export async function resolveSandboxPath(
	projectRoot: string,
	inputPath: string,
	options: PathSandboxOptions = {},
): Promise<string> {
	const platform = options.platform ?? process.platform;
	const windows = platform === "win32";
	const rootInput = windows ? win32.resolve(projectRoot) : resolve(projectRoot);
	// `~` 是模型常用的家目录写法；不展开会被当成根下的字面目录名
	const expanded = expandHome(inputPath, options.homeDir ?? homedir(), windows);
	const targetInput = windows
		? win32.isAbsolute(expanded)
			? win32.resolve(expanded)
			: win32.resolve(rootInput, expanded)
		: isAbsolute(expanded)
			? resolve(expanded)
			: resolve(rootInput, expanded);

	// spill 豁免（ADR-15 真实使用发现）：目标落在 harness 的 spill 目录内时，校验的
	// 权威根切换为 spill 目录——系统临时目录与项目根常不同盘，跨盘符检查必须豁免，
	// 其余包含性与受保护路径检查照常执行。
	const spillRoot = options.spillDirectory
		? windows
			? win32.resolve(options.spillDirectory)
			: resolve(options.spillDirectory)
		: undefined;
	const insideSpill = spillRoot !== undefined && isContained(spillRoot, targetInput, windows);
	const authorityRoot = insideSpill && spillRoot ? spillRoot : rootInput;

	if (!insideSpill && windows && (isUnc(targetInput) || driveOf(rootInput) !== driveOf(targetInput))) {
		throw new Error("UNC paths and cross-drive paths are not allowed");
	}
	assertContained(authorityRoot, targetInput, windows);
	assertProtectedPath(authorityRoot, targetInput, windows);

	const realpathImpl = options.realpath ?? realpath;
	const actualRoot = await realpathImpl(authorityRoot);
	if (!options.allowMissingLeaf) {
		const actualTarget = await realpathImpl(targetInput);
		assertContained(actualRoot, actualTarget, windows);
		assertProtectedPath(actualRoot, actualTarget, windows);
		return actualTarget;
	}
	let candidate = targetInput;
	const missingSegments: string[] = [];
	while (true) {
		try {
			const existingParent = await realpathImpl(candidate);
			assertContained(actualRoot, existingParent, windows);
			assertProtectedPath(actualRoot, existingParent, windows);
			const pathApi = windows ? win32 : undefined;
			const resolved = pathApi
				? pathApi.resolve(existingParent, ...missingSegments.reverse())
				: resolve(existingParent, ...missingSegments.reverse());
			assertContained(actualRoot, resolved, windows);
			assertProtectedPath(actualRoot, resolved, windows);
			return resolved;
		} catch (error) {
			if (!isMissing(error)) throw error;
			const parent = windows ? win32.dirname(candidate) : dirname(candidate);
			if (parent === candidate) throw error;
			missingSegments.push(windows ? win32.basename(candidate) : candidate.slice(parent.length + 1));
			candidate = parent;
		}
	}
}

/** 只做不依赖宿主操作系统的 Windows 路径形式预检，供跨平台安全用例使用。 */
export function validateWindowsPath(root: string, target: string): void {
	const normalizedRoot = win32.resolve(root);
	const normalizedTarget = win32.isAbsolute(target) ? win32.resolve(target) : win32.resolve(normalizedRoot, target);
	if (isUnc(normalizedTarget) || driveOf(normalizedRoot) !== driveOf(normalizedTarget)) {
		throw new Error("UNC paths and cross-drive paths are not allowed");
	}
	assertContained(normalizedRoot, normalizedTarget, true);
	assertProtectedPath(normalizedRoot, normalizedTarget, true);
}

function assertContained(root: string, target: string, windows: boolean): void {
	const normalizedRoot = normalize(root, windows);
	const normalizedTarget = normalize(target, windows);
	const pathApi = windows ? win32 : undefined;
	const relativePath = pathApi
		? pathApi.relative(normalizedRoot, normalizedTarget)
		: relative(normalizedRoot, normalizedTarget);
	if (
		relativePath === ".." ||
		relativePath.startsWith(`..${windows ? "\\" : sep}`) ||
		(pathApi ? pathApi.isAbsolute(relativePath) : isAbsolute(relativePath))
	) {
		throw new Error("Path escapes the project root");
	}
}

function isContained(root: string, target: string, windows: boolean): boolean {
	const normalizedRoot = normalize(root, windows);
	const normalizedTarget = normalize(target, windows);
	const pathApi = windows ? win32 : undefined;
	const relativePath = pathApi
		? pathApi.relative(normalizedRoot, normalizedTarget)
		: relative(normalizedRoot, normalizedTarget);
	return (
		relativePath !== ".." &&
		!relativePath.startsWith(`..${windows ? "\\" : sep}`) &&
		!(pathApi ? pathApi.isAbsolute(relativePath) : isAbsolute(relativePath))
	);
}

function assertProtectedPath(root: string, target: string, windows: boolean): void {
	const pathApi = windows ? win32 : undefined;
	const relativePath = pathApi ? pathApi.relative(root, target) : relative(root, target);
	const segments = relativePath.split(/[\\/]+/).map((part) => (windows ? part.toLowerCase() : part));
	if (segments.some((part) => part === ".git" || part === ".moros")) {
		throw new Error("Access to protected project metadata is not allowed");
	}
}

function normalize(value: string, windows: boolean): string {
	const result = windows ? win32.normalize(value).replace(/[\\/]+$/, "") : resolve(value).replace(/[\\/]+$/, "");
	return windows ? result.toLowerCase() : result;
}

function driveOf(value: string): string {
	return win32.parse(value).root.toLowerCase();
}

function isUnc(value: string): boolean {
	return value.startsWith("\\\\") || value.startsWith("//");
}

function isMissing(error: unknown): boolean {
	return (
		typeof error === "object" && error !== null && "code" in error && ["ENOENT", "ENOTDIR"].includes(String(error.code))
	);
}

/** 展开开头的 `~` / `~/`；其余形式原样返回。 */
function expandHome(inputPath: string, home: string, windows: boolean): string {
	if (inputPath === "~") return home;
	if (inputPath.startsWith("~/") || inputPath.startsWith("~\\")) {
		return windows ? win32.resolve(home, inputPath.slice(2)) : resolve(home, inputPath.slice(2));
	}
	return inputPath;
}
