import type { JSX } from "react";

import { MetaIcon } from "./Icons.tsx";

/** 新任务页与会话空态共用的品牌区：图标、产品名与一句话说明。 */
export function EmptyBrand(): JSX.Element {
	return (
		<div className="welcome-brand">
			<span className="welcome-brand-logo">
				<MetaIcon size={30} />
			</span>
			<h2 className="welcome-brand-name">Moros Harness</h2>
			<p className="welcome-brand-desc">轻量、本地优先的办公与编程双场景 Agent</p>
		</div>
	);
}
