// Small safe Markdown renderer (no dangerouslySetInnerHTML).
// Handles the subset Cortex writes: headings, paragraphs, bold/italic/code,
// links, ordered/unordered lists, blockquotes, tables, fenced code blocks and
// horizontal rules. Rendered with React elements only.
const React = require('react')
const h = React.createElement
const { Pre } = require('./kit.js')

const SCHEMES = /^(https?:|mailto:|\/)/i

function renderInline(text, keyPrefix) {
  const source = String(text === undefined || text === null ? '' : text)
  const nodes = []
  const pattern = /(\*\*[^*]+\*\*|__[^_]+__|`[^`]+`|\[[^\]]+\]\([^)]+\)|\*[^*\n]+\*|_[^_\n]+_)/g
  let lastIndex = 0
  let match
  let index = 0
  while ((match = pattern.exec(source)) !== null) {
    if (match.index > lastIndex) nodes.push(source.slice(lastIndex, match.index))
    const token = match[0]
    const key = `${keyPrefix || 'i'}-${index++}`
    if (token.startsWith('**') || token.startsWith('__')) {
      nodes.push(h('strong', { key }, renderInline(token.slice(2, -2), `${key}-b`)))
    } else if (token.startsWith('`')) {
      nodes.push(h('code', { key }, token.slice(1, -1)))
    } else if (token.startsWith('[')) {
      const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token)
      if (link && SCHEMES.test(link[2])) {
        const external = /^https?:/i.test(link[2])
        nodes.push(
          h(
            'a',
            external ? { key, href: link[2], target: '_blank', rel: 'noopener noreferrer' } : { key, href: link[2] },
            link[1],
          ),
        )
      } else {
        nodes.push(token)
      }
    } else if (token.startsWith('*') || token.startsWith('_')) {
      nodes.push(h('em', { key }, renderInline(token.slice(1, -1), `${key}-i`)))
    }
    lastIndex = pattern.lastIndex
  }
  if (lastIndex < source.length) nodes.push(source.slice(lastIndex))
  return nodes.length ? nodes : [source]
}

function isTableSeparator(line) {
  return /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(line)
}

function splitRow(line) {
  let trimmed = line.trim()
  if (trimmed.startsWith('|')) trimmed = trimmed.slice(1)
  if (trimmed.endsWith('|')) trimmed = trimmed.slice(0, -1)
  return trimmed.split('|').map((cell) => cell.trim())
}

function renderBlocks(lines, startKey) {
  const blocks = []
  let index = 0
  let key = startKey || 0
  const nextKey = () => `${key++}`

  while (index < lines.length) {
    const line = lines[index]
    if (!line.trim()) {
      index++
      continue
    }

    const fence = /^\s*```([A-Za-z0-9_+-]*)\s*$/.exec(line)
    if (fence) {
      const language = fence[1]
      index++
      const code = []
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) {
        code.push(lines[index])
        index++
      }
      index++
      blocks.push(
        h(
          Pre,
          { key: nextKey(), 'aria-label': language ? `${language} code` : 'code' },
          language ? h('div', { className: 'dshc-small dshc-muted' }, language) : null,
          code.join('\n'),
        ),
      )
      continue
    }

    const heading = /^\s*(#{1,6})\s+(.*\S)\s*$/.exec(line)
    if (heading) {
      const level = Math.min(4, Math.max(1, heading[1].length))
      blocks.push(h(`h${level}`, { key: nextKey() }, renderInline(heading[2], `h${key}`)))
      index++
      continue
    }

    if (/^\s*(?:---+|\*\*\*+)\s*$/.test(line)) {
      blocks.push(h('hr', { key: nextKey(), className: 'dshc-hr' }))
      index++
      continue
    }

    if (/^\s*>\s?/.test(line)) {
      const quote = []
      while (index < lines.length && /^\s*>\s?/.test(lines[index])) {
        quote.push(lines[index].replace(/^\s*>\s?/, ''))
        index++
      }
      blocks.push(h('blockquote', { key: nextKey() }, renderBlocks(quote, key * 100)))
      continue
    }

    if (/^\s*(?:[-*+])\s+/.test(line)) {
      const items = []
      while (index < lines.length && /^\s*(?:[-*+])\s+/.test(lines[index])) {
        items.push(h('li', { key: `${nextKey()}-li` }, renderInline(lines[index].replace(/^\s*(?:[-*+])\s+/, ''), `li${key}`)))
        index++
      }
      blocks.push(h('ul', { key: nextKey() }, items))
      continue
    }

    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items = []
      while (index < lines.length && /^\s*\d+[.)]\s+/.test(lines[index])) {
        items.push(h('li', { key: `${nextKey()}-li` }, renderInline(lines[index].replace(/^\s*\d+[.)]\s+/, ''), `oli${key}`)))
        index++
      }
      blocks.push(h('ol', { key: nextKey() }, items))
      continue
    }

    if (line.indexOf('|') >= 0 && index + 1 < lines.length && isTableSeparator(lines[index + 1])) {
      const header = splitRow(line)
      index += 2
      const rows = []
      while (index < lines.length && lines[index].indexOf('|') >= 0 && lines[index].trim()) {
        rows.push(splitRow(lines[index]))
        index++
      }
      blocks.push(
        h(
          'table',
          { key: nextKey() },
          h('thead', null, h('tr', null, header.map((cell, i) => h('th', { key: i }, renderInline(cell, `th${i}`))))),
          h(
            'tbody',
            null,
            rows.map((row, rowIndex) =>
              h('tr', { key: rowIndex }, row.map((cell, cellIndex) => h('td', { key: cellIndex }, renderInline(cell, `td${cellIndex}`)))),
            ),
          ),
        ),
      )
      continue
    }

    const paragraph = []
    while (
      index < lines.length &&
      lines[index].trim() &&
      !/^\s*(?:```|#{1,6}\s|>\s?|[-*+]\s|\d+[.)]\s)/.test(lines[index]) &&
      !(lines[index].indexOf('|') >= 0 && index + 1 < lines.length && isTableSeparator(lines[index + 1]))
    ) {
      paragraph.push(lines[index])
      index++
    }
    blocks.push(h('p', { key: nextKey() }, renderInline(paragraph.join(' '), `p${key}`)))
  }
  return blocks
}

function Markdown(props) {
  const text = props.text === undefined || props.text === null ? '' : String(props.text)
  if (!text.trim()) return props.empty === undefined ? h('div', { className: 'dshc-muted dshc-small' }, '—') : props.empty
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  return h('div', { className: 'dshc-md ' + (props.className || '') }, renderBlocks(lines, 0))
}

module.exports = { Markdown, renderInline, renderBlocks }
