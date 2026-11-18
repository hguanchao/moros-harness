/**
 * 非致命诊断的接收端。
 *
 * Core 在构造时就要拿到同步的 warning 回调，而 TUI 的 host 要到终端装配完成才存在。用可
 * 延迟绑定的接收端解耦两者：绑定前的告警按序缓冲，绑定时回放；界面退出后解绑，剩余告警
 * 在离开备用屏后统一输出。Core 的各条解析路径因此都不必判断当前端型，也不会把文字直接
 * 写进 alternate screen。
 */

/** 界面侧消费一条非致命诊断。 */
export type WarningHandler = (message: string) => void;

/** 兜底输出；可注入，测试与嵌入宿主不必依赖进程级 stderr。 */
export type WarningWriter = (text: string) => void;

/** Core 与端侧之间唯一的诊断通道。 */
export interface WarningSink {
	/** 投递一条诊断；尚未绑定接收端时先缓冲。 */
	readonly emit: (message: string) => void;
	/** 绑定界面接收端并回放缓冲；重复绑定以新接收端为准。 */
	readonly bind: (handler: WarningHandler) => void;
	/** 解绑界面接收端，其后的告警重新缓冲。 */
	readonly unbind: () => void;
	/** 把仍未消费的告警写到兜底输出；只应在离开备用屏后调用。 */
	readonly flush: () => void;
}

/**
 * 创建诊断接收端。
 *
 * @param write 兜底输出，缺省写 stderr；仅承载界面未接管期间产生的告警。
 * @returns 可同时交给 Core 的 `onWarning` 与 TUI 装配层的接收端。
 */
export function createWarningSink(
	write: WarningWriter = (text): void => {
		process.stderr.write(text);
	},
): WarningSink {
	const pending: string[] = [];
	let handler: WarningHandler | undefined;
	return {
		emit(message: string): void {
			if (handler === undefined) {
				pending.push(message);
				return;
			}
			handler(message);
		},
		bind(next: WarningHandler): void {
			handler = next;
			// 逐条 shift 而不是先清空数组：接收端抛错时未送达的告警仍留在缓冲里
			while (pending.length > 0) {
				const message = pending.shift();
				if (message !== undefined) handler(message);
			}
		},
		unbind(): void {
			handler = undefined;
		},
		flush(): void {
			while (pending.length > 0) {
				const message = pending.shift();
				if (message !== undefined) write(`Warning: ${message}\n`);
			}
		},
	};
}
