// Formatting helpers for the Cortex page.
const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

function localeTag(locale) {
  const active = String(locale || 'en').toLowerCase()
  if (active.indexOf('zh') === 0) return 'zh-CN'
  return 'en-US'
}

function toDate(value) {
  if (!value) return null
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

function pad2(n) {
  return n < 10 ? `0${n}` : String(n)
}

/** ISO string -> localized "YYYY/MM/DD HH:mm" (keeps ISO strings, never shifts timezone rules). */
function fmtTime(value, locale) {
  const date = toDate(value)
  if (!date) return value ? String(value) : '—'
  try {
    return date.toLocaleString(localeTag(locale), {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    })
  } catch {
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`
  }
}

function fmtDate(value, locale) {
  const date = toDate(value)
  if (!date) return value ? String(value) : '—'
  try {
    return date.toLocaleDateString(localeTag(locale), { year: 'numeric', month: '2-digit', day: '2-digit' })
  } catch {
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
  }
}

function fmtRelative(value, locale, now) {
  const date = toDate(value)
  if (!date) return value ? String(value) : '—'
  const base = typeof now === 'number' ? now : Date.now()
  const diff = base - date.getTime()
  const zh = localeTag(locale) === 'zh-CN'
  if (diff < 0) return fmtTime(value, locale)
  if (diff < MINUTE) return zh ? '刚刚' : 'just now'
  if (diff < HOUR) {
    const n = Math.floor(diff / MINUTE)
    return zh ? `${n} 分钟前` : `${n}m ago`
  }
  if (diff < DAY) {
    const n = Math.floor(diff / HOUR)
    return zh ? `${n} 小时前` : `${n}h ago`
  }
  if (diff < 30 * DAY) {
    const n = Math.floor(diff / DAY)
    return zh ? `${n} 天前` : `${n}d ago`
  }
  return fmtDate(value, locale)
}

function bytes(size) {
  const n = Number(size)
  if (!Number.isFinite(n) || n < 0) return '—'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`
  return `${(n / (1024 * 1024)).toFixed(2)} MiB`
}

function truncate(text, max) {
  const value = String(text === undefined || text === null ? '' : text)
  const limit = typeof max === 'number' ? max : 120
  return value.length <= limit ? value : `${value.slice(0, Math.max(0, limit - 1))}…`
}

function asArray(value) {
  return Array.isArray(value) ? value : []
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function prettifyKey(value) {
  const text = String(value === undefined || value === null ? '' : value)
  if (!text) return ''
  const spaced = text.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/_/g, ' ').trim()
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

function plural(count, one, many) {
  return Number(count) === 1 ? one : many
}

function joinMeta(parts, separator) {
  const sep = separator || ' · '
  return asArray(parts)
    .filter((part) => part !== undefined && part !== null && part !== '')
    .join(sep)
}

module.exports = {
  fmtTime,
  fmtDate,
  fmtRelative,
  bytes,
  truncate,
  asArray,
  asObject,
  prettifyKey,
  plural,
  joinMeta,
  localeTag,
}
