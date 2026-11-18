import { Buffer } from "node:buffer";

/**
 * 备用屏期间的 stderr 接管。
 *
 * TUI 用绝对坐标逐行重绘，任何绕过 stdout 的输出都会落在当前光标处、触发折行甚至终端
 * 滚动，而被污染的行不会自动恢复。接管窗口内同时封住两条出口：替换 `process.stderr.write`
 * 拦住普通写入，替换 Node 默认的 `warning` 监听器拦住 `process.emitWarning`。两者都只进
 * 内存缓冲，离开备用屏后恢复并原样写出：信息不丢，画面也不会被打穿。
 */

/** 一次接管的句柄；`release` 幂等，重复调用不会重复输出。 */
export interface TerminalCapture {
	/** 恢复 stderr 并写出缓冲；应在离开备用屏之后调用。 */
	readonly release: () => void;
	/** 接管期间收到的原始文本快照，供诊断与测试读取。 */
	readonly buffered: () => readonly string[];
}

type StderrWrite = typeof process.stderr.write;
type WriteCallback = (error?: Error | null) => void;
type WarningListener = (warning: Error) => void;

/**
 * 开始接管进程的 stderr 与 Node warning 通道。
 *
 * 普通写入靠替换 `process.stderr.write` 拦截；`process.emitWarning` 则由 Node 启动时注册的
 * 默认 `warning` 监听器格式化后写出，所以这里把该监听器也换成只写缓冲的实现。两道都做
 * 是因为第三方依赖可能在接管期任意时刻抛 warning，只堵一条仍会漏。带回调的写入会立刻
 * 回调成功，避免调用方永久挂起。`release` 会按原顺序恢复监听器。
 *
 * @returns 接管句柄；调用方必须在其生命周期结束时调用 `release`。
 */
export function captureTerminal(): TerminalCapture {
	const original = process.stderr.write.bind(process.stderr) as StderrWrite;
	const chunks: string[] = [];
	let released = false;
	const capture = ((
		chunk: string | Uint8Array,
		encoding?: BufferEncoding | WriteCallback,
		callback?: WriteCallback,
	): boolean => {
		chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
		// write 的第二参数可能是回调；不调用会让带回调的调用方一直挂着
		const done = typeof encoding === "function" ? encoding : callback;
		done?.();
		return true;
	}) as unknown as StderrWrite;

	const previousWarningListeners = process.listeners("warning") as WarningListener[];
	process.removeAllListeners("warning");
	const collectWarning: WarningListener = (warning) => {
		// emitWarning 把 code 挂在 Error 上而不是 name 里；丢掉它会让诊断只剩半句
		const raw: unknown = (warning as { code?: unknown }).code;
		const code = typeof raw === "string" ? ` [${raw}]` : "";
		chunks.push(`Warning${code}: ${warning.message}\n`);
	};
	process.on("warning", collectWarning);
	process.stderr.write = capture;

	return {
		release(): void {
			if (released) return;
			released = true;
			process.off("warning", collectWarning);
			for (const listener of previousWarningListeners) process.on("warning", listener);
			process.stderr.write = original;
			// 恢复之后才落盘：此时已回到主屏，长文本折行也不会盖住界面帧
			for (const chunk of chunks.splice(0)) original(chunk);
		},
		buffered: (): readonly string[] => [...chunks],
	};
}
