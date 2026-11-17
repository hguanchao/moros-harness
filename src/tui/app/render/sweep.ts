/**
 * 运行行动画。
 *
 * 实现与帧数据类型都在 `src/tui/kit`（页脚状态行、任务卡与子代理清单共用同一份扫光）。
 * 这里保留模块路径，是因为应用里有多处按「本应用动画帧」引用它；新增调用请直接用 kit。
 */

export { swept } from "#src/tui/kit/index.ts";
export type { AnimationFrame } from "#src/tui/kit/index.ts";
