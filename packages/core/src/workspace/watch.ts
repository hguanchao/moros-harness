import { watch, type FSWatcher } from "node:fs";
import { relative } from "node:path";

import { IGNORED_DIRECTORIES, toPosixPath } from "./files.ts";

/** 合并窗口：文件保存常触发多次事件，120ms 足够合并成一次刷新。 */
const DEFAULT_DEBOUNCE_MS = 120;

/** 单批最多上报的路径数，防止依赖目录爆发时淹没消息通道。 */
const MAX_BATCH = 500;

export interface WorkspaceWatchOptions {
	readonly debounceMs?: number;
	readonly onError?: (error: Error) => void;
}

export interface WorkspaceWatch {
	/** 停止监听；可重复调用。 */
	close(): void;
}

/**
 * 监听工作区内文件变化，按防抖窗口合并成一批相对路径。
 *
 * 只上报路径，不读内容；读取由界面按需发起。忽略 `.git/.moros/node_modules/dist`
 * 整棵子树。递归监听依赖 Node 的 recursive 支持（Linux 需 Node 20+）。
 * @param projectRoot 工作区根目录。
 * @param listener 合并后的变化路径批次（`/` 分隔的相对路径）。
 * @param options 防抖与错误回调。
 * @returns 可关闭的监听句柄。
 */
export function watchWorkspace(
	projectRoot: string,
	listener: (paths: readonly string[]) => void,
	options: WorkspaceWatchOptions = {},
): WorkspaceWatch {
	const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
	const pending = new Set<string>();
	let timer: NodeJS.Timeout | undefined;
	let closed = false;

	const flush = (): void => {
		timer = undefined;
		if (closed || pending.size === 0) return;
		const batch = [...pending].slice(0, MAX_BATCH);
		pending.clear();
		listener(batch);
	};

	let watcher: FSWatcher;
	try {
		watcher = watch(projectRoot, { recursive: true }, (_event, filename) => {
			if (!filename) {
				// 部分平台不提供文件名时退化为「整个目录变了」，让界面刷新根。
				pending.add("");
			} else {
				const posix = toPosixPath(filename);
				if (isIgnored(posix)) return;
				pending.add(posix);
			}
			if (timer === undefined) timer = setTimeout(flush, debounceMs);
		});
	} catch (error) {
		options.onError?.(error instanceof Error ? error : new Error(String(error)));
		return { close: () => undefined };
	}

	watcher.on("error", (error) => {
		if (!closed) options.onError?.(error);
	});

	return {
		close() {
			if (closed) return;
			closed = true;
			if (timer !== undefined) clearTimeout(timer);
			timer = undefined;
			watcher.close();
		},
	};
}

/** 路径任一分段命中忽略集即忽略。 */
function isIgnored(posixPath: string): boolean {
	return posixPath.split("/").some((segment) => IGNORED_DIRECTORIES.has(segment));
}

/** 把监听回调返回的绝对路径转成项目相对路径，供需要绝对路径的调用方复用。 */
export function relativeToWorkspace(projectRoot: string, absolutePath: string): string {
	return toPosixPath(relative(projectRoot, absolutePath));
}
