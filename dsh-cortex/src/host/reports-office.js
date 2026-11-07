/**
 * Office-format report generation for the ported Cortex UI.
 *
 * The Markdown report built by `reports.js` is the single source of truth; this
 * module renders the same content as a Word document (docx) or a PDF. PDF text
 * is Chinese, so a CJK TTF font from the host OS is embedded (PDFKit cannot
 * embed the system .ttc collections, hence the TTF candidate list).
 *
 * Both renderers are pure Node (no browser APIs) and used by
 * `POST /vulns/export` when `format` is `docx` or `pdf`.
 */

import { existsSync } from 'node:fs'
import PDFDocument from 'pdfkit'
import {
  BorderStyle,
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  TextRun,
} from 'docx'

/** Common single-face CJK TrueType fonts; PDFKit rejects .ttc collections. */
const CJK_FONT_CANDIDATES = [
  'C:\\Windows\\Fonts\\simhei.ttf',
  'C:\\Windows\\Fonts\\simkai.ttf',
  'C:\\Windows\\Fonts\\simfang.ttf',
  'C:\\Windows\\Fonts\\Deng.ttf',
  'C:\\Windows\\Fonts\\msyh.ttf',
  '/System/Library/Fonts/Supplemental/Arial Unicode.ttf',
  '/Library/Fonts/Arial Unicode.ttf',
  '/usr/share/fonts/truetype/arphic/uming.ttc',
]

const DOCX_BODY_FONT = 'Microsoft YaHei'
const DOCX_MONO_FONT = 'Consolas'
const PDF_PAGE_MARGIN = 56

export function findCjkFont() {
  const explicit = process.env.CORTEX_PDF_FONT
  if (explicit && existsSync(explicit)) return explicit
  for (const candidate of CJK_FONT_CANDIDATES) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

/* ------------------------------------------------------------ markdown -- */

/**
 * Parse the report Markdown into simple blocks. Covers exactly what
 * `buildVulnReport` emits plus fenced HTTP/JSON code inside reproduction steps.
 * @param {string} markdown
 * @returns {Array<{type:'heading'|'paragraph'|'list'|'code'|'hr', level?:number, text?:string, lines?:string[]}>}
 */
export function parseReportMarkdown(markdown) {
  const lines = String(markdown ?? '')
    .replace(/\r\n/g, '\n')
    .split('\n')
  const blocks = []
  let index = 0
  while (index < lines.length) {
    const line = lines[index]
    if (line.trim() === '') {
      index += 1
      continue
    }
    if (/^```/.test(line)) {
      const code = []
      index += 1
      while (index < lines.length && !/^```/.test(lines[index])) {
        code.push(lines[index])
        index += 1
      }
      index += 1
      blocks.push({ type: 'code', text: code.join('\n') })
      continue
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      blocks.push({ type: 'heading', level: heading[1].length, text: heading[2].trim() })
      index += 1
      continue
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const items = []
      while (index < lines.length && /^\s*[-*]\s+/.test(lines[index])) {
        items.push(lines[index].replace(/^\s*[-*]\s+/, '').trim())
        index += 1
      }
      blocks.push({ type: 'list', lines: items })
      continue
    }
    if (/^---+$/.test(line.trim())) {
      blocks.push({ type: 'hr' })
      index += 1
      continue
    }
    const paragraph = []
    while (index < lines.length) {
      const next = lines[index]
      if (
        next.trim() === '' ||
        /^```/.test(next) ||
        /^#{1,6}\s+/.test(next) ||
        /^\s*[-*]\s+/.test(next) ||
        /^---+$/.test(next.trim())
      ) {
        break
      }
      paragraph.push(next.trim())
      index += 1
    }
    blocks.push({ type: 'paragraph', text: paragraph.join(' ') })
  }
  return blocks
}

/** Strip inline Markdown markers for plain-text renderers. */
export function plainInline(text) {
  return String(text ?? '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
}

/* ---------------------------------------------------------------- docx -- */

function docxInlineRuns(text) {
  const runs = []
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`)/g
  let last = 0
  let match
  while ((match = pattern.exec(String(text ?? ''))) !== null) {
    if (match.index > last) {
      runs.push(new TextRun({ text: String(text).slice(last, match.index) }))
    }
    const token = match[0]
    if (token.startsWith('**')) {
      runs.push(new TextRun({ text: token.slice(2, -2), bold: true }))
    } else {
      runs.push(new TextRun({ text: token.slice(1, -1), font: DOCX_MONO_FONT, shading: { fill: 'F3F4F6' } }))
    }
    last = match.index + token.length
  }
  if (last < String(text ?? '').length) runs.push(new TextRun({ text: String(text).slice(last) }))
  return runs.length > 0 ? runs : [new TextRun({ text: '' })]
}

function headingLevel(level) {
  if (level <= 1) return HeadingLevel.HEADING_1
  if (level === 2) return HeadingLevel.HEADING_2
  return HeadingLevel.HEADING_3
}

/**
 * Render the Markdown report as a Word document.
 * @param {string} markdown
 * @param {{ title?: string, author?: string }} [meta]
 * @returns {Promise<Buffer>}
 */
export async function renderDocxReport(markdown, meta = {}) {
  const children = []
  for (const block of parseReportMarkdown(markdown)) {
    if (block.type === 'heading') {
      children.push(
        new Paragraph({
          heading: headingLevel(block.level),
          spacing: { before: block.level <= 1 ? 0 : 220, after: 120 },
          children: docxInlineRuns(plainInline(block.text)),
        }),
      )
    } else if (block.type === 'paragraph') {
      children.push(
        new Paragraph({
          spacing: { after: 140, line: 320 },
          children: docxInlineRuns(block.text),
        }),
      )
    } else if (block.type === 'list') {
      for (const item of block.lines) {
        children.push(
          new Paragraph({
            bullet: { level: 0 },
            spacing: { after: 80, line: 300 },
            children: docxInlineRuns(item),
          }),
        )
      }
    } else if (block.type === 'code') {
      for (const line of block.text.split('\n')) {
        children.push(
          new Paragraph({
            spacing: { after: 0 },
            shading: { fill: 'F4F5F7' },
            children: [new TextRun({ text: line === '' ? ' ' : line, font: DOCX_MONO_FONT, size: 18 })],
          }),
        )
      }
      children.push(new Paragraph({ spacing: { after: 120 }, children: [] }))
    } else if (block.type === 'hr') {
      children.push(
        new Paragraph({
          border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: 'D1D5DB' } },
          spacing: { after: 120 },
          children: [],
        }),
      )
    }
  }

  const document = new Document({
    creator: 'Cortex / DSH',
    title: meta.title || 'Cortex vulnerability report',
    styles: {
      default: {
        document: {
          run: { font: DOCX_BODY_FONT, size: 21, color: '1F2937' },
          paragraph: { spacing: { line: 320 } },
        },
      },
    },
    sections: [{ properties: {}, children }],
  })
  return Packer.toBuffer(document)
}

/* ----------------------------------------------------------------- pdf -- */

function pdfCodeHeight(doc, text, width) {
  return doc.heightOfString(text, { width, lineGap: 1, fontSize: 8.5 })
}

/**
 * Render the Markdown report as a PDF with an embedded CJK font.
 * @param {string} markdown
 * @param {{ title?: string, author?: string }} [meta]
 * @returns {Promise<Buffer>}
 */
export async function renderPdfReport(markdown, meta = {}) {
  const fontPath = findCjkFont()
  if (fontPath === null) {
    throw new Error(
      'PDF 导出需要系统中文字体（TTF）：Windows 请安装“黑体/等线/楷体”，或设置环境变量 CORTEX_PDF_FONT 指向一个中文字体文件',
    )
  }

  const doc = new PDFDocument({
    size: 'A4',
    margins: { top: PDF_PAGE_MARGIN, left: PDF_PAGE_MARGIN, right: PDF_PAGE_MARGIN, bottom: PDF_PAGE_MARGIN + 18 },
    bufferPages: true,
    info: {
      Title: meta.title || 'Cortex vulnerability report',
      Author: meta.author || 'Cortex / DSH',
    },
  })
  const chunks = []
  doc.on('data', (chunk) => chunks.push(chunk))
  const finished = new Promise((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)))
    doc.on('error', reject)
  })

  doc.registerFont('body', fontPath)
  const contentWidth = doc.page.width - PDF_PAGE_MARGIN * 2
  const bottom = doc.page.height - PDF_PAGE_MARGIN - 18

  const ensureSpace = (height) => {
    if (doc.y + height > bottom) doc.addPage()
  }

  for (const block of parseReportMarkdown(markdown)) {
    if (block.type === 'heading') {
      const size = block.level <= 1 ? 19 : block.level === 2 ? 13.5 : 11.5
      ensureSpace(size + 24)
      doc.moveDown(block.level <= 1 ? 0 : 0.4)
      doc.font('body').fontSize(size).fillColor('#111111').text(plainInline(block.text), {
        width: contentWidth,
        lineGap: 2,
      })
      doc.moveDown(0.35)
    } else if (block.type === 'paragraph') {
      const text = plainInline(block.text)
      ensureSpace(20)
      doc.font('body').fontSize(10).fillColor('#26303C').text(text, {
        width: contentWidth,
        lineGap: 2.5,
        align: 'left',
      })
      doc.moveDown(0.55)
    } else if (block.type === 'list') {
      for (const item of block.lines) {
        ensureSpace(16)
        doc.font('body').fontSize(10).fillColor('#26303C').text(`• ${plainInline(item)}`, {
          width: contentWidth,
          indent: 10,
          lineGap: 2,
        })
        doc.moveDown(0.2)
      }
      doc.moveDown(0.25)
    } else if (block.type === 'code') {
      const text = block.text.length > 0 ? block.text : ' '
      const height = pdfCodeHeight(doc, text, contentWidth - 16) + 10
      ensureSpace(height + 6)
      const top = doc.y
      doc.save().roundedRect(PDF_PAGE_MARGIN, top, contentWidth, height, 4).fill('#F3F4F6').restore()
      doc
        .font('body')
        .fontSize(8.5)
        .fillColor('#1F2937')
        .text(text, PDF_PAGE_MARGIN + 8, top + 5, { width: contentWidth - 16, lineGap: 1 })
      doc.moveDown(0.5)
    } else if (block.type === 'hr') {
      ensureSpace(14)
      doc.moveDown(0.2)
      const y = doc.y
      doc.save().moveTo(PDF_PAGE_MARGIN, y).lineTo(PDF_PAGE_MARGIN + contentWidth, y)
        .lineWidth(0.6).strokeColor('#D1D5DB').stroke().restore()
      doc.moveDown(0.6)
    }
  }

  const pageCount = doc.bufferedPageRange().count
  for (let index = 0; index < pageCount; index += 1) {
    doc.switchToPage(index)
    doc
      .font('body')
      .fontSize(8)
      .fillColor('#94A3B8')
      .text(`第 ${index + 1} / ${pageCount} 页`, PDF_PAGE_MARGIN, doc.page.height - PDF_PAGE_MARGIN - 8, {
        width: contentWidth,
        align: 'right',
        lineBreak: false,
      })
  }
  doc.end()
  return finished
}
