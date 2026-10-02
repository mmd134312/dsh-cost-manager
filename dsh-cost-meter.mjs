/**
 * dsh-cost-meter — 在对话底部那行「X 轮 · X 步 | … | 缓存命中 XX% | 输入 … tok」
 * 里，紧挨着 token 用量补上「实际花费」。
 *
 * 设计约束（来自需求）：
 *   1. 只在「DeepSeek 官方通道」计费 —— 官方账号登录（provider=deepseek-official）
 *      或官方 API Key 走同一个 provider 路由，两者都算官方；第三方中转渠道
 *      （llm-pi-ai 里的 yuni 之类）一律不碰，底部那行保持原样。
 *   2. 峰谷定价：高峰时段单价翻倍（等价于空闲时段半价），分「缓存命中输入 /
 *      缓存未命中输入 / 输出」三类，各自都有峰谷两档。
 *   3. 一个会话一份独立账本，只做增量累加，绝不每次重算。
 *   4. 计费政策变化：账本里存「定价版本指纹」，指纹变了才回放重算一次，
 *      之后仍然走增量。历史区间按 effectiveFrom 分段，旧账按旧价。
 *   5. 违和感：费用作为**独立的一格**渲染在底部那行的槽位里
 *      （`conversation.composer.dock`，原生 session-stats 就在那儿），
 *      排版与设计令牌都照抄原生读数行，不新开一行、不加边框。
 *
 * 宿主半：价目表 + 账本 + `llm/stream` 计量 + 取数接口。
 * 浏览器半：`lib/client.js`（官方 `dsh.client` 惰性工厂 + slot 里的 React 组件）。
 *   两者通过 `GET /dsh-cost/api?scope=session&sessionId=…` 通信。
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import zlib from 'node:zlib'

// ----------------------------------------------------------------- 常量

const ROUTE = '/dsh-cost/api'
const LOG_PREFIX = '[dsh-cost]'

/** 官方 DeepSeek 通道的 provider 路由名。只认这些，别的一律不计费。 */
const OFFICIAL_PROVIDERS = [
  'deepseek-official',
  'deepseek-account',
  'deepseek',
  'deepseek-api-key',
]

/** 官方按 Flash 价格计费的旧模型名（官方明文：仍可调用，按 Flash 价计费）。 */
const LEGACY_FLASH_MODELS = [
  'deepseek-v4-flash',
  'deepseek-v4-flash-vision-exp',
]

const CHINA_TZ = 'Asia/Shanghai'

// ------------------------------------------------------------ 峰谷判定

/**
 * 中国法定节假日（北京时间全天算空闲）。
 *
 * 官方口径是「不含中国法定节假日」，而节假日安排是国务院每年底才公布的，
 * 任何写死的表都会过期，所以这里的 2026 年日期是**按近年规律的预排**，
 * 不是官方原文：春节、国庆这类按农历/惯例推定，个别年份会调休挪动几天。
 *
 * 影响面很小：某天被误判成高峰，只会让**当天**那几次调用按高峰价计
 * （正好贵一倍）；平时判定完全不受影响。国务院公布后，把准确日期写进
 * cost-config.json 的 holidays 即可覆盖，改完下个轮询周期生效。
 */
const CHINA_HOLIDAYS_2026 = [
  '2026-01-01', '2026-01-02', '2026-01-03',
  '2026-02-15', '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19',
  '2026-02-20', '2026-02-21', '2026-02-22', '2026-02-23',
  '2026-04-04', '2026-04-05', '2026-04-06',
  '2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05',
  '2026-06-19', '2026-06-20', '2026-06-21',
  '2026-09-25', '2026-09-26', '2026-09-27',
  '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05',
  '2026-10-06', '2026-10-07', '2026-10-08',
]

/** 高峰时段（北京时间，周一至周五）：9:00-12:00、14:00-18:00。 */
const PEAK_HOUR_RANGES = [
  [9, 12],
  [14, 18],
]

/**
 * 取某时刻的北京时间日历分量。
 *
 * 优先用 Intl（Electron 自带 full-icu，时区库完整），失败则退到 UTC+8 手算 ——
 * 中国自 1991 年起不再用夏令时，固定 +8 是安全的。
 */
let beijingFormatter = null
let beijingFormatterTried = false

function beijingParts(when) {
  const date = asDate(when)
  if (!beijingFormatterTried) {
    beijingFormatterTried = true
    try {
      beijingFormatter = new Intl.DateTimeFormat('en-US', {
        timeZone: CHINA_TZ,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short',
      })
    } catch (err) {
      beijingFormatter = null
    }
  }
  if (beijingFormatter !== null) {
    try {
      const parts = {}
      for (const part of beijingFormatter.formatToParts(date)) {
        if (part.type !== 'literal') parts[part.type] = part.value
      }
      const weekday = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[parts.weekday]
      const hour = Number(parts.hour) % 24
      return {
        key: parts.year + '-' + parts.month + '-' + parts.day,
        weekday: weekday === undefined ? 0 : weekday,
        hour: Number.isFinite(hour) ? hour : 0,
        minute: Number(parts.minute) || 0,
      }
    } catch (err) {
      beijingFormatter = null
    }
  }
  const shifted = new Date(date.getTime() + 8 * 3600 * 1000)
  const pad = (n) => (n < 10 ? '0' + n : String(n))
  return {
    key: shifted.getUTCFullYear() + '-' + pad(shifted.getUTCMonth() + 1) + '-' + pad(shifted.getUTCDate()),
    weekday: shifted.getUTCDay(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
  }
}

/**
 * 把「时刻」统一成 Date。
 *
 * 这个归一化是必需的：峰谷判定会拿到 Date、毫秒数两种形态。曾经有一处传了
 * 毫秒数进 beijingParts，`date.getTime()` 在数字上返回 undefined → NaN →
 * **所有调用都被判成空闲档**（高峰价永远不会被用上，金额系统性偏低一半）。
 * 修法不是改调用点，而是在入口归一 —— 以后谁传错都不再静默算错。
 */
function asDate(value) {
  if (value instanceof Date) return value
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value)
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return new Date(parsed)
  }
  return new Date()
}

/** 该时刻是否落在高峰计费时段。 */
function isPeak(when, holidaySet) {
  const parts = beijingParts(asDate(when))
  if (parts.weekday === 0 || parts.weekday === 6) return false
  if (holidaySet.has(parts.key)) return false
  for (const [from, to] of PEAK_HOUR_RANGES) {
    if (parts.hour >= from && parts.hour < to) return true
  }
  return false
}

/**
 * 下一个峰谷切换点（毫秒），给客户端做倒计时。
 *
 * 峰谷只会在「高峰区间的起止整点」或「跨日」处翻转，所以只需要检查这些
 * 候选点，而不是逐分钟试 —— 后者每次调用要跑两千多次 Intl，而这是每 2.5 秒
 * 一次的轮询路径。
 */
function nextBoundary(date, holidaySet) {
  const wasPeak = isPeak(date, holidaySet)
  const parts = beijingParts(date)
  const [year, month, day] = parts.key.split('-').map(Number)
  for (let dayOffset = 0; dayOffset <= 8; dayOffset += 1) {
    for (const boundary of [0, 9, 12, 14, 18]) {
      // 用 UTC 伪造一个"由 Beijing 日历分量构成的时刻"，再减掉 8 小时还原成
      // 真正的 UTC 瞬间。中国无夏令时，+8 固定，所以这一步是精确的。
      const fake = Date.UTC(year, month - 1, day + dayOffset, boundary, 0, 0, 0)
      const instant = new Date(fake - 8 * 3600 * 1000)
      if (instant.getTime() <= date.getTime()) continue
      if (isPeak(instant, holidaySet) !== wasPeak) return instant.getTime()
    }
  }
  return date.getTime() + 6 * 3600 * 1000
}

// ------------------------------------------------------------ 价目表

/**
 * 价目表（人民币 / 百万 tokens）。offPeak = peak / 2，与官方一致；
 * 两档都显式写出，方便政策再变时只改数字。
 *
 * 来源：https://api-docs.deepseek.com/zh-cn/quick_start/pricing
 *   deepseek-flash   : 命中 0.02 / 未命中 1 / 输出 4     （高峰 ×2）
 *   deepseek-v4-pro  : 命中 0.15 / 未命中 4.5 / 输出 13.5（高峰 ×2）
 */
const TARIFFS = [
  {
    from: '2026-09-10T04:00:00Z',
    id: '2026-09-10',
    note: 'V4.1-Flash 降价；deepseek-v4-flash 旧名按 Flash 计价',
    models: {
      'deepseek-flash': { peak: { hit: 0.04, miss: 2, out: 8 }, offPeak: { hit: 0.02, miss: 1, out: 4 } },
      'deepseek-v4-pro': { peak: { hit: 0.3, miss: 9, out: 27 }, offPeak: { hit: 0.15, miss: 4.5, out: 13.5 } },
    },
  },
  {
    from: '2026-08-16T16:00:00Z',
    id: '2026-08-16',
    note: '峰谷定价上线：9:00-12:00 / 14:00-18:00 北京时间高峰',
    models: {
      'deepseek-v4-flash': { peak: { hit: 0.1, miss: 3, out: 9 }, offPeak: { hit: 0.05, miss: 1.5, out: 4.5 } },
      'deepseek-v4-pro': { peak: { hit: 0.3, miss: 9, out: 27 }, offPeak: { hit: 0.15, miss: 4.5, out: 13.5 } },
    },
  },
]

/**
 * 模型名 → 价目行键。
 *
 * 官方对「旧模型名仍可调用、按 Flash 计价」有明文，但未来可能出现新的
 * 别名，所以这里做成「显式表 + 保守前缀兜底」：只对 deepseek-v4-* 这种
 * 明确的官方命名空间兜底到 pro，其余一律返回 null —— 宁可不显示费用，
 * 也不给一个编出来的数字。
 */
function tariffKey(model) {
  const id = String(model || '').trim().toLowerCase()
  if (id === '') return null
  if (id === 'deepseek-flash' || id === 'deepseek-v4-flash' || id === 'deepseek-v4-flash-vision-exp') return 'deepseek-flash'
  if (id === 'deepseek-v4-pro' || id === 'deepseek-v4-pro-0813') return 'deepseek-v4-pro'
  if (LEGACY_FLASH_MODELS.indexOf(id) >= 0) return 'deepseek-flash'
  return null
}

/** 找出某时刻生效的价目行（按 from 倒序取第一条不晚于该时刻的）。 */
function tariffAt(timestamp) {
  const t = typeof timestamp === 'number' && Number.isFinite(timestamp) ? timestamp : Date.now()
  for (const row of TARIFFS) {
    if (t >= Date.parse(row.from)) return row
  }
  return TARIFFS[TARIFFS.length - 1]
}

function resolveRate(model, timestamp) {
  const key = tariffKey(model)
  if (key === null) return null
  const row = tariffAt(timestamp)
  const rate = row.models[key]
  if (rate === undefined) return null
  return { key, row, rate }
}

/** 定价指纹：价目表 + 峰谷规则的摘要。变了就说明"算法变了"。 */
function pricingFingerprint(holidaySet) {
  const payload = JSON.stringify({
    tariffs: TARIFFS,
    peak: PEAK_HOUR_RANGES,
    holidays: Array.from(holidaySet).sort(),
    tz: CHINA_TZ,
    schema: 2,
  })
  let hash = 2166136261
  for (let i = 0; i < payload.length; i += 1) {
    hash ^= payload.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16) + '-' + payload.length.toString(16)
}

// ------------------------------------------------------------ 小工具

function dshHome() {
  const configured = process.env.DSH_HOME
  if (typeof configured === 'string' && configured.trim() !== '') return configured
  return path.join(os.homedir(), '.dsh')
}

function dataDir() {
  return path.join(dshHome(), 'dsh-cost')
}

function ledgerFile() {
  return path.join(dataDir(), 'ledger.json')
}

function configFile() {
  return path.join(dataDir(), 'cost-config.json')
}

// ------------------------------------------------- 会话日志回溯（补齐历史）

/**
 * 会话日志落在 `${DSH_HOME}/sessions/<编码后的工作目录>/<sessionId>/…jsonl.zstd`。
 * 目录名是把 cwd 转义后的产物：`~XXXX` 是字符的十六进制、`-` 代表路径分隔符。
 * 我们不需要反向解码（那要处理盘符、大小写、UNC 等一堆边界），只需要**正向
 * 遍历**找到含该 sessionId 的目录即可 —— 目录名怎么编码都不影响。
 */
function sessionLogOf(sessionId) {
  const root = path.join(dshHome(), 'sessions')
  let dirs
  try {
    dirs = fs.readdirSync(root)
  } catch (err) {
    return null
  }
  for (const dir of dirs) {
    const sessionDir = path.join(root, dir, sessionId)
    let files
    try {
      if (!fs.statSync(sessionDir).isDirectory()) continue
      files = fs.readdirSync(sessionDir)
    } catch (err) {
      continue
    }
    let best = null
    for (const f of files) {
      if (!f.endsWith('.jsonl.zstd')) continue
      const full = path.join(sessionDir, f)
      let size = 0
      try {
        size = fs.statSync(full).size
      } catch (err) {
        continue
      }
      if (best === null || size > best.size) best = { file: full, size }
    }
    if (best !== null) return best.file
  }
  return null
}

/** zstd 的多帧拼接：每次 append 是一个独立帧，一次性解压只拿到第一帧。 */
function decodeZstdFrames(buf) {
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
  if (typeof zlib.zstdDecompressSync !== 'function') return null
  const starts = []
  let i = buf.indexOf(magic, 0)
  while (i !== -1) {
    starts.push(i)
    i = buf.indexOf(magic, i + 4)
  }
  if (starts.length === 0) return null
  const chunks = []
  for (let k = 0; k < starts.length; k += 1) {
    const to = k + 1 < starts.length ? starts[k + 1] : buf.length
    try {
      chunks.push(zlib.zstdDecompressSync(buf.subarray(starts[k], to)))
    } catch (err) {
      // 单帧坏了不该丢掉整份日志；其余帧继续解。
    }
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * 读出日志里所有「官方通道」的调用，带各自的发生时刻。
 *
 * 时刻是必需的：峰谷按**调用当时**判档，所以回溯补齐能精确计价，不是估算。
 */
function readCallsFromLog(file) {
  let text
  try {
    text = decodeZstdFrames(fs.readFileSync(file))
  } catch (err) {
    return null
  }
  if (text === null) return null
  const calls = []
  let provider = ''
  let model = ''
  for (const line of text.split('\n')) {
    if (line === '' || (line.indexOf('provider') < 0 && line.indexOf('usage') < 0)) continue
    let ev
    try {
      ev = JSON.parse(line)
    } catch (err) {
      continue
    }
    const d = ev.data
    if (d === null || d === undefined) continue
    const cfg = d.header !== undefined && d.header !== null ? d.header.config : null
    if (cfg !== null && cfg !== undefined && typeof cfg.provider === 'string') {
      provider = cfg.provider
      if (typeof cfg.model === 'string') model = cfg.model
    }
    if (ev.type !== 'assistant/message') continue
    const usage = d.usage
    if (usage === null || usage === undefined) continue
    const src = d.message !== undefined && d.message !== null ? d.message.source : null
    const prov = src !== null && src !== undefined && typeof src.provider === 'string' ? src.provider : provider
    if (!/^deepseek-/i.test(String(prov || ''))) continue
    calls.push({
      time: typeof ev.time === 'number' ? ev.time : 0,
      model: (src !== null && src !== undefined && typeof src.model === 'string' ? src.model : model),
      hit: num(usage.cacheReadTokens),
      miss: num(usage.inputTokens),
      out: num(usage.outputTokens),
    })
  }
  return calls
}

function emptyLedger() {
  return { version: 2, sessions: {}, updatedAt: 0 }
}

function emptySession(id) {
  return {
    id,
    cost: 0,
    currency: 'CNY',
    calls: 0,
    input: 0,
    cacheRead: 0,
    cacheMiss: 0,
    output: 0,
    reasoning: 0,
    priced: 0,
    unpriced: 0,
    firstAt: 0,
    lastAt: 0,
    peakCalls: 0,
    offPeakCalls: 0,
    peakCost: 0,
    offPeakCost: 0,
    models: {},
    fingerprint: '',
    backfilledAt: 0,
    backfillUnknown: 0,
    updatedAt: 0,
  }
}

function num(value) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : 0
}

/** 四舍五入到 1e-4 元，避免浮点噪声把账本撑成科学计数法。 */
function round6(value) {
  return Math.round(value * 1e6) / 1e6
}

/** 按「命中 / 未命中 / 输出」算一次调用的费用。 */
function priceOf(rate, peak, usage) {
  const table = peak ? rate.peak : rate.offPeak
  const hitTokens = num(usage.cacheReadTokens)
  const outTokens = num(usage.outputTokens)
  /**
   * 未命中数 = `inputTokens` **本身**，不要再减去命中的部分。
   *
   * 官方字段定义：`prompt_tokens = prompt_cache_hit_tokens + prompt_cache_miss_tokens`。
   * DSH 的 TokenUsage 把 `prompt_cache_miss_tokens` 映射成 `inputTokens`，把
   * `prompt_cache_hit_tokens` 映射成 `cacheReadTokens` —— 实测样例印证：
   *   {inputTokens: 7493, cacheReadTokens: 2176, outputTokens: 708, totalTokens: 10377}
   *   7493 + 2176 + 708 = 10377 ✓ （若 inputTokens 是"输入总量"，则 hit+miss 会等于它，不成立）
   *
   * 旧代码写的是 `max(0, inputTokens - cacheRead)`，那会在命中量大的时候把
   * 未命中数算成 0（命中 > 输入量时被 max 吃掉），从而**少算钱**。
   */
  const missTokens = num(usage.inputTokens)
  return {
    hitTokens,
    missTokens,
    outTokens,
    cost: round6((hitTokens * table.hit + missTokens * table.miss + outTokens * table.out) / 1e6),
    table,
  }
}

function logLine(level, message, detail) {
  const text = LOG_PREFIX + ' ' + message + (detail === undefined ? '' : ' ' + String(detail))
  try {
    if (level === 'error') console.error(text)
    else if (level === 'warn') console.warn(text)
    else console.log(text)
  } catch (err) {
    /* logging must never break the meter */
  }
}

// ------------------------------------------------------------ 插件

export const name = 'dsh-cost-meter'

/**
 * 只硬依赖 webServer（没有它就没有页面）。
 * llm / credentials / connection 全部按需 ctx.get —— 让本插件在缺任何一个
 * 兄弟行时依然能装载，而不是整行变红。
 */
export const inject = ['webServer']

export function apply(ctx) {
  // ---------------------------------------------------------- 账本
  let ledger = emptyLedger()
  let ledgerLoaded = false
  let saveTimer = null
  let dirty = false
  let lastSaveError = ''

  /** 覆盖配置（节假日、额外官方 provider、显示开关）。 */
  let overrides = { holidays: [], providers: [], currency: 'CNY', showPeakBadge: true }
  let holidays = new Set(CHINA_HOLIDAYS_2026)
  let fingerprint = pricingFingerprint(holidays)

  function rebuildHolidays() {
    holidays = new Set(CHINA_HOLIDAYS_2026)
    for (const day of overrides.holidays) {
      if (typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day.trim())) holidays.add(day.trim())
    }
    fingerprint = pricingFingerprint(holidays)
  }

  function readOverrides() {
    try {
      const raw = fs.readFileSync(configFile(), 'utf8')
      const parsed = JSON.parse(raw)
      if (parsed !== null && typeof parsed === 'object') {
        overrides = {
          holidays: Array.isArray(parsed.holidays) ? parsed.holidays : [],
          providers: Array.isArray(parsed.providers) ? parsed.providers : [],
          currency: typeof parsed.currency === 'string' && parsed.currency !== '' ? parsed.currency : 'CNY',
          showPeakBadge: parsed.showPeakBadge !== false,
        }
      }
    } catch (err) {
      // 文件不存在或坏了都用默认值，不抛。
    }
    rebuildHolidays()
  }

  function providerAllowed(provider) {
    const id = String(provider || '').trim().toLowerCase()
    if (id === '') return false
    if (overrides.providers.indexOf(provider) >= 0) return true
    if (OFFICIAL_PROVIDERS.indexOf(id) >= 0) return true
    // 兜底：名字里带 deepseek 的自有路由（例如某些版本的 deepseek-账号 命名），
    // 但显式排除第三方中转常见的自定义路由 —— 它们通常不带 deepseek 字样。
    return id.startsWith('deepseek-')
  }

  /** 上次从盘上读（或写）账本的时刻 + 当时的文件大小，用来发现"别人改过"。 */
  let loadedAt = 0
  let loadedSize = -1

  function loadLedger() {
    if (ledgerLoaded) return
    ledgerLoaded = true
    try {
      const info = fs.statSync(ledgerFile())
      const raw = fs.readFileSync(ledgerFile(), 'utf8')
      const parsed = JSON.parse(raw)
      if (parsed !== null && typeof parsed === 'object' && parsed.sessions !== null && typeof parsed.sessions === 'object') {
        ledger = { version: 2, sessions: parsed.sessions, updatedAt: num(parsed.updatedAt) }
      }
      loadedAt = info.mtimeMs
      loadedSize = info.size
    } catch (err) {
      ledger = emptyLedger()
      loadedAt = 0
      loadedSize = -1
    }
  }

  /**
   * 如果盘上的账本比我手里的新，就丢掉内存副本重新读。
   *
   * 这不是多此一举：插件会重载（改配置、HMR、重启 profile），而旧实例的防抖
   * 写盘可能在新实例读盘之后才落地 —— 那样旧实例会用一份**过期快照**覆盖掉
   * 新数据，表现就是"刚花的钱被冲掉了"。两个 DSH 共用同一个 DSH_HOME 时同理。
   *
   * 判据是 mtime + size 都变了才重读，且以我上次读/写的时刻为界，所以正常情况下
   * 一次磁盘 stat 就结束，不会每个轮询都解析整个账本。
   */
  function reloadIfChanged() {
    loadLedger()
    let info
    try {
      info = fs.statSync(ledgerFile())
    } catch (err) {
      return false
    }
    if (info.mtimeMs <= loadedAt && info.size === loadedSize) return false
    try {
      const parsed = JSON.parse(fs.readFileSync(ledgerFile(), 'utf8'))
      if (parsed === null || typeof parsed !== 'object' || parsed.sessions === null || typeof parsed.sessions !== 'object') return false
      ledger = { version: 2, sessions: parsed.sessions, updatedAt: num(parsed.updatedAt) }
      loadedAt = info.mtimeMs
      loadedSize = info.size
      logLine('info', '检测到账本被其他实例更新，已重新载入')
      return true
    } catch (err) {
      return false
    }
  }

  /** 原子写盘：先写临时文件再 rename，避免半截 JSON。 */
  function saveLedgerNow() {
    if (!dirty) return
    dirty = false
    try {
      fs.mkdirSync(dataDir(), { recursive: true })
      const body = JSON.stringify(ledger, null, 2)
      const tmp = ledgerFile() + '.tmp'
      fs.writeFileSync(tmp, body, 'utf8')
      fs.renameSync(tmp, ledgerFile())
      // 记下"我刚写过"，下次 reloadIfChanged 才不会把自己写的当成别人的更新。
      try {
        const info = fs.statSync(ledgerFile())
        loadedAt = info.mtimeMs
        loadedSize = info.size
      } catch (err) {
        /* 记不上就下次多读一遍，不影响正确性 */
      }
      lastSaveError = ''
    } catch (err) {
      lastSaveError = String((err && err.message) || err)
      dirty = true
      logLine('error', '账本写盘失败：', lastSaveError)
    }
  }

  function markDirty() {
    dirty = true
    if (saveTimer !== null) return
    saveTimer = setTimeout(() => {
      saveTimer = null
      saveLedgerNow()
    }, 1500)
  }

  function sessionEntry(sessionId) {
    const existing = ledger.sessions[sessionId]
    if (existing !== undefined && existing !== null) {
      // 已有条目：若还没回溯过（或上次是空账本时跳过的），这次补上。
      backfillEntry(existing)
      return existing
    }
    const fresh = emptySession(sessionId)
    ledger.sessions[sessionId] = fresh
    return fresh
  }

  /**
   * 政策变化的重算：指纹不一致时，用当前价目表把「已记录的历史 token」重新定价。
   *
   * 只用已落账的事实（每个模型的命中/未命中/输出累计 token、以及历史峰谷调用
   * 次数）重算，所以结果是确定的、可复现的，不是估的：
   *   - 三类 token 各自按价目表算，不再用"平均峰谷比例"这种会造成总额乱跳的摊分；
   *   - 峰谷部分按**历史实际**的峰/谷调用次数分摊，两者相加即为该模型的价格；
   *   - 取 max(旧值, 新值)：政策重算绝不让用户看到金额变少 —— 显示口径宁可
   *     保守，也不该出现"什么都没干，钱变少了"。
   *
   * 这是一次性的：重算完写回新指纹，之后照旧走增量。
   */
  function repriceIfNeeded(entry) {
    if (entry.fingerprint === fingerprint) return false
    if (entry.calls === 0) {
      entry.fingerprint = fingerprint
      return true
    }
    const models = Object.keys(entry.models)
    if (models.length === 0) {
      entry.fingerprint = fingerprint
      return true
    }
    const peakCalls = num(entry.peakCalls)
    const offPeakCalls = num(entry.offPeakCalls)
    const totalCalls = peakCalls + offPeakCalls
    const at = entry.lastAt || Date.now()
    let total = 0
    let peakCost = 0
    let offPeakCost = 0
    for (const model of models) {
      const bucket = entry.models[model]
      const resolved = resolveRate(model, at)
      if (resolved === null) continue
      // 该模型的 token 总量按历史峰/谷调用次数分摊（没有调用记录时对半分）。
      const share = totalCalls > 0 ? peakCalls / totalCalls : 0.5
      const usagePeak = {
        inputTokens: num(bucket.input) * share,
        cacheReadTokens: num(bucket.cacheRead) * share,
        outputTokens: num(bucket.output) * share,
      }
      const usageOff = {
        inputTokens: num(bucket.input) * (1 - share),
        cacheReadTokens: num(bucket.cacheRead) * (1 - share),
        outputTokens: num(bucket.output) * (1 - share),
      }
      const p = priceOf(resolved.rate, true, usagePeak).cost
      const o = priceOf(resolved.rate, false, usageOff).cost
      peakCost += p
      offPeakCost += o
      total += p + o
    }
    // 下限保护：重算只可能"认得更贵"，不会让已显示的金额缩水。
    const hadCost = num(entry.cost)
    if (total < hadCost) {
      total = hadCost
      peakCost = num(entry.peakCost)
      offPeakCost = num(entry.offPeakCost)
    }
    entry.cost = round6(total)
    entry.peakCost = round6(peakCost)
    entry.offPeakCost = round6(offPeakCost)
    entry.fingerprint = fingerprint
    logLine('info', '定价政策变化，已按新价目重算会话', entry.id)
    return true
  }

  /**
   * 回溯补齐：把该会话**装载之前**的调用也补进账本，使显示的是"这个会话总共
   * 花了多少"，而不是"从装载那刻起花了多少"。
   *
   * 只跑一次（`backfilledAt` 落盘作标记）。防重复的判据很硬：账本里存着**第一次
   * 记账的时刻** `firstAt`，这里只补**早于它**的调用 —— 之后的调用由 llm/stream
   * 实时记账，两个区间不重叠，所以不重不漏。
   *
   * 时刻逐条取用：峰谷按**调用当时**判档，所以补出来的金额是精确的，不是估算。
   */
  function backfillEntry(entry) {
    if (num(entry.backfilledAt) > 0) return
    // 账本里还没有第一次真实记账时刻时不能补，也**不能落标记** —— 否则这一次
    // 白跑，之后再也不会重试。等 record() 记下 firstAt 后自然会补。
    if (num(entry.firstAt) === 0) return
    entry.backfilledAt = Date.now()

    let file = null
    try {
      file = sessionLogOf(entry.id)
    } catch (err) {
      file = null
    }
    if (file === null) {
      logLine('info', '没有找到该会话的日志，跳过回溯：', entry.id)
      return
    }
    let calls = null
    try {
      calls = readCallsFromLog(file)
    } catch (err) {
      calls = null
    }
    if (calls === null) {
      logLine('warn', '会话日志解压失败，跳过回溯：', entry.id)
      return
    }

    let added = 0
    let cost = 0
    let unknown = 0
    let peakAdded = 0
    let offAdded = 0
    let earliest = num(entry.firstAt) || Number.MAX_SAFE_INTEGER
    /**
     * 边界必须在循环**开始前**固定住。
     *
     * 踩过的坑：循环里顺手把 `entry.firstAt` 更新成更早的时刻（那是"这个会话最早
     * 一次调用"的语义），边界就被推进了历史里 —— 第二条调用立刻变成"晚于
     * firstAt"而被判成非历史，于是**只有第一条能被补进来**（实测：10 条只补了 1 条）。
     * 判定边界与统计量必须分开，边界只读、不写。
     */
    const boundary = num(entry.firstAt) || 0
    for (const call of calls) {
      // 「历史」= 严格早于首次记账时刻的调用。用 >=：刚记完那一次 time 恰好等于
      // firstAt，若写成 > 就会把它当成历史再算一遍，金额翻倍。
      if (call.time <= 0 || call.time >= boundary) continue
      const resolved = resolveRate(call.model, call.time)
      if (resolved === null) {
        unknown += 1
        continue
      }
      const peak = isPeak(new Date(call.time), holidays)
      const priced = priceOf(resolved.rate, peak, {
        inputTokens: call.miss,
        cacheReadTokens: call.hit,
        outputTokens: call.out,
      })
      const at = call.time
      entry.calls += 1
      entry.input += call.miss + call.hit
      entry.cacheRead += call.hit
      entry.cacheMiss += call.miss
      entry.output += call.out
      // 不把补进来的调用并进 priced/unpriced —— 那两个计数说的是"实时观测到的
      // 调用"，回溯的是历史，混在一起会让 tooltip 的口径说不清。
      entry.cost = round6(entry.cost + priced.cost)
      if (peak) {
        entry.peakCalls += 1
        entry.peakCost = round6(entry.peakCost + priced.cost)
        peakAdded += 1
      } else {
        entry.offPeakCalls += 1
        entry.offPeakCost = round6(entry.offPeakCost + priced.cost)
        offAdded += 1
      }
      if (at < earliest) earliest = at
      const bucket = entry.models[call.model] !== undefined
        ? entry.models[call.model]
        : (entry.models[call.model] = { input: 0, cacheRead: 0, output: 0, calls: 0, cost: 0 })
      bucket.input += call.miss + call.hit
      bucket.cacheRead += call.hit
      bucket.output += call.out
      bucket.calls += 1
      bucket.cost = round6(bucket.cost + priced.cost)
      added += 1
      cost += priced.cost
    }

    entry.backfillUnknown = unknown
    // 循环跑完才回写边界（firstAt 的语义是"这个会话最早一次调用"）。
    if (earliest !== Number.MAX_SAFE_INTEGER) entry.firstAt = earliest
    if (added > 0) {
      entry.updatedAt = Date.now()
      ledger.updatedAt = entry.updatedAt
      markDirty()
      logLine('info', '回溯补齐 ' + added + ' 次历史调用（高峰 ' + peakAdded + ' / 空闲 ' + offAdded +
        '），+¥' + round6(cost) + '：' + entry.id + (unknown > 0 ? '（另有 ' + unknown + ' 次模型无对应价目，未计）' : ''))
    } else {
      markDirty()
    }
  }

  /**
   * 一次模型调用的计量入口。只有官方通道 + 认识模型才记账。
   * 返回 'priced' | 'skipped' | 'unknown-model' | 'foreign-provider'。
   */
  function record(options, usage) {
    if (options === null || typeof options !== 'object') return 'skipped'
    if (!providerAllowed(options.provider)) return 'foreign-provider'
    const sessionId = typeof options.sessionId === 'string' && options.sessionId !== '' ? options.sessionId : ''
    if (sessionId === '') return 'skipped'

    const at = Date.now()
    const resolved = resolveRate(options.model, at)
    // 官方通道上遇到不认识的模型名：记一笔"未计价"，这样界面能诚实地说
    // "这个模型我没价目"，而不是显示一个假数字或干脆装作没发生。
    //
    // 顺序要紧：**先**确认盘上的账本没有更新过（多实例 / 插件重载），**再**取
    // entry 引用。反过来（先在旧账本上取引用、之后又重载）会留下一根指向已
    // 被替换掉的旧对象的引用，那一笔就记丢了 —— 表现是"刚花的钱没算进去"。
    reloadIfChanged()
    const entry = sessionEntry(sessionId)
    repriceIfNeeded(entry)

    const hit = num(usage.cacheReadTokens)
    // inputTokens 就是未命中数（见 priceOf 上的注释与官方字段定义），不要再减 hit。
    const miss = num(usage.inputTokens)
    const out = num(usage.outputTokens)
    const reasoning = num(usage.reasoningTokens)

    const touch = () => {
      entry.calls += 1
      entry.input += num(usage.inputTokens)
      entry.cacheRead += hit
      entry.cacheMiss += miss
      entry.output += out
      entry.reasoning += reasoning
      if (entry.firstAt === 0) entry.firstAt = at
      entry.lastAt = at
      entry.updatedAt = at
      ledger.updatedAt = at
      markDirty()
    }

    const modelKey = String(options.model || '(unknown)')
    const bucket = entry.models[modelKey] !== undefined
      ? entry.models[modelKey]
      : (entry.models[modelKey] = { input: 0, cacheRead: 0, output: 0, calls: 0, cost: 0 })

    if (resolved === null) {
      entry.unpriced += 1
      bucket.calls += 1
      touch()
      return 'unknown-model'
    }

    const peak = isPeak(new Date(at), holidays)
    const priced = priceOf(resolved.rate, peak, usage)
    entry.cost = round6(entry.cost + priced.cost)
    if (peak) {
      entry.peakCalls += 1
      entry.peakCost = round6(entry.peakCost + priced.cost)
    } else {
      entry.offPeakCalls += 1
      entry.offPeakCost = round6(entry.offPeakCost + priced.cost)
    }
    entry.priced += 1
    bucket.calls += 1
    bucket.cost = round6(bucket.cost + priced.cost)
    touch()
    return 'priced'
  }

  // ---------------------------------------------------------- llm 计量
  //
  // `llm/stream` 是每次模型调用的（含重试、重放、路由）waterfall 包装点：
  // GenerateOptions 里带着 provider / model / sessionId，流里带着适配器
  // 归一化后的 `usage` chunk —— 这正是"实际用量"，比事后按消息字数估算准。
  ctx.on('llm/stream', (options, next) => {
    // 只认官方通道再往下走：第三方渠道连账本条目都不建，保持账本干净。
    // （生成器体是懒执行的，所以这里同步判断是安全的。）
    if (!providerAllowed(options === null || options === undefined ? '' : options.provider)) return next()
    const upstream = next()
    return (async function* metered() {
      // 一次调用只记一次账：适配器在流里可能发多个 usage（中途估算 + 最终值），
      // 逐个累加会重复计费。所以留着最后一个，等流结束（或 finish）再落账。
      let latestUsage = null
      let recorded = false
      const settle = () => {
        if (recorded || latestUsage === null) return
        recorded = true
        try {
          record(options, latestUsage)
        } catch (err) {
          logLine('error', '计量失败（不影响模型调用）：', String((err && err.message) || err))
        }
      }
      try {
        for await (const chunk of upstream) {
          if (chunk !== null && typeof chunk === 'object') {
            if (chunk.type === 'usage' && chunk.usage !== null && typeof chunk.usage === 'object') {
              latestUsage = chunk.usage
            } else if (chunk.type === 'finish') {
              settle()
            }
          }
          yield chunk
        }
      } finally {
        settle()
        // 实时记账之后（firstAt 已落）再补历史：补的是"早于 firstAt"的调用，
        // 与实时记账的区间严格不重叠，所以不重不漏。
        try {
          const sid = options !== null && options !== undefined && typeof options.sessionId === 'string' ? options.sessionId : ''
          if (sid !== '') backfillEntry(sessionEntry(sid))
        } catch (err) {
          logLine('error', '回溯补齐失败（不影响记账）：', String((err && err.message) || err))
        }
      }
    })()
  })

  // ---------------------------------------------------------- 快照

  function configSignature() {
    try {
      const info = fs.statSync(configFile())
      return String(info.mtimeMs) + ':' + String(info.size)
    } catch (err) {
      return 'none'
    }
  }

  let configSig = configSignature()
  function reloadConfigIfChanged() {
    const sig = configSignature()
    if (sig === configSig) return
    configSig = sig
    readOverrides()
  }

  function nowContext() {
    const at = new Date()
    const bj = beijingParts(at)
    const peak = isPeak(at, holidays)
    return {
      peak,
      period: peak ? 'peak' : 'offPeak',
      holiday: holidays.has(bj.key),
      nextBoundaryAt: nextBoundary(at, holidays),
      beijing: bj.key + ' ' + String(bj.hour).padStart(2, '0') + ':' + String(bj.minute).padStart(2, '0'),
    }
  }

  function snapshot(sessionId) {
    reloadConfigIfChanged()
    reloadIfChanged()
    const entry = sessionId !== '' && ledger.sessions[sessionId] !== undefined
      ? ledger.sessions[sessionId]
      : null
    const at = Date.now()
    const model = entry === null ? '' : (Object.keys(entry.models)[0] || '')
    const resolved = model === '' ? null : resolveRate(model, at)
    const current = nowContext()
    return {
      ok: true,
      enabled: true,
      sessionId,
      known: entry !== null,
      currency: overrides.currency,
      cost: entry === null ? 0 : entry.cost,
      calls: entry === null ? 0 : entry.calls,
      priced: entry === null ? 0 : entry.priced,
      unpriced: entry === null ? 0 : entry.unpriced,
      input: entry === null ? 0 : entry.input,
      cacheRead: entry === null ? 0 : entry.cacheRead,
      cacheMiss: entry === null ? 0 : entry.cacheMiss,
      output: entry === null ? 0 : entry.output,
      peakCalls: entry === null ? 0 : entry.peakCalls,
      offPeakCalls: entry === null ? 0 : entry.offPeakCalls,
      peakCost: entry === null ? 0 : entry.peakCost,
      offPeakCost: entry === null ? 0 : entry.offPeakCost,
      models: entry === null ? [] : Object.keys(entry.models),
      /** 已回溯补齐的历史调用数（0 = 没补过，显示口径是从装载那刻起）。 */
      backfilled: entry === null ? 0 : (num(entry.backfilledAt) > 0 ? Math.max(0, entry.calls - num(entry.priced) - num(entry.unpriced)) : 0),
      tariff: resolved === null ? null : resolved.row.id,
      tariffNote: resolved === null ? '' : resolved.row.note,
      currentRate: resolved === null ? null : (current.peak ? resolved.rate.peak : resolved.rate.offPeak),
      pricingFingerprint: fingerprint,
      now: current,
      showPeakBadge: overrides.showPeakBadge,
      ledgerFile: ledgerFile(),
      updatedAt: entry === null ? 0 : entry.updatedAt,
    }
  }

  function catalog(sessionId) {
    reloadIfChanged()
    const at = Date.now()
    const current = nowContext()
    const sessions = []
    for (const id of Object.keys(ledger.sessions)) {
      const entry = ledger.sessions[id]
      const model = Object.keys(entry.models)[0] || ''
      const resolved = model === '' ? null : resolveRate(model, at)
      sessions.push({
        sessionId: id,
        cost: entry.cost,
        calls: entry.calls,
        currency: entry.currency,
        lastAt: entry.lastAt,
        models: Object.keys(entry.models),
        currentRate: resolved === null ? null : (current.peak ? resolved.rate.peak : resolved.rate.offPeak),
      })
    }
    sessions.sort((a, b) => b.lastAt - a.lastAt)
    return {
      ok: true,
      enabled: true,
      currency: overrides.currency,
      now: current,
      pricingFingerprint: fingerprint,
      dataDir: dataDir(),
      ledgerFile: ledgerFile(),
      sessions,
    }
  }

  // ---------------------------------------------------------- 路由
  //
  // 三条各自独立的前缀路由（`/dsh-cost/...`）：脚本 + 数据。数据路由借用
  // harness 自己的 connection 信任闸，未换到浏览器会话凭据的请求一律拒绝
  // （否则本机任何进程都能读到你在花多少钱）。

  function sendJson(response, status, payload) {
    const body = Buffer.from(JSON.stringify(payload), 'utf8')
    response.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': String(body.length),
      'cache-control': 'no-store',
    })
    response.end(body)
  }

  /**
   * 借 harness 自己的信任闸：本机 + 已换到浏览器会话凭据的页面才放行。
   * 拿不到 connection 服务时退到「只认 Host 头的本机请求」，fail-closed。
   */
  function refuseUntrusted(request, response) {
    let status
    const rootCtx = ctx.root === undefined ? ctx : ctx.root
    let connection
    for (const source of [ctx, rootCtx]) {
      try {
        if (source === undefined || source === null || typeof source.get !== 'function') continue
        const candidate = source.get('connection')
        if (candidate === undefined || candidate === null) continue
        if (typeof candidate.requestRejection === 'function') {
          connection = candidate
          break
        }
      } catch (err) {
        /* try the next source */
      }
    }
    if (connection !== undefined) {
      try {
        status = connection.requestRejection(request)
      } catch (err) {
        status = 403
      }
      if (status !== undefined && typeof status !== 'number') status = 403
    } else {
      const host = String((request.headers && request.headers.host) || '')
      const local = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(host)
      status = local ? undefined : 403
    }
    if (status === undefined) return false
    response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' })
    response.end(status === 401 ? 'unauthorized' : 'forbidden')
    return true
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: ROUTE,
    handler: (request, response) => {
      try {
        if (refuseUntrusted(request, response)) return
        if (request.method !== 'GET') {
          response.writeHead(405, { allow: 'GET' })
          response.end()
          return
        }
        const url = new URL(request.url === undefined ? '/' : request.url, 'http://localhost')
        const scope = url.searchParams.get('scope') || 'session'
        if (scope === 'session') {
          // 浏览器半（slot 里的 React 组件）用这个取数：它手里直接有当前会话的
          // sessionId，所以"这数字属于哪个会话"不需要任何猜测。
          sendJson(response, 200, snapshot(url.searchParams.get('sessionId') || ''))
          return
        }
        if (scope === 'all') {
          sendJson(response, 200, catalog(''))
          return
        }
        if (scope === 'dump') {
          // 自诊断：账本 + 价目 + 当前峰谷，用来核对数字从哪来。
          sendJson(response, 200, {
            ok: true,
            fingerprint,
            ledgerFile: ledgerFile(),
            lastSaveError,
            holidays: Array.from(holidays).sort(),
            tariffs: TARIFFS,
            sessions: ledger.sessions,
          })
          return
        }
        if (scope === 'current') {
          // 兜底：页面没能给出会话 id 时，只有"账本里只有一个会话"才敢认，
          // 否则宁可说不知道，也不把别人的花销显示成你的。
          reloadIfChanged()
          const ids = Object.keys(ledger.sessions)
          if (ids.length !== 1) {
            sendJson(response, 200, { ok: true, enabled: true, sessionId: '', known: false, ambiguous: true, entries: ids.length })
            return
          }
          const only = snapshot(ids[0])
          only.fallback = true
          sendJson(response, 200, only)
          return
        }
        sendJson(response, 400, { ok: false, error: 'unknown scope: ' + scope })
      } catch (err) {
        logLine('error', '路由处理失败：', String((err && err.message) || err))
        sendJson(response, 500, { ok: false, error: String((err && err.message) || err) })
      }
    },
  }), 'dsh-cost: api route')

  // 装载即把配置与账本读一遍：/dump 在任何一次真实调用之前也能回答。
  readOverrides()
  loadLedger()
  saveLedgerNow()
  logLine('info', '已装载，账本：', ledgerFile())

  ctx.effect(() => () => {
    if (saveTimer !== null) {
      clearTimeout(saveTimer)
      saveTimer = null
    }
    saveLedgerNow()
  }, 'dsh-cost: flush ledger')
}

/**
 * 默认导出 = 同一个插件对象。
 *
 * DSH 的 loader 两种形态都接（命名导出或 default），但官方仓库里的插件几乎都是
 * `export default { name, inject, apply }`（todo-board、鲸鱼都是）。两种都给，
 * 无论 loader 走哪条分支都能取到，省掉一类"装载了却没注册"的静默失败。
 */
export default { name, inject, apply }
