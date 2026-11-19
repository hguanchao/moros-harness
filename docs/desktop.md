# 桌面端（Electron）

## 1. 定位

桌面端是 Core 的第二个宿主：与 TUI 共用同一套会话目录、事件流、配置、审批与沙箱规则。桌面端不复制 Agent 业务逻辑，只负责窗口、IPC、状态投影与可视化页面。

视觉基线是 `docs/reference/dsh-desktop-preview/replica.html`：40px 全宽标题栏 + 自绘窗口控制、侧栏项目树、左上圆角凹陷主区、760px 对话列与 22px 圆角输入框。设计令牌在 `src/assets/styles/base.css`，页面样式按职责拆分在同一目录。

对应 PRD 功能 34~38：

- 功能 34 文件树：懒加载目录 + 文件监听失效
- 功能 35 Diff：快照行级 Diff，统一 / 并排两种视图
- 功能 36 轨迹：回合 / 模型 / 工具 / 审批 / 文件变更时间线
- 功能 37 会话管理：搜索、归档、回放、分叉、导出、删除
- 功能 38 设置：模型、供应商、审批默认值、通知、主题、Shell、MCP

> 2026-11-18 UI 调整：对话页顶部的上下文/缓存指标、文件/变更/轨迹入口、快速操作面板与「更多」菜单已移除。文件、变更、轨迹页面代码仍保留，但当前没有界面入口；可见导航收敛为侧栏的项目、会话与设置。

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
packages/desktop/                # @moros/desktop
├─ index.html                    # 渲染层 HTML 入口（Vite root = 包根）
├─ electron.vite.config.ts / electron-builder.yml
├─ build/                        # 应用图标（icon.png/ico/svg）
├─ out/                          # 构建产物 main/preload/renderer
├─ dist-desktop/                 # 安装包产物
├─ scripts/desktop-smoke.mjs     # 本地冒烟脚本
└─ src/
   ├─ main.tsx / App.tsx         # 渲染层入口 + 根组件
   ├─ components/                # 共享组件：Composer/Dropdown/Sidebar/TitleBar/
   │                            #   icons/markdown/transcript/PageHeader
   ├─ views/                     # 页面：chat/files/changes/trace/sessions/settings
   ├─ store/state.tsx            # Context + reducer 状态
   ├─ hooks/actions.ts           # useDesktopActions
   ├─ api/api.ts                 # IPC 封装
   ├─ utils/format.ts            # 格式化工具
   ├─ types/                     # 类型声明（global/assets/highlight.js）
   ├─ assets/styles/             # styles.css 聚合入口 + 按职责拆分的样式文件
   ├─ shared/contract.ts         # IPC 通道、DTO、推送消息、RpcResult
   ├─ main/
   │  ├─ index.ts                # app 生命周期、窗口、CSP、权限、PATH
   │  ├─ core-host.ts            # 项目/会话/租约/运行队列/审批/流式缓冲
   │  ├─ ipc.ts                  # 白名单 handler、zod 校验、错误码
   │  ├─ trace.ts                # 事件 -> 回合/步骤投影
   │  └─ store.ts                # 最近项目与窗口位置（userData）
   └─ preload/index.ts
```

渲染层按 React/Vue3 主流 Type-based 结构组织：组件、页面、状态、hooks、API、工具、类型各归其位；全局样式放 `assets/styles/`，`styles.css` 的 `@import` 顺序即级联顺序，不可调整。

## 4. 开发与构建

CLI/TUI 仍由 Node 原生类型擦除直接运行，不经过桌面端构建：

```bash
pnpm dev               # TUI
pnpm test              # 单元测试
pnpm typecheck         # 全仓类型检查
pnpm desktop:dev       # Electron + Vite dev server
pnpm desktop:build     # 产出 packages/desktop/out/{main,preload,renderer}
pnpm desktop:smoke     # 构建后跑本地 mock 端到端冒烟
pnpm desktop:package
```

`electron-vite` 负责 main/preload/renderer 三入口打包；`electron-builder.yml` 提供 Windows NSIS、macOS DMG、Linux AppImage 目标。跨包引用使用 `@moros/*` workspace 包名（由 pnpm 软链与 core 包 `exports` 解析），包内用相对路径，均带显式 `.ts` 后缀。

## 5. 本地冒烟

`packages/desktop/scripts/desktop-smoke.mjs` 会创建临时 HOME、临时项目与本地 mock Chat Completions，覆盖：

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

## 6. 启动与任务归属

- 启动直接显示工作区，不需要先选择项目。已有最近项目时自动恢复最近活动的未归档会话；没有项目、没有可恢复会话或最近项目不可用时显示「新建任务」。不会为了展示页面提前创建空会话。
- 新任务默认不关联项目，可在输入框左上角的下拉菜单中创建项目或选择本地项目。选择只更新草稿关联，不激活该项目的旧会话；取消选择、发送失败会保留输入。首次有效发送时才创建会话，归属确定后不会因选择其他项目而迁移。
- 未关联项目的会话显示在侧栏「任务」分组，工作目录固定为 Electron `userData` 下的 `tasks-workspace`。该目录不加入最近项目，也不是 Core home；配置和会话事件继续使用原有 `MOROS_HOME` / `.moros` 存储。
- 「创建项目」在用户选择的父目录下新建文件夹，不覆盖已有路径，不自动初始化 Git、模板或配置。项目目录不要求是 Git 仓库。
- 选择 Git 项目后，项目选择器右侧显示本地分支下拉（非 Git 仓库或无分支时隐藏）。所选分支只在首次发送前切换：当前分支相同则跳过；工作区有未提交改动、分支已删除或切换失败时阻止发送并保留草稿。分支属于工作区状态，不写入会话元数据，也不会自动创建分支或提交改动。
- 任务与项目共用工作区信任、审批、会话租约和文件路径校验；Shell 的工作目录不等同于操作系统隔离。一个窗口仍只持有一个执行工作区，其他工作区有运行中的任务时需等待结束后再切换，不会静默中断它。

## 7. 双端互操作与租约

- 会话目录与 `stream.jsonl` 是唯一事实源；桌面端退出后 TUI 可直接 `moros --session <id>` 恢复。
- 同一会话同一时刻只允许一个写入者。TUI 占用时桌面端进入只读，发送按钮禁用；用户显式确认后才可 `force` 接管。
- 桌面端同一时刻只跑一轮对话；运行中继续发送会进入队列，当前回合结束后自动发送。

## 8. 安全边界

- 渲染进程不能读文件系统；文件树、预览、Diff、导出全部经主进程调用 Core 的沙箱 API。
- IPC 逐方法校验参数并校验发送方 frame，未知方法不存在。
- 生产 CSP：`script-src 'self'`、`img-src 'self' data: blob:`、`connect-src 'self'`；模型输出里的远程图片不会自动加载。
- Markdown 原始 HTML 一律转义，HTML 再经 DOMPurify 清洗；外链只允许 http/https，统一交给主进程打开。
- 密钥在设置页只显示掩码，显示原文需要显式点击。

## 9. 当前限制

- 单窗口单项目；多窗口、多项目标签页尚未实现。
- 桌面端没有自动更新、代码签名与安装包 CI。
- 图片输入支持文件选择、剪贴板粘贴、拖拽与 http/https 链接；链接由 Core 做私网/回环地址与重定向校验。
- 文件、变更、轨迹页面暂无界面入口；需要恢复时从对话页顶部重新挂入口即可。
- 插件、自动化任务、成果预览等预览稿里的概念不在 V1 PRD 桌面功能范围内，未实现。
- 窗口按钮使用系统 titleBar overlay，未自绘最小化/最大化/关闭。

- Windows NSIS 安装包已在本机验证；macOS / Linux 目标未实测。
- 代码签名与公证未配置，安装包使用默认 Electron 图标。
- 跨平台打包请在目标操作系统上执行 `desktop:package`（`electronDist` 指向本机 Electron 发行版）。
