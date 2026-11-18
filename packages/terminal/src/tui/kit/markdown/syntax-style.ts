import type { SyntaxToken } from "./syntax.ts";
import type { Theme } from "../../term/index.ts";

/** 语法角色到颜色；无角色表示普通正文。 */
export function syntaxColor(token: SyntaxToken | undefined, theme: Theme): string {
	switch (token) {
		case "keyword":
			return theme.syntaxKeyword;
		case "string":
			return theme.syntaxString;
		case "number":
			return theme.syntaxNumber;
		case "comment":
			return theme.syntaxComment;
		case "function":
			return theme.syntaxFunction;
		case "type":
			return theme.syntaxType;
		case "property":
			return theme.syntaxType;
		case "operator":
			return theme.syntaxOperator;
		default:
			return theme.textPrimary;
	}
}
