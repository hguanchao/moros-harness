/** @joplin/turndown-plugin-gfm 未随包发布类型声明；仅暴露本仓库用到的 gfm 插件装配函数。 */
declare module "@joplin/turndown-plugin-gfm" {
	import type TurndownService from "turndown";

	export function gfm(service: TurndownService): void;
}
