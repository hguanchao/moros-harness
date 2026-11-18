import type { Theme } from "../term/index.ts";
import { el, type ComponentProps, type Node } from "./element.ts";

/** 按钮：一行高的短目标，focused 只换颜色不改宽度，指针移动时因此不会闪。 */
export interface ButtonProps {
	readonly label: string;
	readonly focused?: boolean;
	readonly disabled?: boolean;
}

/** 带色的整段按钮文本；底色先铺一层，文字色由状态决定。 */
export function buttonText(props: ButtonProps, theme: Theme): string {
	const color = props.disabled === true ? theme.textDisabled : props.focused === true ? theme.accent : theme.textSubtle;
	return `${theme.surface}${color}${props.label}${theme.reset}`;
}

/** 按钮组件：产出一行成品文本，交给 `raw` 原语参与布局。 */
export function Button(props: ButtonProps & ComponentProps): Node {
	const { theme } = props;
	return el("raw", {
		lines: [
			buttonText(
				{
					label: props.label,
					...(props.focused === undefined ? {} : { focused: props.focused }),
					...(props.disabled === undefined ? {} : { disabled: props.disabled }),
				},
				theme,
			),
		],
	});
}
