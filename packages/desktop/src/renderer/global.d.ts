import type { DesktopBridge } from "../shared/contract.ts";

declare global {
	interface Window {
		readonly moros: DesktopBridge;
	}
}

export {};
