import type { JSX, ReactNode } from "react";

import { useDesktopActions } from "../hooks/actions.ts";
import { ChevronLeftIcon } from "./Icons.tsx";

export interface PageHeaderProps {
	readonly title: string;
	readonly subtitle?: string;
	readonly actions?: ReactNode;
}

/** 非对话页统一页头：左侧返回对话，中间标题，右侧操作。 */
export function PageHeader({ title, subtitle, actions }: PageHeaderProps): JSX.Element {
	const desktop = useDesktopActions();
	return (
		<header className="page-head">
			<button
				className="icon-button page-back"
				aria-label="返回对话"
				title="返回对话"
				onClick={() => desktop.setPage("chat")}
			>
				<ChevronLeftIcon size={17} />
			</button>
			<div className="page-head-title">
				<h2>{title}</h2>
				{subtitle === undefined ? null : <p className="page-subtitle">{subtitle}</p>}
			</div>
			{actions === undefined ? null : <div className="page-actions">{actions}</div>}
		</header>
	);
}
