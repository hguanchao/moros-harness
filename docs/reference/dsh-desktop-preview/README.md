# DSH 官网预览窗格（HarnessDesktopPreview）还原

## 这是什么

`https://www.deepseek.com/harness/` 首屏那个「桌面应用窗口」演示组件的**静态还原**。
`HarnessDesktopPreview_window__H_Vvy` 是该组件 CSS Modules 生成的类名（`组件名__局部名__hash`），
不是 DeepSeek Harness 开源仓库里的文件。

## 来源与获取方式

| 项 | 说明 |
| --- | --- |
| DOM | 官网首屏为 Next.js SSR 直出，`index.html` 里的 `<div class="HarnessDesktopPreview_viewport__3ixGZ">` 整棵子树可原样取出（38 KB） |
| 样式 | 来自 `/_next/static/css/c10abea4914501ec.css`，筛出 84 条 `HarnessDesktopPreview_*` 规则，保留 `@media` / `@container` 层级 |
| TSX 源码 | **不可得**。官网前端未开源，`deepseek-ai/deepseek-harness` 仓库（MIT，21k 文件）内没有任何 `HarnessDesktopPreview` 文件，只有 `apps/desktop`（Electron 壳）与 `apps/web`（真正的产品 UI） |
| 交互逻辑 | 在 `/_next/static/chunks/app/[locale]/harness/page-*.js` 里，已压缩混淆，未还原 |

## 文件

- `index.html` — 抽取版：原 DOM + 原 CSS + 最小 reset + 7 个 Tailwind 工具类兜底；顶部滑块可改窗格宽度，用来观察容器查询行为。
- `replica.html` — **手写复刻版**：零依赖单文件，类名与 CSS 结构全部重写，可读可改；Windows 11 标题栏，带交互。

## 复刻版实现要点

标题栏按 Windows 11 规范做：40u 高、横跨整个窗口，与侧栏共用同一底色 `--surface-sidebar`（无分隔线，左侧连成一整块），左侧只留侧栏开关，右侧最小化 / 最大化 / 关闭三键（命中区 46×40u，关闭键悬停转 `#c42b1c`）。窗口本体走桌面窗口的直角形态，外圆角统一由 `--radius-window: 0` 控制，红块四角随窗口裁切。内容区左上角单独 `calc(var(--u) * 12)` 圆角，露出窗口底色（与侧栏同色）形成面板嵌入感；为此窗口底色也从 `#17181b` 换成 `--surface-sidebar`。侧栏不再画右侧描边，改用内容面板自身的两层 `box-shadow`（左 `-1px 0 10px .28`、上 `0 -1px 8px .18`）压出淡淡投影，让面板从底色上浮起。

圆角只有一档：`--r-surface: calc(var(--u) * 22)` ≈ 19.8px，内容区左上角与输入框共用。数值按同心圆法则推导——内部加号按钮半径 12.6 + 内边距 7.2 ≈ 19.8，这样卡片弧与按钮弧同心。曾试过 26.2px（φ²，与面板 16.2 构成黄金比），但弧心离角 26.2、按钮弧心只有 19.8，两条弧不同心，壳和芯会互相打架，故废弃。三键都有实际行为：最小化收成标题栏条（点标题栏还原）、最大化切换为通栏并换成「向下还原」图标、关闭显示可恢复的空态。侧栏底部是一行「账户头像 + 设置齿轮」，两端对齐。

布局尺寸全部由 `--u` 派生，`--u` 又来自容器宽度：

```css
.desktop { --ui-scale: 0.9; --u: calc(1px * var(--ui-scale));
           container-type: inline-size; height: calc(var(--u) * 680); }
.sidebar { --ui-scale: 0.88; }         /* 侧栏单独一档缩放 */
```

交互：侧栏收起/展开、`已思考` 折叠（`grid-template-rows: 0fr → 1fr` 过渡）、会话选中、输入框自增高、Enter 发送并追加消息、模型/权限菜单为静态占位。
响应式：窄于 640px 时侧栏隐藏、窗口 680→560、标题栏按钮收窄，无需再模拟原生窗口控件。

## 能力视图（对应官网「能力不断拓展，工作由你掌握」四张卡）

| 官网卡片 | 复刻实现 | 入口 |
| --- | --- | --- |
| 一切皆插件 | 插件管理页：官方 6 项 + 「我的」1 项，含 Beta 徽标、说明文案、开关；右上刷新 + 添加插件 | 侧栏「插件」 |
| 完成各类任务 | 成果预览侧板：7 个文件卡（docx/xlsx/html/ts/py/pdf/md）+ `src/label.ts` 的 `+2 −1` diff（含行号与 @@ hunk） | 会话右上「成果预览」图标 |
| 适应你的工作方式 | 自动化任务页：新建任务输入行 + 任务卡（计划时间 / 重复 / 状态：等待触发·已完成·运行中） | 侧栏「自动化任务」 |
| 开发者工具 | 执行轨迹：三泳道时间线（Input/Model/Tools）、Turn 分栏 + 竖轨圆点的回合列表（SYSTEM/USER/CONTEXT/ASSISTANT/TOOL 彩色标签、选中行左侧蓝条）、右侧详情面板（Summary/Payload/Result/Schema/Timing） | 会话标题旁「轨迹」标签 |

执行轨迹完全按官网 `feat-trace-zh.webp` 的布局重做：工具条是纯文本项（Duration / Turns / Calls / Export）+ 右侧搜索框；时间线三条轨道分别是绿（Input，含蓝灰段）、紫（Model）、橙（Tools，其中一块带蓝色描边高亮）；列表左侧有 `Turn 1..3` 栏位与竖轨圆点，行内是定宽彩色标签、被截断的正文和 `←` 开头的结果摘要，选中行有左侧 2u 蓝色标记；详情面板按 `TOOL · Turn 3 · Step 1` 组织，Payload 用带键/值着色的代码块。轨迹视图复用会话的输入框（占位文案切换为「给智能体发消息」），插件与自动化任务页则隐藏输入框。

视图切换由 `.desktop[data-view]` + `.view.is-active` 控制；切到插件/自动化任务时隐藏会话标题栏，切走会话时自动关闭成果面板。成果面板打开时在宽窗下挤压会话区（`@container (min-width: 641px)`），窄窗则整屏覆盖。

## 对话内的工作过程（工具调用流）

会话里第二个回合还原了「帮我写一个番茄时钟插件」的完整执行流：`深度求索中` 标题（带折叠箭头，用 `grid-template-rows: 0fr → 1fr` 收起）+ 10 行步骤。每行是「图标 · 动作 · 目标 · 可选 diff」：

| 动作 | 目标形态 | 备注 |
| --- | --- | --- |
| 加载技能 / 读取 / 写入 / 编辑 | 文件路径，点状虚线下划线 | 写入/编辑带 `+N −M` 统计 |
| 思考 | 一句被截断的推理文本 | 整行降饱和 `#9a9ea8` |
| 检查提供方 / 查询运行时 | 计数或运行时 API | 标签与图标染蓝 `#88aff2`、字重 500 |
| 工具调用 | `plugin_manager · install_bundle` | 四角星图标 |
| 运行命令 | 命令用途描述 | 终端箭头图标 |

配色取自官网 `HarnessPluginsPreview` 的真实样式（行文字 `#c5c7ce`、目标 `#a7aab3`、分隔点 `#6b6e75`），目标过长时 `text-overflow: ellipsis`，窄窗仍然单行不换行。

与原文的差异：品牌字样用纯文本 `deepseek` + `HARNESS` 徽标，未内嵌官方鲸鱼 logo；背景光晕用中性深色替代。

## 结构速查

```
.viewport            容器查询宿主（container-type: inline-size）
└ .window            680/560px 高，--u 由 --ui-scale 缩放，直角 + 外阴影
  ├ .sidebar         260px 玻璃侧栏（≤640px 时 display:none）
  │ ├ .windowBar     红黄绿圆点 + 折叠图标
  │ ├ .newChat / .plugin / .automation / .workspace / .footer
  └ 主区
    ├ 顶部标题栏
    ├ .messages      用户气泡 / 思考折叠 / Markdown 正文
    └ .composer      输入框 + 模型选择（DeepSeek-V41-Flash High）
```

## 与原站的差异

1. 页面底色换成中性深色渐变（原站是品牌光晕背景），组件本身样式未改。
2. 未内嵌原站字体文件，回落到系统字体栈（组件自身已声明 `-apple-system … PingFang SC`）。
3. 所有 `calc(var(--u) * n)` 依赖 `container-type` 生效，直接拷进非容器父级会失去等比缩放。
