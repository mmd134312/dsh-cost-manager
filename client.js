window.__ModuleLoader__.load({ id: "dsh-cost-meter", factory: (require) => {
	// 宿主的加载器把工厂当 CommonJS 跑：给本作用域一对 module/exports，
	// 最后把 module.exports 交回去。打包成 ESM 时这两行会被工具换掉。
	const module = { exports: {} }
	const exports = module.exports
	'use strict'

	/**
	 * dsh-cost-meter — 浏览器半（界面）。
	 *
	 * 在对话底部那行（`conversation.composer.dock`，原生 session-stats 就在那里）
	 * 补一格「已用人民币 X」。这是 DSH 官方唯一认可的 UI 投递方式：
	 *   - 代码以 __ModuleLoader__ 惰性工厂形式到达（不往 document.body 写 DOM）
	 *   - React 由宿主的浏览器模块表提供（不重复装 React、不走 CDN）
	 *   - 组件注册进 slot，由宿主决定它挂在哪、什么时候卸载
	 *
	 * 排版不是"自己觉得好看"，而是**逐条抄原生实现**（避免违和）：
	 *
	 *   1. 底部那一格的字体/颜色/内边距，抄 `@deepseek-ai/dsh-client-ui-chat`
	 *      的 StatsPills.module.css（就是"X 轮 X 步 / 缓存命中"那两粒）：
	 *        font-size: calc(var(--dsh-content-font-size-secondary,13px) - 1px)
	 *        color: var(--dsw-alias-label-tertiary)
	 *        padding: 1px 8px; border-radius: 999px; gap: 6px
	 *        hover / [aria-expanded] → background: --dsw-alias-interactive-bg-hover,
	 *                                   color: --dsw-alias-label-secondary
	 *        图标 14×14，分隔点用 --dsw-alias-separator-primary
	 *   2. 悬停气泡不自绘，直接用官方的 `Tooltip` 原语（side: bottom）——
	 *      位置、贴边、翻转、延迟、动画、无障碍全部与原生一致。
	 *   3. 点击面板抄官方 stat-dialog.module.css 的排版：
	 *        面板 border-radius:--dsw-radius-lg / background:--dsw-specific-menu
	 *        / backdrop-filter:--dsw-menu-backdrop-filter / padding:16px
	 *        / font-size:12px; line-height:18px
	 *        标题行：主字号 14 + 图标 14，右侧数值 tabular-nums
	 *        分隔线：.5px solid --dsw-alias-border-l2
	 *        明细：dl 两列网格 minmax(76px,auto) minmax(0,1fr)，dt 三层次字号、
	 *              dd 二次层次字号 + 右对齐 + tabular-nums
	 *      面板由官方的 `useAnchoredPosition` 定位（side: top → 在触发格**上方**，
	 *      align 默认 start → **左对齐**触发格的左边），并按官方的
	 *      `useDismissOnOutsidePointer` 点外关闭、Escape 关闭。
	 *
	 * 桌面版与终端版走同一条路：宿主把 boot 图注入页面，客户端加载器按 id 取到
	 * 这个 bundle。所以它不依赖 HTTP 的 index 注入。
	 */

	const React = require('react')
	const ReactDOM = require('react-dom')

	/**
	 * 官方 UI 原语：Tooltip / useAnchoredPosition / useDismissOnOutsidePointer /
	 * 图标。**可选**地取 —— 拿不到就退回自绘的等价实现，绝不让整个格子消失。
	 */
	let bits = null
	try {
		bits = require('@deepseek-ai/dsh-client-ui-primitives')
	} catch (err) {
		bits = null
	}

	const ROUTE = '/dsh-cost/api'
	const POLL_MS = 2500

	function h(type, props) {
		const args = [type, props]
		for (let i = 2; i < arguments.length; i += 1) args.push(arguments[i])
		return React.createElement.apply(React, args)
	}

	/* ------------------------------------------------------------------ 样式 */

	/** 抄自 StatsPills.module.css，类名换成 dshcm- 前缀避免与任何插件撞车。 */
	const CSS = [
		// 外层：字号**显式**对齐原生（原生那两粒的根节点就是这么写的）。
		// 不能靠继承 —— dock 容器上的继承值不一定等于原生自己算的 12px。
		'.dshcm-rule{flex:none;display:inline-flex;',
		'font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);',
		'line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px))}',
		'.dshcm-rule+.dshcm-rule{margin-left:-6px}',
		'.dshcm-pill{box-sizing:border-box;corner-shape:round;max-width:100%;',
		'color:var(--dsw-alias-label-tertiary);font:inherit;font-variant-numeric:tabular-nums;',
		'white-space:nowrap;background:0 0;border:none;border-radius:999px;cursor:pointer;',
		'align-items:center;gap:6px;padding:1px 8px;display:inline-flex}',
		'.dshcm-pill svg{flex:none;width:14px;height:14px}',
		'.dshcm-pill:hover,.dshcm-pill[aria-expanded=true]{',
		'background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}',
		'.dshcm-pill[aria-disabled=true]{cursor:default;opacity:.55}',
		'.dshcm-sep{color:var(--dsw-alias-separator-primary);margin:0 6px}',
		/* 抄自 stat-dialog.module.css；宽度略窄，因为这里排的是同一个会话的一张账单。 */
		'.dshcm-panel{z-index:1100;box-sizing:border-box;border-radius:var(--dsw-radius-lg);',
		'background:var(--dsw-specific-menu);width:max-content;',
		'min-width:min(300px,100vw - 24px);max-width:min(440px,100vw - 24px);',
		'backdrop-filter:var(--dsw-menu-backdrop-filter);',
		'--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);',
		'box-shadow:var(--dsw-elevation-prominent);color:var(--dsw-alias-label-secondary);',
		'cursor:default;border:0;padding:16px;font-size:12px;line-height:18px;position:fixed}',
		'.dshcm-title{color:var(--dsw-alias-label-primary);justify-content:space-between;',
		'gap:16px;margin-bottom:8px;font-weight:500;display:flex}',
		'.dshcm-titleLabel{align-items:center;gap:6px;min-width:0;display:inline-flex}',
		'.dshcm-titleLabel svg{flex:none;width:14px;height:14px}',
		'.dshcm-titleValue{font-variant-numeric:tabular-nums}',
		'.dshcm-titleRule{border-top:.5px solid var(--dsw-alias-border-l2);margin-bottom:10px}',
		'.dshcm-details{color:var(--dsw-alias-label-tertiary);',
		'grid-template-columns:minmax(76px,auto) minmax(0,1fr);gap:6px 16px;margin:0;display:grid}',
		'.dshcm-details dt,.dshcm-details dd{min-width:0;margin:0}',
		'.dshcm-details dd{color:var(--dsw-alias-label-secondary);',
		'font-variant-numeric:tabular-nums;text-align:right}',
	].join('')

	/** 图标兜底：原语缺失时退化成官方同款的 14×14 描边方块占位。 */
	function FallbackIcon() {
		return h('svg', { viewBox: '0 0 14 14', width: 14, height: 14, 'aria-hidden': true },
			h('rect', {
				x: 1.5, y: 1.5, width: 11, height: 11, rx: 2.5,
				fill: 'none', stroke: 'currentColor', strokeWidth: 1,
			}))
	}

	/* ---------------------------------------------------------------- 格式化 */

	/**
	 * 人民币金额。定稿的口径是「绝不显示 0.00」：
	 * 花了 0.004 就得看见 0.004，而不是被抹成 0。
	 */
	function money(cost) {
		const n = Number(cost) || 0
		if (n === 0) return '0.00'
		if (n < 0.01) return n.toFixed(4)
		return n.toFixed(2)
	}

	/** 官方 formatExactTokens：三位分组、不缩略（K/M 会掩盖真实用量）。 */
	function exact(value) {
		const digits = String(Math.max(0, Math.round(Number(value) || 0)))
		const groups = []
		for (let end = digits.length; end > 0; end -= 3) {
			groups.unshift(digits.slice(Math.max(0, end - 3), end))
		}
		return groups.join(',')
	}

	/**
	 * 按记账口径算缓存命中率 —— 必须和**计费**同源，否则会和金额对不上。
	 *
	 * 计费口径（官方）：prompt 侧 = cacheRead + cacheMiss，两侧分开定价。
	 * 所以分母就是这两者之和，不带任何"再减一次命中"的花活。
	 */
	function hitPercent(snap) {
		const denom = (Number(snap.cacheRead) || 0) + (Number(snap.cacheMiss) || 0)
		if (denom <= 0) return null
		return Math.round((Number(snap.cacheRead) || 0) / denom * 100)
	}

	function moneyOf(snap) {
		return (snap.now && snap.now.peak) ? '高峰档' : '空闲档'
	}

	function countdown(snap) {
		if (!snap.now || !snap.now.nextBoundaryAt) return ''
		const mins = Math.max(0, Math.round((snap.now.nextBoundaryAt - Date.now()) / 60000))
		const hh = Math.floor(mins / 60)
		const mm = mins % 60
		return (hh > 0 ? hh + ' 小时 ' : '') + mm + ' 分钟后'
	}

	/** 一行明细：[标签, 值]；`key` 只是 React 的稳定键。 */
	function row(dt, dd) {
		return { dt, dd }
	}

	/**
	 * 点击面板的正文行。分段顺序刻意与官方 Token 用量面板一致：
	 * 命中率 → 未缓存输入 → 缓存读取 → 输出，再往下才是计费与时段。
	 */
	function detailRows(snap) {
		const rows = []
		const hasTokens = (Number(snap.cacheRead) || 0) + (Number(snap.cacheMiss) || 0) + (Number(snap.output) || 0) > 0
		if (!hasTokens) return rows

		const hit = hitPercent(snap)
		if (hit !== null) rows.push(row('缓存命中', hit + '%'))
		rows.push(row('未缓存输入', exact(snap.cacheMiss)))
		rows.push(row('缓存读取', exact(snap.cacheRead)))
		rows.push(row('输出', exact(snap.output)))

		if (snap.currentRate) {
			rows.push(row('单价（元 / 1M tok）',
				snap.currentRate.hit + ' / ' + snap.currentRate.miss + ' / ' + snap.currentRate.out))
		}

		const priced = Number(snap.priced) || 0
		const unpriced = Number(snap.unpriced) || 0
		const backfilled = Number(snap.backfilled) || 0
		let scope = '计价 ' + priced + ' 次'
		if (backfilled > 0) scope += '，含回溯 ' + backfilled + ' 次'
		if (unpriced > 0) scope += '，未计价 ' + unpriced + ' 次'
		rows.push(row('计费调用', scope))

		if ((Number(snap.peakCost) || 0) > 0 || (Number(snap.offPeakCost) || 0) > 0) {
			rows.push(row('高峰时段', '¥' + money(snap.peakCost) + '（' + (Number(snap.peakCalls) || 0) + ' 次）'))
			rows.push(row('空闲时段', '¥' + money(snap.offPeakCost) + '（' + (Number(snap.offPeakCalls) || 0) + ' 次）'))
		}

		if (snap.now) {
			rows.push(row('当前时段', moneyOf(snap) + (countdown(snap) ? '，' + countdown(snap) + '切换' : '')))
		}
		if (snap.tariff) rows.push(row('价目版本', snap.tariff))

		const models = Array.isArray(snap.models) ? snap.models : []
		if (models.length > 0) rows.push(row('模型', models.join('、')))

		return rows
	}

	/**
	 * 悬停提示文案 —— **只用于无障碍名称**（`aria-label`），不再渲染任何浮层。
	 *
	 * 保留它的理由：屏幕阅读器 / 键盘用户聚焦这一格时，应该能听到"花了多少、
	 * 怎么算的"，而不只是"已用人民币 6.95"。
	 */
	function summaryLines(snap) {
		if (snap === null) return ['正在读取费用…']
		if (!snap.known || !snap.calls) {
			return ['本会话还没有官方通道的计费调用。', '只统计 deepseek 官方通道，第三方渠道不计入。']
		}
		const lines = ['本会话已用人民币 ' + money(snap.cost)]
		if ((Number(snap.peakCost) || 0) > 0 || (Number(snap.offPeakCost) || 0) > 0) {
			lines.push('高峰 ¥' + money(snap.peakCost) + ' · 空闲 ¥' + money(snap.offPeakCost))
		}
		let scope = '计价 ' + (Number(snap.priced) || 0) + ' 次'
		if ((Number(snap.backfilled) || 0) > 0) scope += '（含回溯 ' + snap.backfilled + ' 次）'
		const hit = hitPercent(snap)
		if (hit !== null) scope += ' · 缓存命中 ' + hit + '%'
		lines.push(scope)
		lines.push('点击查看明细')
		return lines
	}

	/* ------------------------------------------------------------------ 组件 */

	/**
	 * 底部那行里的一格花费。
	 *
	 * **只有点击才出东西**，悬停不显示任何浮层（用户明确要求）。
	 * 试过的两种悬停方案都被否决，一并记下来免得以后再走一遍：
	 *   1. 官方 `Tooltip` 原语 —— 它的气泡底色令牌在**浅色主题下也是深灰近乎黑**
	 *      （`dsw-static-neutral-bluish-850`），用户说"上面那个黑色的块好违和"。
	 *      加 `portal: true` 也没用 —— 那是解决"被 stacking context 夹住"的，
	 *      跟颜色无关。
	 *   2. 自绘浅色气泡（官方弹层面色）—— 用户说"我不想要它"。
	 * 结论：这一格不需要悬停提示。费用明细只在**点击**时以面板形式给出。
	 *
	 * sessionId 由 slot props 直接给出 —— 所以"这个数字属于哪个会话"不再靠猜。
	 */
	function CostMeter(props) {
		const sessionId = typeof props.sessionId === 'string' ? props.sessionId : ''
		const [snap, setSnap] = React.useState(null)
		const [failed, setFailed] = React.useState(false)
		const [open, setOpen] = React.useState(false)
		const rootRef = React.useRef(null)
		const panelRef = React.useRef(null)

		React.useEffect(() => {
			if (sessionId === '') return undefined
			let alive = true
			const load = () => {
				const url = ROUTE + '?scope=session&sessionId=' + encodeURIComponent(sessionId)
				fetch(url, { cache: 'no-store' })
					.then((r) => r.json())
					.then((payload) => {
						if (!alive) return
						setFailed(false)
						setSnap(payload)
					})
					.catch(() => {
						if (alive) setFailed(true)
					})
			}
			load()
			const timer = setInterval(load, POLL_MS)
			return () => {
				alive = false
				clearInterval(timer)
			}
		}, [sessionId])

		const useAnchoredPosition = bits && bits.useAnchoredPosition
		const pos = useAnchoredPosition
			? useAnchoredPosition({ open, anchorRef: rootRef, panelRef, side: 'top', gap: 8, margin: 12 })
			: null

		// 钩子不能条件调用，所以上面那句话只做"取函数"，真正的点外关闭
		// 由下面这个永远存在的 effect 完成 —— 效果与官方的
		// useDismissOnOutsidePointer 等价。
		React.useEffect(() => {
			if (!open) return undefined
			const onDown = (event) => {
				const root = rootRef.current
				const panel = panelRef.current
				if (root && root.contains(event.target)) return
				if (panel && panel.contains(event.target)) return
				setOpen(false)
			}
			document.addEventListener('pointerdown', onDown)
			return () => document.removeEventListener('pointerdown', onDown)
		}, [open])

		React.useEffect(() => {
			if (!open) return undefined
			const onKey = (event) => {
				if (event.key === 'Escape') setOpen(false)
			}
			document.addEventListener('keydown', onKey)
			return () => document.removeEventListener('keydown', onKey)
		}, [open])

		// 没有会话 id 就什么都不显示：宁可空着，也不把别人的花销摆在这里。
		if (sessionId === '') return null

		const known = !failed && snap !== null && snap.known === true && snap.calls > 0
		const amount = known ? money(snap.cost) : failed ? '—' : '0.00'

		const Icon = bits && bits.IconDatabaseOutlineRegular ? bits.IconDatabaseOutlineRegular : FallbackIcon

		const pill = h('button', {
			type: 'button',
			className: 'dshcm-pill',
			'aria-haspopup': 'dialog',
			'aria-expanded': open,
			'aria-disabled': failed ? true : undefined,
			/**
			 * 无障碍名称仍把明细念出来 —— 屏幕阅读器用户不该因为
			 * "没有悬停提示"而拿不到信息。**不加 `title`**：那会召出浏览器
			 * 自带的灰色方块提示，正是这一格要去掉的东西。
			 */
			'aria-label': '本会话已用人民币 ' + amount + '，点击查看花费明细',
			'data-dsh-cost': known ? String(snap.cost) : '',
			onClick: () => {
				if (!failed) setOpen(!open)
			},
		},
			h(Icon, null),
			h('span', null, '已用人民币 ' + amount))

		const panel = open && ReactDOM
			? ReactDOM.createPortal(h('div', {
				ref: panelRef,
				className: 'dshcm-panel',
				role: 'dialog',
				'aria-label': '本会话花费明细',
				style: pos || { visibility: 'hidden', left: 0, top: 0 },
			},
				h('div', { className: 'dshcm-title' },
					h('span', { className: 'dshcm-titleLabel' }, h(Icon, null), '本会话花费'),
					h('span', { className: 'dshcm-titleValue' }, '¥' + amount)),
				h('div', { className: 'dshcm-titleRule', 'aria-hidden': true }),
				h('dl', { className: 'dshcm-details', 'data-dsh-cost-details': true },
					detailRows(snap || {}).map((item, index) =>
						h(React.Fragment, { key: index },
							h('dt', null, item.dt),
							h('dd', null, item.dd))))),
			document.body)
			: null

		return h('span', { ref: rootRef, className: 'dshcm-rule' }, pill, panel)
	}

	/* ------------------------------------------------------------------ 插件 */

	exports.name = 'dsh-cost-meter'
	exports.inject = ['slots']
	/**
	 * 只读的格式化/文案函数，供离线自测直接调用。
	 * 挂在**插件导出的下划线字段**上：DSH 只读 name / inject / apply，
	 * 不会碰它，运行期也不产生任何副作用。
	 */
	exports.__dshCostMeter = {
		money: money,
		exact: exact,
		hitPercent: hitPercent,
		detailRows: detailRows,
		summaryLines: summaryLines,
	}
	exports.apply = function apply(ctx) {
		ctx.effect(
			() => {
				const style = document.createElement('style')
				style.setAttribute('data-dsh-cost-meter', '')
				style.textContent = CSS
				document.head.appendChild(style)
				return () => style.remove()
			},
			'dsh-cost-meter: styles',
		)

		// 底部那行的槽位：原生 session-stats 已经在这里，order 取 10 排在它后面。
		ctx.slots.inject('conversation.composer.dock', () =>
			ctx.slots.register(
				{ name: 'conversation.composer.dock', id: 'dsh-cost-meter', order: 10, label: '实际花费' },
				CostMeter,
			),
		)
	}

	return module.exports;
	} });
