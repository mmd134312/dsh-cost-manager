# 更新日志 / Changelog

本文件记录对用户可见的变化。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## [1.2.1] — 2026-10-02

**把真机截图放进 README，并补上 DSH 版本要求。**

### Added

- `assets/screenshot-1.png` —— 真机截图：底部读数行里多出的那一格
  （`已用人民币 10.27`，悬停态的浅灰圆角底与原生读数粒一致）。
- `assets/screenshot-2.png` —— 真机截图：点击后弹出的明细面板。
- README 增加「DSH 版本要求」小节，含版本对照表。

### Changed

- README 顶部原来的界面复刻图（`assets/banner.svg`）替换为上面两张真机截图。
  `banner.svg` 与 `assets/mockup.html` 保留在仓库里，改样式时仍可当参照。

## [1.2.0] — 2026-10-02

**变成真正的 profile bundle：终于出现在「设置 → 插件」的列表里。**

### Added

- `dsh.bundle.patch` 声明 + 包内 `cordis.patch.yml`：插件现在是个正规 bundle，
  可启用 / 停用 / 卸载，不再只是用户补丁里的一行。
- `locale/zh.json`：插件列表里显示中文名（花费计量）与说明。
- `LICENSE`（MIT）、`README.md`、`CHANGELOG.md`：开源发布物料。
- `package.json` 补全 npm 元数据：repository / homepage / bugs / keywords /
  engines / displayName。

### Changed

- 安装方式改为「装成 profile 依赖」(`dsh plugin add` 或插件页面的安装框)，
  不再需要手改 profile 的 `cordis.patch.yml`。
- 走 `link:` 装的话，改代码不需要重新安装。

### Removed

- **悬停气泡彻底删除。** 明细只在**点击**时以面板形式给出；悬停只保留那一格
  自己的浅灰圆角底（与原生读数粒一致）。

### Fixed

- `package.json` 的 `private` 从 `true` 改为 `false`（要发布就不能是私有包）。

## [1.1.0] — 2026-10-02

**界面重做：从"能用"到"看着不像外挂"。**

### Added

- **点击面板**：抄官方 `stat-dialog.module.css` 的排版（标题行 + `.5px` 分隔线 +
  `dl` 两列网格），位置用官方 `useAnchoredPosition`（`side: top` 在触发格上方、
  左对齐、贴边距 12），点外部 / `Esc` 关闭。
- **回溯补齐**：中途装上也能从会话第一天算起。读会话日志（zstd 多帧解压），
  按各自发生时刻的峰谷档补进账本；防重复判据是账本里的 `firstAt`。
- `aria-label` 带一行摘要，键盘 / 屏幕阅读器用户不缺信息。

### Changed

- **排版逐字对齐官方**：底部那一格改用 `StatsPills.module.css` 的字号、颜色、
  内边距、圆角、悬停态；文字从 `¥6.95` 改成 `已用人民币 6.95`。
- **缓存命中率口径改为与计费同源**：`命中 / (命中 + 未命中)`，不再出现
  "命中率 99% 但金额对不上"。
- 离线自测从 16 项扩到 66 项，加了假 React 的 `renderTree()`（替 React 调用
  函数组件），否则"断言官方 Tooltip 被调用"其实是在测自己的替身。

### Fixed

- **缓存未命中口径算错（系统性少算钱）**：`priceOf` 里写成
  `miss = inputTokens − cacheRead`，但 DSH 的 `inputTokens` **就是**未命中数
  （官方定义 `prompt_tokens = prompt_cache_hit_tokens + prompt_cache_miss_tokens`），
  所以减重了。修完同一条会话的金额从 ¥0.71 量级升到 ¥4.5 量级。
- **峰谷判定收到裸数字导致"永远空闲"**：`isPeak` 期望 `Date`，有一处传了毫秒数，
  `date.getTime()` 返回 `undefined` → `NaN` → 所有调用都被判成空闲档。
  修法是在入口加 `asDate()` 归一，而不是在调用点补 `new Date()`。
- 回溯补齐的循环里顺手回写了 `firstAt`，把判定边界往前推，导致**10 条只补进 1 条**。
- 旧插件实例的内存账本会覆盖磁盘 → 加 `reloadIfChanged()`（比对 mtime + size）。

### Tried and reverted

- 悬停用官方 `Tooltip` 原语（两版：原样 + `portal: true`）。它的气泡底色是
  `--dsw-alias-tooltip-bg: var(--dsw-static-neutral-bluish-850)` —— **浅色主题下
  也是深灰近乎黑**，放在浅色读数旁边就是一块黑方块。`portal` 解决的是"被
  stacking context 夹住"，跟颜色无关，所以加了也没用。
- 自绘浅色悬停气泡（官方弹层面色）。实现没问题，但用户"根本不想要悬停出东西"。
  两版都记在 `UI-NOTES.md`。

## [1.0.0] — 2026-10-01

**首个可用版本。**

### Added

- 宿主半：`llm/stream` 里观测 `usage` chunk，按 provider 路由名判定是否官方通道，
  按官方峰谷价目表计算花费，写入 `${DSH_HOME}/dsh-cost/ledger.json`（v2 schema，
  每会话一条，只做增量累加）。
- 价目表带版本（`from` + `id`）：历史区间按 `effectiveFrom` 分段，旧价不追溯。
- 定价指纹 + `repriceIfNeeded`：指纹变了才按新价精确重放一次，且带下限保护
  （只认更贵，不让已显示的金额缩水）。
- 浏览器半 `client.js`：官方 `dsh.client` 惰性工厂，注册进
  `conversation.composer.dock`，`order: 10` 排在原生 session-stats 后面。
- 只读接口 `GET /dsh-cost/api`，scope = `session` / `all` / `current` / `dump`。
- 可选 `cost-config.json`：节假日表、额外官方 provider、币种、显示开关。
