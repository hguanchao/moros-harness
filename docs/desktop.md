# 桌面端（Electron）

## 1. 定位

桌面端是 Core 的第二个宿主：与 TUI 共用同一套会话目录、事件流、配置、审批与沙箱规则。桌面端不复制 Agent 业务逻辑，只负责窗口、IPC、状态投影与可视化页面。

视觉基线是 `docs/reference/dsh-desktop-preview/replica.html`：40px 全宽标题栏 + 自绘窗口控制、侧栏项目树、左上圆角凹陷主区、760px 对话列与 22px 圆角输入框。壳与对话页的覆盖样式集中在 `src/desktop/renderer/replica.css`，设计令牌在 `styles.css`。

对应 PRD 功能 34~38：

- 功能 34 文件树：懒加载目录 + 文件监听失效
- 功能 35 Diff：快照行级 Diff，统一 / 并排两种视图
- 功能 36 轨迹：回合 / 模型 / 工具 / 审批 / 文件变更时间线
- 功能 37 会话管理：搜索、归档、回放、分叉、导出、删除
- 功能 38 设置：模型、供应商、审批默认值、通知、主题、Shell、MCP

## 2. 进程模型

```text
Electron 主进程（Node 全权限）
├─ Core（单实例，随项目切换重建）
│  ├─ SessionManager / EventStore
│  ├─ AgentLoop / ToolPipeline / ApprovalBroker
│  └─ LLM / MCP / 沙箱 / 快照
├─ DesktopHost：项目、当前会话、租约、运行队列、流式缓冲
└─ IPC handlers（参数校验 + 发送方校验）

Preload（contextBridge + sandbox）
└─ window.moros（窄接口，无 Node 能力）

Renderer（React，无 Node 权限）
└─ 对话 / 文件 / 变更 / 轨迹 / 会话 / 设置
```

关键决策：

- **Core 跑在主进程**，不另起 daemon / sidecar；V1 单窗口单项目，切换项目时 `dispose()` 旧 Core 后重建，避免 MCP 子进程与配置缓存跨项目累积。
- **preload 输出 CJS**，窗口保持 `sandbox: true`、`contextIsolation: true`、`nodeIntegration: false`。
- **审批失败即拒绝**：窗口关闭、渲染进程崩溃或 Core 释放时 `broker.denyAll()`；IPC 返回结构化 `RpcResult`，不在异常字符串里藏业务码。

## 3. 目录

```text
src/desktop/
├─ shared/contract.ts     # IPC 通道、DTO、推送消息、RpcResult
├─ main/
│  ├─ index.ts            # app 生命周期、窗口、CSP、权限、PATH
│  ├─ core-host.ts        # 项目/会话/租约/运行队列/审批/流式缓冲
│  ├─ ipc.ts              # 白名单 handler、zod 校验、错误码
│  ├─ trace.ts            # 事件 -> 回合/步骤投影
│  └─ store.ts            # 最近项目与窗口位置（userData）
├─ preload/index.ts
└─ renderer/
   ├─ App.tsx / state.tsx / actions.ts
   ├─ pages/              # chat / files / changes / trace / sessions / settings
   ├─ Composer.tsx / transcript.tsx / Sidebar.tsx / TitleBar.tsx
   └─ styles.css
```

## 4. 开发与构建

CLI/TUI 仍由 Node 原生类型擦除直接运行，不经过桌面端构建：

```bash
npm run dev            # TUI
npm test               # 单元测试
npm run typecheck      # 全仓类型检查
npm run desktop:dev    # Electron + Vite dev server
npm run desktop:build  # 产出 out/main、out/preload、out/renderer
npm run desktop:smoke  # 构建后跑本地 mock 端到端冒烟
npm run desktop:package
```

`electron-vite` 负责 main/preload/renderer 三入口打包；`electron-builder.yml` 提供 Windows NSIS、macOS DMG、Linux AppImage 目标。`package.json` 的 `imports` 是 `#src/*` 的唯一映射，构建器直接复用。

## 5. 本地冒烟

`scripts/desktop-smoke.mjs` 会创建临时 HOME、临时项目与本地 mock Chat Completions，覆盖：

1. 工作区信任页与 AGENTS.md 门控
2. 流式对话
3. 工具调用审批（allow once）
4. 文件写入、文件树实时失效
5. 变更页、统一 / 并排 Diff
6. 单步回滚
7. 计划模式、计划卡、批准后实施
8. 轨迹 / 会话 / 设置页
9. 主题切换
10. 用 Core 重新读取同一份会话事件，验证双端存储互通

截图与临时目录路径由脚本打印。测试专用环境变量：

| 变量                      | 用途                              |
| ------------------------- | --------------------------------- |
| `MOROS_HOME`              | 覆盖 Moros 主目录（配置与会话根） |
| `MOROS_DESKTOP_USER_DATA` | 覆盖 Electron userData            |
| `MOROS_DESKTOP_PROJECT`   | 启动时自动打开的项目              |

生产运行不需要这些变量。macOS 从 Finder 启动时主进程会从登录 shell 补一次 PATH，避免 `git` / `node` 探测不到。

## 6. 双端互操作与租约

- 会话目录与 `stream.jsonl` 是唯一事实源；桌面端退出后 TUI 可直接 `moros --session <id>` 恢复。
- 同一会话同一时刻只允许一个写入者。TUI 占用时桌面端进入只读，发送按钮禁用；用户显式确认后才可 `force` 接管。
- 桌面端同一时刻只跑一轮对话；运行中继续发送会进入队列，当前回合结束后自动发送。

## 7. 安全边界

- 渲染进程不能读文件系统；文件树、预览、Diff、导出全部经主进程调用 Core 的沙箱 API。
- IPC 逐方法校验参数并校验发送方 frame，未知方法不存在。
- 生产 CSP：`script-src 'self'`、`img-src 'self' data: blob:`、`connect-src 'self'`；模型输出里的远程图片不会自动加载。
- Markdown 原始 HTML 一律转义，HTML 再经 DOMPurify 清洗；外链只允许 http/https，统一交给主进程打开。
- 密钥在设置页只显示掩码，显示原文需要显式点击。

## 8. 当前限制

- 单窗口单项目；多窗口、多项目标签页尚未实现。
- 桌面端没有自动更新、代码签名与安装包 CI。
- 图片输入支持文件选择、剪贴板粘贴、拖拽与 http/https 链接；链接由 Core 做私网/回环地址与重定向校验。
- 插件、自动化任务、成果预览等预览稿里的概念不在 V1 PRD 桌面功能范围内，未实现。
- 窗口按钮使用系统 titleBar overlay，未自绘最小化/最大化/关闭。

- Windows NSIS 安装包已在本机验证；macOS / Linux 目标未实测。
- 代码签名与公证未配置，安装包使用默认 Electron 图标。
- 跨平台打包请在目标操作系统上执行 `desktop:package`（`electronDist` 指向本机 Electron 发行版）。
