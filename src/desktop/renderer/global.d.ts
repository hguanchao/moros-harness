import type { DesktopBridge } from "#src/desktop/shared/contract.ts";

declare global {
	interface Window {
		readonly moros: DesktopBridge;
	}
}

export {};
