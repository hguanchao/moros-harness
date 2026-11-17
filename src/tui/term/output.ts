/**
 * 终端 I/O 的最小契约。
 *
 * 库只要求「能写字符串」与「能报尺寸」，不认 `process.stdout`：伪终端测试、内存替身与
 * 真实终端因此共用同一条写入路径，不必为测试另开分支。
 */

/** 输出端：只要能把字符串写出去。 */
export interface OutputLike {
	write(chunk: string): unknown;
}

/** 尺寸来源：不同终端在第一次 resize 之前可能给不出行数。 */
export interface SizeLike {
	readonly rows?: number;
	readonly columns?: number;
}
