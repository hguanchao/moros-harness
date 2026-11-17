import { fitToWidth, truncateToWidth, type Theme } from "#src/tui/term/index.ts";
import { el, type ComponentProps, type Node } from "#src/tui/kit/element.ts";
import { padEnd, padStart } from "#src/tui/kit/menu.ts";

/**
 * 表格：把若干列按固定列宽拼成行。
 *
 * 列宽由调用方算好（它依赖真实终端宽度与内容优先级），组件只做对齐、截断与表头着色。
 * 单元格里放不下时补省略号，不会撑破行宽；最后再按总宽整行裁一次，窄屏也安全。
 */

/** 列定义；`width` 是显示列数。 */
export interface TableColumn {
	readonly title: string;
	readonly width: number;
	readonly align?: "left" | "right";
}

export interface TableOptions {
	readonly columns: readonly TableColumn[];
	/** 每行的单元格；缺的按空串处理 */
	readonly rows: readonly (readonly string[])[];
	readonly width: number;
	readonly theme: Theme;
	/** 列间距，默认两列 */
	readonly gap?: number;
	/** 是否画表头行，默认画 */
	readonly header?: boolean;
}

/** 表格的全部屏幕行（表头 + 数据行）。 */
export function tableLines(options: TableOptions): readonly string[] {
	const { columns, theme } = options;
	const gap = " ".repeat(Math.max(0, options.gap ?? 2));
	const width = Math.max(0, options.width);
	const compose = (values: readonly string[]): string =>
		truncateToWidth(
			columns
				.map((column, index) => {
					const columnWidth = Math.max(0, Math.floor(column.width));
					const shown = fitToWidth(values[index] ?? "", columnWidth);
					return column.align === "right" ? padStart(shown, columnWidth) : padEnd(shown, columnWidth);
				})
				.join(gap),
			width,
		);

	const header =
		options.header === false
			? []
			: [`${theme.textSubtle}${compose(columns.map((column) => column.title))}${theme.reset}`];
	return [...header, ...options.rows.map((row) => compose(row))];
}

/** 表格组件：已排好的行交给 `raw` 原语。 */
export function Table(props: Omit<TableOptions, "theme"> & { readonly height?: number } & ComponentProps): Node {
	const { theme, height: _height, ...rest } = props;
	return el("raw", { lines: tableLines({ ...rest, theme }) });
}
