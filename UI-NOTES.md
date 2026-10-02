# 界面口径参考 —— 为什么这一格"看着不违和"

用户的原话是「看上去不能违和」。所以底部那一格、悬停气泡、点击面板的每一个
数值都不是我拍的，而是**从官方产物里抄出来的**。这份文件记的是抄录来源与
原始数值，以及验证方式；以后改样式请先回来对一遍，不要凭手感调。

## 抄录来源（都在 `F:\dsh\resources\app.asar` 里）

用 `verify/asar-pull.mjs <asar 内路径>` 把文件拉出来即可：

```
node verify/asar-pull.mjs "/dsh/node_modules/@deepseek-ai/dsh-client-ui-chat/lib/client.js"
node verify/asar-pull.mjs "/dsh/node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js"
node verify/asar-pull.mjs "/dsh/node_modules/@deepseek-ai/dsh-client-ui-primitives/lib/index.js"
```

| 抄的对象 | 在哪个包里 | 用来对齐什么 |
|---|---|---|
| `StatsPills.module.css` | `@deepseek-ai/dsh-client-ui-chat` | 底部那一格的字体、颜色、内边距、圆角、悬停态 |
| `stat-dialog.module.css` + `useStatDialog` | `@deepseek-ai/dsh-client-ui-chat` | 点击面板的排版、尺寸、`dl` 明细网格、定位/关闭行为 |
| `ContextMeter.module.css` | `@deepseek-ai/dsh-client-ui-conversation` | 「同一个 dock 里、点开弹面板」的官方范式（本格与它是兄弟） |
| `InputBar.module.css` 的 `.dock` | `@deepseek-ai/dsh-client-ui-conversation` | 挂载容器：`justify-content:center; gap:12px; padding-top:4px` |
| `Tooltip.module.css` | `@deepseek-ai/dsh-client-ui-primitives` | 悬停气泡的圆角、底色、字号、贴边与翻转 |

## 底部那一格（对齐 StatsPills）

原生「X 轮 X 步 / 缓存命中 XX%」那两粒的原始声明：

```css
.iq1doa_root{ box-sizing:border-box; min-width:0; max-width:100%;
  font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);
  line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px));
  justify-content:center; gap:12px; display:flex }
.iq1doa_pill{ box-sizing:border-box; corner-shape:round; max-width:100%;
  color:var(--dsw-alias-label-tertiary); font:inherit; font-variant-numeric:tabular-nums;
  line-height:inherit; white-space:nowrap; background:0 0; border:none; border-radius:999px;
  align-items:center; gap:6px; padding:1px 8px; display:inline-flex }
.iq1doa_pill svg{ flex:none; width:14px; height:14px }
button.iq1doa_pill{ cursor:pointer }
button.iq1doa_pill:hover,button.iq1doa_pill[aria-expanded=true]{
  background:var(--dsw-alias-interactive-bg-hover); color:var(--dsw-alias-label-secondary) }
.iq1doa_sep{ color:var(--dsw-alias-separator-primary); margin:0 6px }
```

本插件（`.dshcm-rule` / `.dshcm-pill`）逐条对应，**字号与行高写在 `.dshcm-rule`
上而不是靠继承** —— dock 容器上的继承值不一定等于原生自己算出来的 12px，
靠继承会在不同容器里飘。这一点已写进自测断言（见下）。

> 踩坑记录：最早版本用 `ui-monospace` + `font:600 11px/1` + 自己加的 `·` 分隔点，
> 结果放在原生读数旁边一眼就是外来的。浏览器原生的 `title` 提示更违和 ——
> 它又慢又方，跟官方那套圆角气泡完全不是一个东西。

## 点击面板（对齐官方 stat-dialog）

原生「会话统计 / Token 用量」那个面板：

```css
.Xt1eiG_panel{ z-index:1100; box-sizing:border-box; border-radius:var(--dsw-radius-lg);
  background:var(--dsw-specific-menu); width:max-content;
  min-width:min(300px,100vw - 24px); max-width:min(440px,100vw - 24px);
  backdrop-filter:var(--dsw-menu-backdrop-filter);
  --dsw-elevation-stroke-color:var(--dsw-alias-border-l1);
  box-shadow:var(--dsw-elevation-prominent); color:var(--dsw-alias-label-secondary);
  cursor:default; border:0; padding:16px; font-size:12px; line-height:18px; position:fixed }
.Xt1eiG_title{ color:var(--dsw-alias-label-primary); justify-content:space-between;
  gap:16px; margin-bottom:8px; font-weight:500; display:flex }
.Xt1eiG_titleLabel{ align-items:center; gap:6px; min-width:0; display:inline-flex }
.Xt1eiG_titleLabel svg{ flex:none; width:14px; height:14px }
.Xt1eiG_titleRule{ border-top:.5px solid var(--dsw-alias-border-l2); margin-bottom:10px }
.Xt1eiG_details{ color:var(--dsw-alias-label-tertiary);
  grid-template-columns:minmax(76px,auto) minmax(0,1fr); gap:6px 16px; margin:0; display:grid }
.Xt1eiG_details dt,.Xt1eiG_details dd{ min-width:0; margin:0 }
.Xt1eiG_details dd{ color:var(--dsw-alias-label-secondary);
  font-variant-numeric:tabular-nums; text-align:right }
```

位置与关闭行为也照抄官方 `useStatDialog`：

```js
useAnchoredPosition({ open, anchorRef, panelRef, side: 'top', gap: 8, margin: 12 })
```

- `side: 'top'` → 面板在**触发格上方**（用户要的"在上面显示"）
- `align` 默认 `'start'` → **左对齐**触发格的左边（用户要的"左侧对齐"）
- `gap: 8` / `margin: 12` 是官方 `PANEL_GAP` / `PANEL_MARGIN` 常量

## 悬停：**什么都不显示**（这是最终定稿）

这一格尝试过两版悬停提示，**都被用户否决**，所以最终删干净了：

| 版本 | 做法 | 用户的反馈 |
|---|---|---|
| 1 | 官方 `Tooltip` 原语（`side: 'bottom'`） | 「悬停的时候上面那个黑色的块好违和，能去掉吗」 |
| 1b | 同上 + `portal: true` | 「悬停时出现，还在那」——portal 不是根因 |
| 2 | 自绘浅色气泡（官方弹层面色） | 「现在悬停变成这样了，可是我不想要它」 |
| **3（定稿）** | **没有任何悬停浮层** | 明细只在**点击**时以面板形式给出 |

### 版本 1 为什么是黑块（记录下来，别再踩）

不是位置问题，是**配色**问题 —— 官方 Tooltip 的气泡底色令牌：

```css
--dsw-alias-tooltip-bg: var(--dsw-static-neutral-bluish-850);   /* 浅色主题 */
--dsw-alias-tooltip-bg: var(--dsw-static-neutral-bluish-750);   /* 深色主题 */
```

**两套主题都是深灰近乎黑** —— "tooltip 天生就是深色"是这套设计体系的选择。
`portal` 解决的是 "an ancestor's clipping or its stacking context (which confines
the bubble's z-index) cannot hide it"，跟颜色无关，所以加了也没用。

教训：遇到"某个官方组件看着违和"，先查**它用了哪些设计令牌**，再决定是修位置
还是换令牌。位置和配色是两个独立的失败模式，先入为主猜一个会白烧一轮用户反馈。

### 版本 2 为什么也不要

气泡本身做得没问题（浅灰底、细描边、圆角、`pointer-events:none`），但用户**根本
不想要悬停出东西** —— 底部那一行是"安静读数"的地方，多一个浮层就是噪音。
这是需求问题，不是实现问题；实现得再像官方也不对。

### 定稿行为

- 悬停：**只有那一格自己的浅灰圆角底**（`.dshcm-pill:hover`，与原生那两粒一字不差），
  不出任何浮层。
- 点击：上方左对齐的明细面板（`role="dialog"`，点外部 / `Esc` 关闭）。
- 无障碍：`aria-label` 仍带一行摘要（"本会话已用人民币 X，点击查看花费明细"），
  屏幕阅读器用户不会因为"没有悬停提示"而拿不到信息。**不加 `title`** ——
  那会召出浏览器自带的灰色方块提示，正是要去掉的东西。

> 顺带记一个自测上的坑：假 React 的 `createElement` 只记录
> `{__el: type, props}`，**不会调用函数组件** —— 那是 React 的活。
> 所以"断言官方 Tooltip 被调用了"一开始永远失败，其实是测试在测自己的替身。
> `primitives-stub.mjs` 里的 `renderTree()` 就是补这一层的：把树里函数类型的
> 子节点调用一遍，再继续下钻。

## 官方原语怎么进得来（关键，别改成自绘）

插件包只声明了 `dsh.client`，没写 `external`。之所以能直接
`require('@deepseek-ai/dsh-client-ui-primitives')`，是因为**它在平台静态模块表里**
（`dsh-web-frontend` 的 `rM()`，随启动图注入）：

```js
{ react, "react/jsx-runtime", "react-dom", "react-dom/client",
  "@deepseek-ai/cordis", "@deepseek-ai/dsh-client-store",
  "@deepseek-ai/dsh-client-ui-slots",
  "@deepseek-ai/dsh-client-ui-primitives",      // ← 本插件用的 Tooltip / 图标 / hooks
  "@deepseek-ai/dsh-client-ui-dockkit" }
```

同步 `require` 的解析顺序（`dsh-client-modules/lib/client.js` 的 `makeRequire`）：
**平台种子表 → 已物化的模块 → 已注册的包工厂**。种子表命中就够，所以不需要
在任何字段里声明它。`react-dom` 同样来自种子表（`createPortal` 就在里面）。

`bits = require(...)` 外面包了 try/catch：万一哪天种子表里没有它，插件会降级成
自绘的 `title` + 方框图标，**而不是整个格子消失**。这条也有自测覆盖。

## 自测：怎么在不开浏览器的情况下证明"没抄错"

```powershell
node verify/check-client-bundle.mjs      # 69 项
```

它用 `verify/primitives-stub.mjs`（同名同参的离线替身）记录官方原语被怎么调用，
并逐字断言：

- 金额格式：`4.505978 → 4.51`、`0.5 → 0.50`、`0.0042` **不显示成 `0.00`**
- 缓存命中率与**计费**同源：`3M/(3M+1M) = 75%`（分母 = 缓存读取 + 未缓存输入）
- 明细 11 行、含「未缓存输入 / 缓存读取 / 输出」三项分开、含回溯次数、含峰谷金额
- 悬停文案含金额、峰谷拆分、次数 + 命中率、「点击查看明细」
- 字号/颜色/内边距/圆角**逐字**匹配 StatsPills 的声明
- **悬停气泡不依赖官方 Tooltip 的深色配色**，改用官方弹层面色（`--dsw-specific-menu`）
- 悬停气泡在**下方**（`side: bottom`）、面板在**上方**（`side: top`），两者都 portal 到 body
- `apply` 在缺少官方原语时不抛错；无 `sessionId` 时返回 `null`

### vm 的坑（浪费了两轮才定位，记下来）

用 `vm.createContext` + `vm.Script` 跑 bundle 做自测时，**在甲上下文里编译出来的
函数，其自由变量永远解析到甲的全局** —— 即使你把函数拿到乙上下文里调用。
所以"先在裸沙箱里验证只注册工厂，再在带 `document` 的沙箱里跑工厂"这种做法必然
报 `document is not defined`。正确做法是：**在哪个上下文里跑工厂，就要在那个上下文里
重新执行一遍 bundle**（`check-client-bundle.mjs` 第 3 步就是这么写的）。
