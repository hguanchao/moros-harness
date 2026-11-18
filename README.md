# Moros Harness

轻量、本地优先的办公与编程双场景 Agent Harness。同一套 Core 同时服务终端（TUI/CLI）与桌面端（Electron），会话、配置、权限、审批与事件流完全共用。

- **无服务、无数据库**：会话以 append-only `stream.jsonl` 为唯一事实源。
- **受控执行**：路径沙箱、快照、审批三档（ask/auto/yolo）、denylist、审计、回滚、断点、回放。
- **模型解耦**：内置 Anthropic Messages、Chat Completions、Responses 三个协议端点。
- **不捆绑运行时**：Git/Docker/Node/Python 等只探测与调度本机已有环境。
- **端侧**：TUI/CLI 由 Node 直接运行源码；桌面端为独立 Electron 分发。

## 环境

- Node.js ≥ 22.18（CLI/TUI 使用原生类型擦除直接运行 TypeScript）
- npm

```bash
npm install
```

## 使用

```bash
npm run dev                  # 启动 TUI
npm run dev -- --help        # CLI 帮助
npm run dev -- doctor        # 本机配置与工具探测
```

全局配置位于 `~/.moros/`：`config.toml`、`providers.json`、`skills/` 与会话目录。

桌面端：

```bash
npm run desktop:dev          # Electron + Vite 开发
npm run desktop:build        # 打包 main/preload/renderer 到 out/
npm run desktop:smoke        # 构建后跑本地 mock 端到端冒烟
npm run desktop:package      # 生成当前平台安装包（dist-desktop/）
```

## 质量检查

```bash
npm run check                # Prettier + TypeScript + Vitest + 桌面端构建
```

桌面端设计与限制见 [docs/desktop.md](docs/desktop.md)。MCP 接入见 [docs/mcp.md](docs/mcp.md)，产品需求见 [docs/product-requirements.md](docs/product-requirements.md)。

## 目录

```text
src/core/        # 内核：会话、LLM、工具、Harness、配置、MCP
src/tui/         # 终端界面
src/cli/         # CLI 入口
src/desktop/     # Electron 主进程 / preload / React 渲染层
tests/           # Vitest 测试（镜像 src 分层）
docs/            # 需求、MCP、桌面端文档
scripts/         # 桌面端本地冒烟脚本
```

## 许可

MIT
