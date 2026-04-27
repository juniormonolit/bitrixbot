import * as XLSX from 'xlsx'

export type ParsedExpense = {
  external_number: string
  document_title: string | null
  expense_date: string        // ISO 8601
  contractor: string | null
  comment: string | null
  amount: number
  category: string | null
  source: 'excel'
  raw_row: Record<string, unknown>
}

// Matches 1C-style document numbers: МС00-000023, РО01-001234, etc.
// Pattern: 2-6 Cyrillic/Latin uppercase letters + 2 digits + hyphen + 4-8 digits
const EXTERNAL_NUMBER_RE = /([А-ЯЁA-Z]{2,6}\d{2}-\d{4,8})/u

// dd.MM.yyyy — time part (HH:mm and optional :ss) is optional
const DATE_RE = /(\d{2})\.(\d{2})\.(\d{4})(?:\s+(\d{2}):(\d{2})(?::(\d{2}))?)?/

// Moscow has been at UTC+3 with no DST since 26 Oct 2014.
const MOSCOW_UTC_OFFSET_MS = 3 * 60 * 60 * 1000

// ── Column auto-detection ─────────────────────────────────────────────────────

type ColMap = {
  doc: number          // document title cell (column A by default)
  contractor: number   // contractor cell
  comment: number      // -1 if not detected
  amount: number       // debit/amount cell
  category: number     // -1 if not detected
}

/** Fallback column indices (hardcoded for standard 1C exports). */
const DEFAULT_COLS: ColMap = {
  doc: 0, contractor: 3, comment: 5, amount: 6, category: 10,
}

const RX_CONTRACTOR = /контрагент/i
const RX_COMMENT    = /назначени|комментари|содержани|примечани/i
const RX_CATEGORY   = /статья|категори/i
// Amount: look for "Сумма Дт" / "Оборот Дт" first, then plain "Сумма"
const RX_AMOUNT_DT  = /сумма\s*дт|оборот\s*дт/i
const RX_AMOUNT     = /\bсумма\b/i

/**
 * Scans the first 20 rows for a header row that contains "Контрагент".
 * Returns detected column indices, falling back to DEFAULT_COLS for anything not found.
 */
function detectColumns(rows: unknown[][]): ColMap {
  for (let i = 0; i < Math.min(20, rows.length); i++) {
    const row = rows[i]

    const contractorIdx = row.findIndex(
      (cell) => typeof cell === 'string' && RX_CONTRACTOR.test(cell),
    )
    if (contractorIdx === -1) continue   // not a header row

    const result: ColMap = {
      doc: DEFAULT_COLS.doc,
      contractor: contractorIdx,
      comment: -1,
      amount: -1,
      category: -1,
    }

    // Scan all cells in the header row for the other columns
    let amountDtIdx = -1
    let amountIdx   = -1

    for (let c = 0; c < row.length; c++) {
      if (c === contractorIdx) continue
      const cell = String(row[c] ?? '').trim()
      if (RX_COMMENT.test(cell))   { result.comment   = c; continue }
      if (RX_CATEGORY.test(cell))  { result.category  = c; continue }
      if (RX_AMOUNT_DT.test(cell)) { amountDtIdx = c; continue }
      if (RX_AMOUNT.test(cell))    { amountIdx   = c }
    }

    // Prefer "Сумма Дт" over plain "Сумма"
    result.amount = amountDtIdx !== -1 ? amountDtIdx
                  : amountIdx   !== -1 ? amountIdx
                  : DEFAULT_COLS.amount

    if (result.category === -1) result.category = DEFAULT_COLS.category

    return result
  }

  return DEFAULT_COLS
}

// ── Merged cell expansion ─────────────────────────────────────────────────────

/**
 * Fills all cells within every merge range with the value of the top-left cell.
 * xlsx only stores the value in the first cell; the rest are absent from the sheet map.
 */
function expandMergedCells(sheet: XLSX.WorkSheet): void {
  const merges: XLSX.Range[] = sheet['!merges'] ?? []
  for (const merge of merges) {
    const topLeftAddr = XLSX.utils.encode_cell({ r: merge.s.r, c: merge.s.c })
    const topLeftCell = sheet[topLeftAddr]
    if (!topLeftCell) continue

    for (let r = merge.s.r; r <= merge.e.r; r++) {
      for (let c = merge.s.c; c <= merge.e.c; c++) {
        if (r === merge.s.r && c === merge.s.c) continue
        sheet[XLSX.utils.encode_cell({ r, c })] = { ...topLeftCell }
      }
    }
  }
}

// ── Date parsing ──────────────────────────────────────────────────────────────

/**
 * Parses a date string like "16.01.2026 10:11:35" or "16.01.2026 10:11" or
 * "16.01.2026" treating it as Moscow time (UTC+3) and returns a UTC ISO-8601 string.
 *
 * When no time is present, defaults to 12:00:00 MSK (= 09:00:00 UTC).
 */
export function parseMoscowDateTimeToIso(text: string): string | null {
  const m = text.match(DATE_RE)
  if (!m) return null
  const dd   = Number(m[1])
  const MM   = Number(m[2])
  const yyyy = Number(m[3])
  const HH   = m[4] !== undefined ? Number(m[4]) : 12   // default noon MSK
  const min  = m[5] !== undefined ? Number(m[5]) : 0
  const ss   = m[6] !== undefined ? Number(m[6]) : 0

  const utcMs = Date.UTC(yyyy, MM - 1, dd, HH, min, ss) - MOSCOW_UTC_OFFSET_MS
  const d = new Date(utcMs)
  return isNaN(d.getTime()) ? null : d.toISOString()
}

// ── Value helpers ─────────────────────────────────────────────────────────────

function toNumber(raw: unknown): number {
  if (raw === null || raw === undefined || raw === '') return 0
  if (typeof raw === 'number') return isNaN(raw) ? 0 : raw
  const n = parseFloat(String(raw).replace(',', '.').replace(/\s/g, ''))
  return isNaN(n) ? 0 : n
}

/**
 * Converts a raw cell value to a trimmed non-empty string, stripping any
 * leading punctuation artifacts that 1C sometimes inserts (e.g. ", " prefix).
 */
function toText(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null
  const s = String(raw)
    .trim()
    .replace(/^[,;:\s\-–—]+/, '')  // strip leading , ; : - – — and whitespace
    .trim()
  return s.length > 0 ? s : null
}

// ── Main parser ───────────────────────────────────────────────────────────────

export function parseExpensesExcel(buffer: Buffer): ParsedExpense[] {
  const workbook = XLSX.read(buffer, {
    type: 'buffer',
    // Do NOT use cellDates:true — we parse dates manually from text
    // to avoid xlsx serial-number quirks with 1C exports.
  })

  const sheetName = workbook.SheetNames[0]
  if (!sheetName) throw new Error('Excel file contains no sheets')

  const sheet = workbook.Sheets[sheetName]

  // Expand merged cells so every cell in a merge carries the value
  expandMergedCells(sheet)

  // header:1 → each row is an array; defval:null for missing cells
  const rawRows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    defval: null,
  })

  // Auto-detect column layout from the header row
  const cols = detectColumns(rawRows)

  const results: ParsedExpense[] = []

  for (let rowIdx = 0; rowIdx < rawRows.length; rowIdx++) {
    const row = rawRows[rowIdx]

    const rawDoc        = row[cols.doc]
    const rawContractor = row[cols.contractor]
    const rawComment    = cols.comment  !== -1 ? row[cols.comment]  : null
    const rawAmount     = row[cols.amount]
    const rawCategory   = cols.category !== -1 ? row[cols.category] : null

    const docText = String(rawDoc ?? '').trim()
    if (!docText) continue

    // Must contain a recognisable document number
    const numMatch = docText.match(EXTERNAL_NUMBER_RE)
    if (!numMatch) continue
    const external_number = numMatch[1]

    const expense_date = parseMoscowDateTimeToIso(docText)
    if (!expense_date) continue  // date is required

    results.push({
      external_number,
      document_title: docText,
      expense_date,
      contractor: toText(rawContractor),
      comment:    toText(rawComment),
      amount:     toNumber(rawAmount),
      category:   toText(rawCategory),
      source: 'excel',
      raw_row: {
        _excel_row:    rowIdx + 1,
        _col_map:      cols,
        A:             rawDoc,
        contractor:    rawContractor,
        comment:       rawComment,
        amount:        rawAmount,
        category:      rawCategory,
      },
    })
  }

  return results
}
