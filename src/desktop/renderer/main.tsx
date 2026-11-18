import { createRoot } from "react-dom/client";

import { App } from "#src/desktop/renderer/App.tsx";
import { AppProvider } from "#src/desktop/renderer/state.tsx";
import "#src/desktop/renderer/styles.css";
import "#src/desktop/renderer/replica.css";

const container = document.getElementById("root");
if (container === null) throw new Error("Renderer root element is missing");

// 不用 StrictMode：开发态的双重 effect 会重复调用主进程的初始化与事件订阅。
createRoot(container).render(
	<AppProvider>
		<App />
	</AppProvider>,
);
