# dsh-cost-meter —— 底部那行的「已用人民币 X」

在对话底部那行 `1 轮 · 18 步 | LLM 1 次27m | … | 缓存命中 93% | 输入 632k tok` 的
末尾，补上一格**已用人民币 X**。只在走 DeepSeek 官方通道时出现；换到第三方中转
渠道时那一行保持原样，一个字符都不多。

## 界面（刻意与原生对齐，不是"自己觉得好看"）

排版逐条抄自官方实现，所以放在原生读数旁边不会违和：

| 元素 | 抄的是谁 | 关键参数 |
|---|---|---|
| 底部那一格 | `@deepseek-ai/dsh-client-ui-chat` 的 `StatsPills.module.css` | `font-size: calc(var(--dsh-content-font-size-secondary,13px) - 1px)`、`color: var(--dsw-alias-label-tertiary)`、`padding: 1px 8px`、`border-radius: 999px`、图标 14×14 |
| 悬停 | **不出任何浮层**（只有那一格自己的浅灰圆角底，与原生一致） | 明细只在点击时给 |
| 点击面板 | 官方 `stat-dialog.module.css`（会话统计／Token 用量那个） | `side: top` + 左对齐（面板在格子上方）、`border-radius: var(--dsw-radius-lg)`、`background: var(--dsw-specific-menu)`、`padding: 16px`、`font-size: 12px/18px`、标题行 + `.5px` 分隔线 + `dl` 两列网格 |

悬停变灰底、点开时格子保持 `aria-expanded=true` 的灰底 —— 与原生那两粒完全一致。
无障碍名称（`aria-label`）带一行摘要，键盘/屏幕阅读器用户不缺信息。

## 文件清单

| 文件 | 说明 |
|---|---|
| `dsh-cost-meter.mjs` | **宿主半**：记账、峰谷定价、回溯补齐、`/dsh-cost/api` |
| `client.js` | **浏览器半**：底部那一格 + 点击面板 |
| `package.json` | 包声明：`dsh.bundle.patch`（让它出现在插件列表里）+ `dsh.client`（让宿主提供浏览器半） |
| `cordis.patch.yml` | **bundle 补丁**：本包被装成依赖时插哪一行 |
| `locale/zh.json` | 插件列表里显示的中文名与说明 |
| `examples/cost-config.json` | 可选配置示例（节假日表、额外官方 provider） |
| `INSTALL.md` | 本文件 |

数据落在 `${DSH_HOME}/dsh-cost/`（Windows 即 `%USERPROFILE%\.dsh\dsh-cost\`）：

- `ledger.json` —— 每个会话一份独立账本，只做增量累加
- `cost-config.json` —— 可选覆盖（节假日表、额外官方 provider、币种、开关）

## 安装：装成**真正的 profile bundle**（推荐，插件列表里可见可管理）

最早的做法是往 profile 的 `cordis.patch.yml` 里写一段 `insert`。那样插件**能跑**，
但**不会出现在「设置 → 插件」的列表里** —— 因为列表枚举的是
`package.json` 的 `dsh.profile.bundles`（bundle），而不是用户补丁里的行。

判定一个包是不是 bundle 的唯一条件，是它的 `package.json` 里有没有：

```json
"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
```

### 步骤（用 DSH 自带的安装器，不用手改文件）

在「设置 → 插件」页面用安装框填入包的**绝对路径**，或者让 agent 调
`plugin_manager` 的 `install_bundle`：

```
plugin_manager { action: "install_bundle", target: "F:\\...\\cost-pkg" }
```

它会用 pnpm 把包装成 profile 依赖（`link:` 指向你给的目录），选进
`dsh.profile.bundles`，然后立即可用。装完 `list_bundles` 里就能看到它，
带版本、中文说明、可启用/停用/卸载。

> ⚠️ **不要用相对路径 + `?v=`。** 这是本项目最初踩过的坑：loader 用
> `pathToFileURL()` 生成模块地址，`?` 会被编码成 `%3F`，模块名变成
> `dsh-cost-meter.mjs%3Fv=1` → `ERR_MODULE_NOT_FOUND`，插件**静默不挂载**
> （路由 404、`fiberPhase` 为 null，日志里也不吵）。
>
> 官方约定见 <https://deepseek-harness.github.io/deepseek-harness/en/develop/basic/publish>：
> plugin rows **reference the package by name instead of a relative source path
> so Node resolution finds the installed code**。

> ⚠️ **装了 bundle 之后，要把 profile 的 `cordis.patch.yml` 里那段同名 `insert`
> 删掉。** bundle 补丁已经插过一行了，两处都写会让插件注册两次。
> 官方在 `dsh-todo-board` 的补丁文件里也专门写了这条。

### 包目录结构

```
cost-pkg\
    ├── package.json
    ├── cordis.patch.yml      ← dsh.bundle.patch 指向它
    ├── locale\zh.json        ← 插件列表里的中文名/说明
    ├── dsh-cost-meter.mjs    ← 宿主半
    └── lib\
        └── client.js         ← 浏览器半（必须在这个路径上）
```

### 更新插件

因为依赖是 `link:` 指向工作区目录（`F:\ds harness workbase 1st\cost-pkg`），
**改完文件不需要重新安装**，也不用手动往 profile 里拷：

- 只改 **浏览器半**（`client.js`）：保存即生效。宿主侧 HMR 按 mtime/大小
  发现新 revision，页面上的插件会被自动替换，**不必刷新**。
- 改 **宿主半**（`dsh-cost-meter.mjs`）：ESM 模块有缓存，**要重启 DSH**。
- 改 **`cordis.patch.yml` 或 `locale/`**：走配置 HMR，一般不用重启。
- 要换路径（比如把包挪到别处）：在插件页面卸载再重装，或者
  `plugin_manager { action: "remove_bundle" }` 后重新 `install_bundle`。

## 验证

| 检查 | 期望 |
|---|---|
| 「设置 → 插件」的 bundle 列表 | 出现 **dsh-cost-meter 1.2.0**，带中文说明，可启用 / 停用 / 卸载 |
| `plugin_manager { action: "list_bundles" }` | 同上，`enabled: true, installed: true, removable: true`，`rows` 只有一行 |
| `plugin_manager { action: "list_plugins" }` | `include:dsh-cost-meter` → `fiberPhase: "active"`，`patchId: "dsh-cost-meter"`（来自 bundle 补丁） |
| 同一条**没有出现两次** | `list_plugins` 的 `total` 与装 bundle 前一致（当前 189） |
| `%USERPROFILE%\.dsh\dsh-cost\ledger.json` | 插件装载后即被创建 |
| 底部那行 | 末尾多一格 `已用人民币 X`，与前后原生文字**同字体、同颜色、同内边距** |
| 鼠标悬停那一格 | **只变灰底，不出任何浮层**（与原生那两粒一致） |
| 点击那一格 | **上方**弹出左对齐圆角面板：标题行（图标 + 「本会话花费」 + 金额）、细分隔线、`dl` 两列明细；点外部或 `Esc` 关闭 |
| 离线自测 | `node verify/check-client-bundle.mjs`（66 项，含金额/明细/无障碍文案的逐字断言，以及"没有悬停浮层"的钉死断言） |

`/dsh-cost/api` 借用了 harness 自己的信任闸（`connection.requestRejection`），
所以**要带浏览器会话凭据**才读得到；用 PowerShell 裸请求会拿到 **401**（这是对的，
404 才说明没挂载）。想自检就直接看 `ledger.json`。

## 计费口径（重要，先读这段）

- **只有官方通道计费。** 判据是 **provider 路由名**（`deepseek-official` 等，可用
  `cost-config.json` 的 `providers` 追加），**不是模型名**。所以中转站里那些
  叫 `［phythm］Deepseek-v4-flash` 的模型一律不算 —— 官方账号登录、以及拿别人的
  官方 Key 走同一个 provider，都算官方。
- **峰谷按官方口径**：北京时间周一至周五 9:00–12:00、14:00–18:00 为高峰，
  其余时间（含周末与中国法定节假日）为空闲；空闲价 = 高峰价的一半。
  三类 token（命中输入 / 未命中输入 / 输出）各自都有两档。
- **单价来源**：<https://api-docs.deepseek.com/zh-cn/quick_start/pricing>
  `deepseek-flash` 命中 0.02 / 未命中 1 / 输出 4 元每百万 tokens（高峰 ×2），
  `deepseek-v4-pro` 命中 0.15 / 未命中 4.5 / 输出 13.5（高峰 ×2）。
  旧名 `deepseek-v4-flash`、`deepseek-v4-flash-vision-exp` 按官方说明
  仍可调用、按 Flash 计价，插件里已映射。
- **从装载那一刻起算，并回溯补齐历史。** 首次遇到某会话时读它的会话日志
  （zstd 多帧解压），把装载前、且**走官方通道**的调用按各自发生时刻的峰谷档
  逐条补进账本；防重复的判据是账本里的 `firstAt`。补不到的（例如日志已删）
  明细里会写"从装载那刻起计"。
- **不认识的模型**：官方通道上遇到价目表里没有的模型，会记一笔"未计价"，
  明细里明说，绝不编一个数字。

## 政策变了怎么办

价目表在插件里有版本指纹（含价目、峰谷规则、节假日表）。发现某会话账本上的指纹
与当前不一致时，用当前价目把该会话的历史累计 token **精确重算一次**（按记录的三类
token 与历史峰谷调用次数分摊），写回新指纹，之后继续走增量。重算带**下限保护**：
只会认得更贵，不会让已显示的金额缩水。

要改价或加新档位，编辑 `TARIFFS` 新增一条 `from` 更晚的记录 —— **不要改旧档位的数字**
（那会让历史被新价追溯）。

## 已知限制

- 单次调用跨越峰谷切换点时，按**调用完成时刻**归入某一档，不做按时长摊分。
- 金额是按官方价目表算的**估算**，不是账单接口返回值（官方没有价格查询接口）。
- 子代理有独立会话 id，花销记在各自账本，不并进当前会话那一格。
- 2026 年节假日表是**按惯例预排**，非官方原文；公布后用 `cost-config.json`
  的 `holidays` 覆盖，改完下个轮询周期生效。
