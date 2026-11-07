/**
 * Read-only text formatting for the mini-program file viewer.
 *
 * Minified `app-config.json` is a single 70 KB line and `app-service.js` is a
 * multi-megabyte one-liner, so raw previews are unusable. This module adds:
 *   - JSON: parse + `JSON.stringify(_, null, 2)` (falls back to raw text),
 *   - JS/TS/WXS: a conservative, dependency-free tokenizer/beautifier that
 *     inserts line breaks after `{`, `}`, `;` and keeps string / template /
 *     comment / simple-regex contents untouched,
 *   - language detection by extension.
 *
 * Formatting is display-only: the original bytes on disk are never changed and
 * the formatter never executes the code.
 */

/** Input cap for formatting (larger files are previewed raw). */
export const MAX_FORMAT_INPUT_BYTES = 5 * 1024 * 1024
/** Output cap so a pathological one-liner cannot blow up the response. */
export const MAX_FORMAT_OUTPUT_BYTES = 4 * 1024 * 1024

const JS_EXTENSIONS = new Set(['.js', '.cjs', '.mjs', '.jsx', '.ts', '.tsx', '.wxs', '.wxml'])
const JSON_EXTENSIONS = new Set(['.json'])

/** @param {string} path */
export function languageOf(path) {
  const lowered = String(path || '').toLowerCase()
  for (const extension of JS_EXTENSIONS) {
    if (lowered.endsWith(extension)) return extension === '.wxml' ? 'xml' : 'js'
  }
  for (const extension of JSON_EXTENSIONS) {
    if (lowered.endsWith(extension)) return 'json'
  }
  return 'text'
}

/** Pretty-print JSON when it parses; returns null otherwise. */
export function formatJsonText(text) {
  const source = String(text || '')
  if (source.trim().length === 0) return null
  try {
    const parsed = JSON.parse(source)
    return `${JSON.stringify(parsed, null, 2)}\n`
  } catch {
    return null
  }
}

function isRegexStart(previousSignificant) {
  if (previousSignificant === '') return true
  return '(,=:[!&|?{};+-*%<>~^'.includes(previousSignificant)
}

/**
 * Conservative JS beautifier. It only moves whitespace; every non-whitespace
 * character is preserved in order. States tracked: single/double/template
 * strings, line/block comments and simple regex literals.
 * @param {string} text
 * @returns {string}
 */
export function formatJsText(text) {
  const source = String(text || '')
  if (source.length === 0) return ''
  let output = ''
  let indent = 0
  let lineStart = true
  let pendingSpace = false
  let previousSignificant = ''
  let index = 0
  const limit = Math.min(source.length, MAX_FORMAT_INPUT_BYTES)

  const indentText = () => '  '.repeat(Math.min(indent, 40))

  const push = (value) => {
    if (output.length + value.length > MAX_FORMAT_OUTPUT_BYTES) return false
    output += value
    if (value.length > 0) lineStart = value.endsWith('\n')
    return true
  }
  const newline = () => {
    if (output.length === 0) return true
    if (!output.endsWith('\n')) output += '\n'
    lineStart = true
    return true
  }

  while (index < limit) {
    const char = source[index]

    if (char === '\n' || char === '\r') {
      index += 1
      pendingSpace = false
      // Preserve the author's line structure; minified files simply have none.
      if (!lineStart) newline()
      continue
    }
    if (char === ' ' || char === '\t') {
      pendingSpace = true
      index += 1
      continue
    }

    if (lineStart) {
      if (!push(indentText())) break
      lineStart = false
      pendingSpace = false
    }

    if (char === '/' && source[index + 1] === '/') {
      const end = source.indexOf('\n', index)
      const stop = end < 0 ? limit : end
      if (!push(source.slice(index, stop))) break
      index = stop
      continue
    }
    if (char === '/' && source[index + 1] === '*') {
      const end = source.indexOf('*/', index + 2)
      const stop = end < 0 ? limit : end + 2
      if (!push(source.slice(index, stop))) break
      index = stop
      continue
    }
    if (char === "'" || char === '"' || char === '`') {
      const quote = char
      let stop = index + 1
      while (stop < limit) {
        if (source[stop] === '\\') {
          stop += 2
          continue
        }
        if (source[stop] === quote) {
          stop += 1
          break
        }
        stop += 1
      }
      if (!push(source.slice(index, stop))) break
      previousSignificant = quote
      index = stop
      continue
    }
    if (char === '/' && isRegexStart(previousSignificant)) {
      let stop = index + 1
      let inClass = false
      let closed = false
      while (stop < limit) {
        const current = source[stop]
        if (current === '\\') {
          stop += 2
          continue
        }
        if (current === '[') inClass = true
        else if (current === ']') inClass = false
        else if (current === '/' && !inClass) {
          stop += 1
          closed = true
          break
        } else if (current === '\n') {
          break
        }
        stop += 1
      }
      if (closed) {
        if (!push(source.slice(index, stop))) break
        previousSignificant = '/'
        index = stop
        continue
      }
      // Not a regex after all; fall through to normal handling.
    }

    if (char === '{') {
      let lookahead = index + 1
      while (lookahead < limit && /\s/.test(source[lookahead])) lookahead += 1
      if (source[lookahead] === '}') {
        if (!push('{}')) break
        previousSignificant = '}'
        index = lookahead + 1
        continue
      }
      if (!push('{')) break
      indent += 1
      newline()
      previousSignificant = '{'
      index += 1
      continue
    }
    if (char === '}') {
      indent = Math.max(0, indent - 1)
      if (!lineStart) newline()
      if (!push(`${indentText()}}`)) break
      previousSignificant = '}'
      index += 1
      // `} else`, `},`, `};` should stay on the same line.
      if (source[index] !== ';' && source[index] !== ',' && source[index] !== ')') newline()
      continue
    }
    if (char === ';') {
      if (!push(';')) break
      newline()
      previousSignificant = ';'
      index += 1
      continue
    }
    if (char === ',') {
      if (!push(', ')) break
      previousSignificant = ','
      index += 1
      continue
    }
    if (char === ')') {
      if (!push(')')) break
      previousSignificant = ')'
      index += 1
      continue
    }

    if (pendingSpace && output.length > 0) {
      const last = output[output.length - 1]
      if (!/[\s(\[{]/.test(last)) {
        if (!push(' ')) break
      }
    }
    pendingSpace = false
    if (!push(char)) break
    if (!/\s/.test(char)) previousSignificant = char
    index += 1
  }
  if (output.length > 0 && !output.endsWith('\n')) output += '\n'
  return output
}

/**
 * Format one preview chunk according to its file type.
 * @param {{path:string, content:string}} input
 * @returns {{text:string, formatted:boolean, language:'json'|'js'|'xml'|'text'}}
 */
export function formatContent(input) {
  const path = String((input && input.path) || '')
  const content = String((input && input.content) || '')
  const language = languageOf(path)
  if (language === 'json') {
    const formatted = formatJsonText(content)
    if (formatted !== null) return { text: formatted, formatted: true, language }
    return { text: content, formatted: false, language }
  }
  if (language === 'js') {
    const formatted = formatJsText(content)
    return { text: formatted, formatted: true, language }
  }
  return { text: content, formatted: false, language }
}
