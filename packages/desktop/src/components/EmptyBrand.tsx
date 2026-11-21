import type { JSX } from "react";

import { MetaIcon } from "./Icons.tsx";

/** 新任务页与会话空态共用的品牌区：图标、产品名与一句话说明。 */
export function EmptyBrand({
	onExample,
}: {
	/** 传入时展示可点击的场景示例；回调接收示例文本，由调用方回填草稿。会话空态不传。 */
	readonly onExample?: (text: string) => void;
}): JSX.Element {
	return (
		<div className="welcome-brand">
			<span className="welcome-brand-logo">
				<MetaIcon size={30} />
			</span>
			<h2 className="welcome-brand-name">Moros Harness</h2>
			<p className="welcome-brand-desc">轻量、本地优先的办公与编程双场景 Agent</p>
			{onExample === undefined ? null : (
				<div className="welcome-brand-examples">
					<p className="welcome-brand-hint">给它一个任务，试试：</p>
					<div className="welcome-example-list">
						{EXAMPLE_TASKS.map((example) => (
							<button className="welcome-example" key={example} onClick={() => onExample(example)}>
								{example}
							</button>
						))}
					</div>
				</div>
			)}
		</div>
	);
}

const EXAMPLE_TASKS = ["修复这个报错", "给这个函数写测试", "解释这段代码"] as const;
