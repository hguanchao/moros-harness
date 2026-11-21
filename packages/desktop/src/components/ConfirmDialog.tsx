import { createContext, useCallback, useContext, useEffect, useRef, useState, type JSX, type ReactNode } from "react";

import { XIcon } from "./Icons.tsx";

/** 确认弹窗请求：标题 + 正文 + 确认按钮文案；danger 时确认按钮为危险样式。 */
export interface ConfirmRequest {
	readonly title: string;
	readonly message: string;
	/** 确认按钮文案；缺省为「确定」。 */
	readonly confirmLabel?: string;
	/** 危险操作（删除/回滚等）时确认按钮显示为危险样式。 */
	readonly danger?: boolean;
}

interface ConfirmContextValue {
	readonly confirm: (request: ConfirmRequest) => Promise<boolean>;
}

const ConfirmContext = createContext<ConfirmContextValue | undefined>(undefined);

/**
 * 统一确认弹窗：替代原生 window.confirm，与应用内模态共用一套样式。
 * `confirm()` 返回 Promise<boolean>——确认 true，取消/关闭/Esc false；未决期间再次调用时前者按取消结算。
 */
export function ConfirmProvider({ children }: { readonly children: ReactNode }): JSX.Element {
	const [request, setRequest] = useState<ConfirmRequest | undefined>(undefined);
	const resolver = useRef<((confirmed: boolean) => void) | undefined>(undefined);

	const confirm = useCallback((next: ConfirmRequest): Promise<boolean> => {
		return new Promise<boolean>((resolve) => {
			resolver.current?.(false);
			resolver.current = resolve;
			setRequest(next);
		});
	}, []);

	const settle = useCallback((confirmed: boolean): void => {
		resolver.current?.(confirmed);
		resolver.current = undefined;
		setRequest(undefined);
	}, []);

	useEffect(() => {
		if (request === undefined) return;
		const onKeyDown = (event: KeyboardEvent): void => {
			if (event.key === "Escape") settle(false);
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [request, settle]);

	return (
		<ConfirmContext.Provider value={{ confirm }}>
			{children}
			{request === undefined ? null : (
				<div className="modal-backdrop" onClick={() => settle(false)}>
					<div
						className="modal confirm-modal"
						role="dialog"
						aria-modal="true"
						aria-label={request.title}
						onClick={(event) => event.stopPropagation()}
					>
						<div className="modal-head">
							<h2>{request.title}</h2>
							<button className="icon-button" aria-label="关闭" onClick={() => settle(false)}>
								<XIcon size={16} />
							</button>
						</div>
						<p className="confirm-message">{request.message}</p>
						<div className="modal-actions">
							<button className="ghost-button" onClick={() => settle(false)}>
								取消
							</button>
							<button
								className={request.danger === true ? "danger-button" : "primary-button"}
								autoFocus
								onClick={() => settle(true)}
							>
								{request.confirmLabel ?? "确定"}
							</button>
						</div>
					</div>
				</div>
			)}
		</ConfirmContext.Provider>
	);
}

/** 发起一次应用内确认弹窗；必须在 ConfirmProvider 内使用。 */
export function useConfirm(): ConfirmContextValue {
	const value = useContext(ConfirmContext);
	if (value === undefined) throw new Error("useConfirm must be used inside ConfirmProvider");
	return value;
}
