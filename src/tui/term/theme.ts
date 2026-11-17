/**
 * 主题契约。
 *
 * 只有类型没有取值：库不预设配色，调用方把整套 token 传进来。这里定义的是「一个主题
 * 必须提供哪些角色」，不是某套具体颜色的拷贝。
 */

/** 一个 24 位色。扫光这类要逐字符混色的场合需要裸数值而不是 SGR 序列。 */
export interface Rgb {
	readonly r: number;
	readonly g: number;
	readonly b: number;
}

/** 一段已编码好的 SGR 序列，直接拼进输出即可。 */
export type Color = string;

/**
 * 终端界面用到的全部颜色角色。
 *
 * 角色按用途命名，不按具体色值命名：换配色只改取值，调用方引用的角色不变。
 */
export interface Theme {
	/** 浮起表面：提示块、菜单面板 */
	readonly surface: Color;
	/** 指针悬停行底色，比浮起表面略亮一档 */
	readonly hoverBg: Color;
	/** 文本选区底色 */
	readonly selectionBg: Color;
	/** 选区内的文字色；浅色底必须配深色字 */
	readonly selectionFg: Color;
	/** 代码块底色 */
	readonly codeBg: Color;
	/** 展开详情的色带 */
	readonly detailBg: Color;
	/** 主文字 */
	readonly textPrimary: Color;
	/** 次要文字：说明与页脚数值 */
	readonly textSecondary: Color;
	/** 更弱的文字：边框上的数量、状态行元信息 */
	readonly textSubtle: Color;
	/** 不可用内容 */
	readonly textDisabled: Color;
	/** 强调色：焦点、选中标记、当前项 */
	readonly accent: Color;
	/** 强调色的裸数值，供扫光混色使用 */
	readonly accentRgb: Rgb;
	/** 文件路径 */
	readonly path: Color;
	/** 图片引用标记 */
	readonly image: Color;
	/** 扫光暗部 */
	readonly accentDim: Rgb;
	/** 扫光亮点 */
	readonly sweepHighlight: Rgb;
	/** 选中行主文字 */
	readonly selectedText: Color;
	/** 关闭加粗 */
	readonly boldOff: Color;
	/** 边框 */
	readonly border: Color;
	/** 滚动条 */
	readonly scrollbar: Color;
	/** 警告 */
	readonly warning: Color;
	/** 失败 */
	readonly error: Color;
	/** 成功与 diff 新增前景色 */
	readonly success: Color;
	/** diff 新增行底色 */
	readonly diffInsertBg: Color;
	/** diff 删除行底色 */
	readonly diffDeleteBg: Color;
	/** 语法：关键字 */
	readonly syntaxKeyword: Color;
	/** 语法：字符串 */
	readonly syntaxString: Color;
	/** 语法：数字与常量 */
	readonly syntaxNumber: Color;
	/** 语法：注释 */
	readonly syntaxComment: Color;
	/** 语法：函数与成员 */
	readonly syntaxFunction: Color;
	/** 语法：类型与标签 */
	readonly syntaxType: Color;
	/** 语法：属性与变量 */
	readonly syntaxOperator: Color;
	/** 重置颜色与属性 */
	readonly reset: Color;
}
