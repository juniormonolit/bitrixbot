import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase/server'
import { EXPENSE_CATEGORIES } from '@/lib/expenses/categories'
import type { CategoryNormEntry } from '@/lib/pnl/category-norm-heat'
import { parseCategoryNormDbRow } from '@/lib/pnl/category-norm-heat'
import type { PnlRowNormEntry, PnlRowNormKey } from '@/lib/pnl/row-norm'
import { parsePnlRowNormDbRow, PNL_ROW_NORM_KEYS } from '@/lib/pnl/row-norm'

// ── Constants ─────────────────────────────────────────────────────────────────

const NO_CATEGORY = 'Без категории'

const MONTH_LABELS = [
  'Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
  'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь',
]

const MSK_OFFSET_MS = 3 * 60 * 60 * 1000

function moscowMonthKey(isoUtc: string): string {
  const mskMs = new Date(isoUtc).getTime() + MSK_OFFSET_MS
  const d     = new Date(mskMs)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

function numMonthKey(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, '0')}`
}

// The credit_taxes group always has this fixed ID (set in restructure_pnl_full migration)
const CREDIT_TAXES_ID = 'd0000000-0000-0000-0000-000000000001'

// ── Response types ────────────────────────────────────────────────────────────

export type MonthInfo = { key: string; label: string }

export type CategorySummary = {
  category: string
  /** Подпись в UI (из настроек категорий) */
  displayName: string
  months: Record<string, number>
  total: number
}

/**
 * A node in the P&L structure tree.
 *
 * Percent rules (denominator):
 *   key='revenue' or key='cogs' → no percent (null)
 *   key='gross_margin'          → percent = value / revenue
 *   all other rows              → percent = value / gross_margin
 */
export type PnlRow = {
  id: string
  key: string
  name: string
  type: 'manual' | 'category' | 'group' | 'formula'
  level: number
  parent_id: string | null
  category: string | null
  formula?: Record<string, unknown>
  months: Record<string, number>
  total: number
  percents: Record<string, number | null>
  totalPercent: number | null
  children: PnlRow[]
}

/** Backward-compat alias */
export type StructureRow = PnlRow

export type SummaryResponse = {
  year: number
  /** true = колонки месяцев за весь доступный период (несколько лет). */
  allTime: boolean
  months: MonthInfo[]
  pnlRows: PnlRow[]
  structure: PnlRow[]
  categories: CategorySummary[]
  grandTotalByMonth: Record<string, number>
  grandTotal: number
  settings: Record<string, number>
  /** Нормативы % и сумм (₽/мес) по имени категории из expenses — для подсветки в P&L. */
  categoryNorms: Record<string, CategoryNormEntry>
  /** Нормативы для МАРЖИНАЛЬНОЙ ПРИБЫЛИ и чистой прибыли. */
  rowNorms: Partial<Record<PnlRowNormKey, PnlRowNormEntry>>
}

// ── DB row shape ──────────────────────────────────────────────────────────────

type DbStructureRow = {
  id: string
  name: string
  type: string
  parent_id: string | null
  category: string | null
  formula: string | null
  key: string | null
  sort_order: number
  level: number
}

// ── Keys that never show a percent ────────────────────────────────────────────
const NO_PERCENT_KEYS = new Set(['revenue', 'cogs'])

// ── Formula evaluator ─────────────────────────────────────────────────────────

/**
 * Evaluates a formula JSON object.
 * Supports:
 *   { op: 'add' | 'subtract', left: string, right: string }
 *   { op: 'multiply_setting', sum_refs: string[], setting_key: string }
 */
function evalFormula(
  formula: Record<string, unknown>,
  ctx: Map<string, Record<string, number>>,
  settings: Record<string, number>,
  months: MonthInfo[],
): Record<string, number> {
  const result: Record<string, number> = {}

  if (formula.op === 'multiply_setting') {
    const refs = (formula.sum_refs as string[]) ?? []
    const sv   = settings[(formula.setting_key as string) ?? ''] ?? 0
    for (const m of months) {
      result[m.key] = refs.reduce((s, ref) => s + (ctx.get(ref)?.[m.key] ?? 0), 0) * sv
    }
    return result
  }

  // add / subtract
  const left  = (formula.left  as string) ?? ''
  const right = (formula.right as string) ?? ''
  for (const m of months) {
    const lv = ctx.get(left)?.[m.key]  ?? 0
    const rv = ctx.get(right)?.[m.key] ?? 0
    result[m.key] = formula.op === 'subtract' ? lv - rv : lv + rv
  }
  return result
}

// ── Expense-only tree builder (group + category rows) ────────────────────────

function categoryDisplayLabel(name: string, displayName: string | null | undefined): string {
  const t = displayName?.trim()
  return t || name
}

/** Подменяет name у строк типа category на подпись из справочника */
function applyCategoryDisplayNames(rows: PnlRow[], labelByName: Map<string, string>): void {
  for (const r of rows) {
    if (r.type === 'category' && r.category) {
      const lbl = labelByName.get(r.category)
      if (lbl !== undefined) r.name = lbl
    }
    if (r.children.length) applyCategoryDisplayNames(r.children, labelByName)
  }
}

function buildExpenseTree(
  allRows: DbStructureRow[],
  catAmounts: Map<string, Map<string, number>>,
  months: MonthInfo[],
  parentId: string | null,
): PnlRow[] {
  return allRows
    .filter((r) => r.parent_id === parentId && (r.type === 'group' || r.type === 'category'))
    .sort((a, b) => a.sort_order - b.sort_order)
    .map((r): PnlRow => {
      const monthsRec: Record<string, number> = {}

      if (r.type === 'category') {
        const catMap = catAmounts.get(r.category ?? '') ?? new Map<string, number>()
        let total = 0
        for (const m of months) {
          const amt = catMap.get(m.key) ?? 0
          monthsRec[m.key] = amt
          total += amt
        }
        return {
          id: r.id, key: r.key ?? r.id, name: r.name, type: 'category', level: r.level,
          parent_id: r.parent_id, category: r.category,
          months: monthsRec, total, percents: {}, totalPercent: null, children: [],
        }
      }

      const children = buildExpenseTree(allRows, catAmounts, months, r.id)
      let total = 0
      for (const m of months) {
        const amt = children.reduce((s, c) => s + (c.months[m.key] ?? 0), 0)
        monthsRec[m.key] = amt
        total += amt
      }
      return {
        id: r.id, key: r.key ?? r.id, name: r.name, type: 'group', level: r.level,
        parent_id: r.parent_id, category: null,
        months: monthsRec, total, percents: {}, totalPercent: null, children,
      }
    })
}

// ── Credit-taxes group builder ────────────────────────────────────────────────

/** Категория в expenses для строки «Прибыль и убыток (пр.лет)». */
const PROFIT_LOSS_EXPENSE_CATEGORY = 'Прибыль убыток'

/**
 * Builds the "Кредит и налоги" group with its formula / category / manual children.
 * Called AFTER the ctx is populated with expense group keys.
 */
function buildCreditTaxesGroup(
  dbRows: DbStructureRow[],
  ctx: Map<string, Record<string, number>>,
  settings: Record<string, number>,
  months: MonthInfo[],
  catAggr: Map<string, Map<string, number>>,
): PnlRow {
  const children: PnlRow[] = dbRows
    .filter((r) => r.parent_id === CREDIT_TAXES_ID)
    .sort((a, b) => a.sort_order - b.sort_order)
    .map((r): PnlRow => {
      let monthsRec: Record<string, number>
      let formulaDef: Record<string, unknown> | undefined

      if (r.type === 'formula') {
        let parsed: Record<string, unknown> | null = null
        try { parsed = JSON.parse(r.formula ?? '') } catch { /* */ }
        formulaDef = parsed ?? undefined
        monthsRec = parsed
          ? evalFormula(parsed, ctx, settings, months)
          : Object.fromEntries(months.map((m) => [m.key, 0]))
      } else if (r.type === 'category') {
        const catMap = catAggr.get(r.category ?? '') ?? new Map<string, number>()
        monthsRec = {}
        for (const m of months) {
          monthsRec[m.key] = catMap.get(m.key) ?? 0
        }
        const total = months.reduce((s, m) => s + (monthsRec[m.key] ?? 0), 0)
        return {
          id: r.id, key: r.key ?? r.id, name: r.name,
          type: 'category',
          level: r.level, parent_id: r.parent_id, category: r.category,
          months: monthsRec, total, percents: {}, totalPercent: null, children: [],
        }
      } else {
        // manual (legacy)
        const metricKey = r.key ?? r.category ?? ''
        monthsRec = { ...(ctx.get(metricKey) ?? Object.fromEntries(months.map((m) => [m.key, 0]))) }
      }

      const total = months.reduce((s, m) => s + (monthsRec[m.key] ?? 0), 0)
      return {
        id: r.id, key: r.key ?? r.id, name: r.name,
        type: r.type as 'formula' | 'manual',
        level: r.level, parent_id: r.parent_id, category: r.category,
        formula: formulaDef,
        months: monthsRec, total, percents: {}, totalPercent: null, children: [],
      }
    })

  const groupMonths: Record<string, number> = {}
  for (const m of months) {
    groupMonths[m.key] = children.reduce((s, c) => s + (c.months[m.key] ?? 0), 0)
  }
  const groupTotal = months.reduce((s, m) => s + groupMonths[m.key], 0)

  return {
    id: CREDIT_TAXES_ID, key: 'credit_taxes', name: 'Кредит и налоги',
    type: 'group', level: 0, parent_id: null, category: null,
    months: groupMonths, total: groupTotal, percents: {}, totalPercent: null,
    children,
  }
}

// ── Percent annotation ────────────────────────────────────────────────────────

function annotatePercents(
  row: PnlRow,
  revenueMonths: Record<string, number>,
  grossMarginMonths: Record<string, number>,
  totalRevenue: number,
  totalGrossMargin: number,
): void {
  const percents: Record<string, number | null> = {}

  for (const mk of Object.keys(revenueMonths)) {
    if (NO_PERCENT_KEYS.has(row.key)) {
      percents[mk] = null
    } else if (row.key === 'gross_margin') {
      const rev = revenueMonths[mk] ?? 0
      percents[mk] = rev !== 0 ? ((grossMarginMonths[mk] ?? 0) / rev) * 100 : null
    } else {
      const gm = grossMarginMonths[mk] ?? 0
      percents[mk] = gm !== 0 ? ((row.months[mk] ?? 0) / gm) * 100 : null
    }
  }

  row.percents = percents

  if (NO_PERCENT_KEYS.has(row.key)) {
    row.totalPercent = null
  } else if (row.key === 'gross_margin') {
    row.totalPercent = totalRevenue !== 0 ? (totalGrossMargin / totalRevenue) * 100 : null
  } else {
    row.totalPercent = totalGrossMargin !== 0 ? (row.total / totalGrossMargin) * 100 : null
  }

  for (const child of row.children) {
    annotatePercents(child, revenueMonths, grossMarginMonths, totalRevenue, totalGrossMargin)
  }
}

function monthKeyLabel(key: string): string {
  const [ys, ms] = key.split('-')
  const y = parseInt(ys ?? '', 10)
  const m = parseInt(ms ?? '', 10)
  if (isNaN(y) || isNaN(m) || m < 1 || m > 12) return key
  return `${MONTH_LABELS[m - 1]} ${y}`
}

// ── Handler ───────────────────────────────────────────────────────────────────

export async function GET(request: NextRequest): Promise<NextResponse> {
  const sp      = request.nextUrl.searchParams
  const allTime =
    sp.get('allTime') === '1' ||
    sp.get('all_time') === '1' ||
    sp.get('year')?.toLowerCase() === 'all'

  const year = parseInt(sp.get('year') ?? String(new Date().getFullYear()), 10)

  if (!allTime && (isNaN(year) || year < 2000 || year > 2100)) {
    return NextResponse.json({ error: 'Invalid year' }, { status: 400 })
  }

  let supabase
  try { supabase = createServerClient() } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }

  // ── 1. Load pnl_structure ─────────────────────────────────────────────────
  const { data: structureData } = await supabase
    .from('pnl_structure')
    .select('id, name, type, parent_id, category, formula, key, sort_order, level')
    .eq('is_active', true)
    .order('sort_order', { ascending: true })

  // ── 2. Load expenses ──────────────────────────────────────────────────────
  let expQ = supabase.from('expenses').select('expense_date, category, amount').is('deleted_at', null)
  if (!allTime) {
    expQ = expQ
      .gte('expense_date', `${year}-01-01T00:00:00.000Z`)
      .lt('expense_date', `${year + 1}-01-01T00:00:00.000Z`)
  }
  const { data, error } = await expQ

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // ── 3. Load manual metrics (revenue, gross_margin) ─────────────────────────
  let manQ = supabase
    .from('pnl_monthly_values')
    .select('year, month, metric, amount')
    .in('metric', ['revenue', 'gross_margin'])
  if (!allTime) manQ = manQ.eq('year', year)
  const { data: manualData } = await manQ

  // ── 4. Load settings ──────────────────────────────────────────────────────
  const { data: settingsData } = await supabase
    .from('pnl_settings')
    .select('key, value')

  const settings: Record<string, number> = {}
  for (const s of settingsData ?? []) settings[s.key] = Number(s.value)

  const { data: normsData } = await supabase
    .from('pnl_category_norms')
    .select('category, norm_percent, norm_amount, attention_of_norm_pct, critical_of_norm_pct')

  const categoryNorms: Record<string, CategoryNormEntry> = {}
  for (const r of normsData ?? []) {
    categoryNorms[r.category] = parseCategoryNormDbRow(r)
  }

  const { data: rowNormsData } = await supabase
    .from('pnl_row_norms')
    .select('row_key, norm_percent, norm_percent_of_revenue, attention_of_norm_pct, critical_of_norm_pct')

  const rowNorms: Partial<Record<PnlRowNormKey, PnlRowNormEntry>> = {}
  for (const r of rowNormsData ?? []) {
    const k = r.row_key as string
    if ((PNL_ROW_NORM_KEYS as readonly string[]).includes(k)) {
      rowNorms[k as PnlRowNormKey] = parsePnlRowNormDbRow(r)
    }
  }

  // ── 5. Load category order и подписи для UI ───────────────────────────────
  let categoryOrder: Map<string, number>
  let categoryDisplay: Map<string, string>
  try {
    const { data: cats, error: catErr } = await supabase
      .from('expense_categories')
      .select('name, sort_order, display_name')
      .eq('is_active', true)
      .order('sort_order', { ascending: true })
    if (catErr || !cats?.length) throw new Error('no data')
    categoryOrder = new Map(cats.map((c) => [c.name, c.sort_order]))
    categoryDisplay = new Map(
      cats.map((c) => [c.name, categoryDisplayLabel(c.name, c.display_name)]),
    )
  } catch {
    categoryOrder = new Map(EXPENSE_CATEGORIES.map((c, i) => [c as string, i * 10]))
    categoryDisplay = new Map(EXPENSE_CATEGORIES.map((c) => [c as string, c as string]))
  }

  // ── 6. Aggregate expenses by (category, month) ────────────────────────────
  const catAggr = new Map<string, Map<string, number>>()

  for (const row of data ?? []) {
    const cat      = row.category?.trim() || NO_CATEGORY
    const monthKey = moscowMonthKey(row.expense_date as string)
    if (!catAggr.has(cat)) catAggr.set(cat, new Map())
    const m = catAggr.get(cat)!
    m.set(monthKey, (m.get(monthKey) ?? 0) + Number(row.amount))
  }

  // ── 7. Month columns ───────────────────────────────────────────────────────
  const cy = new Date().getFullYear()
  let months: MonthInfo[]
  let responseYear: number

  if (allTime) {
    const monthKeys = new Set<string>()
    for (const row of data ?? []) {
      monthKeys.add(moscowMonthKey(row.expense_date as string))
    }
    for (const row of manualData ?? []) {
      monthKeys.add(numMonthKey(Number(row.year), Number(row.month)))
    }
    const sorted = [...monthKeys].sort()
    if (sorted.length === 0) {
      months = Array.from({ length: 12 }, (_, i) => ({
        key:   `${cy}-${String(i + 1).padStart(2, '0')}`,
        label: MONTH_LABELS[i],
      }))
      responseYear = cy
    } else {
      months = sorted.map((key) => ({ key, label: monthKeyLabel(key) }))
      const lastY = parseInt(sorted[sorted.length - 1]!.split('-')[0]!, 10)
      responseYear = isNaN(lastY) ? cy : lastY
    }
  } else {
    months = Array.from({ length: 12 }, (_, i) => ({
      key:   `${year}-${String(i + 1).padStart(2, '0')}`,
      label: MONTH_LABELS[i],
    }))
    responseYear = year
  }

  // ── 8. Build manual metrics maps ─────────────────────────────────────────
  const revenueMonths:     Record<string, number> = {}
  const grossMarginMonths: Record<string, number> = {}
  for (const m of months) {
    revenueMonths[m.key]     = 0
    grossMarginMonths[m.key] = 0
  }

  for (const row of manualData ?? []) {
    const mk = allTime
      ? numMonthKey(Number(row.year), Number(row.month))
      : numMonthKey(year, row.month)
    if (row.metric === 'revenue')      revenueMonths[mk]     = Number(row.amount)
    if (row.metric === 'gross_margin') grossMarginMonths[mk] = Number(row.amount)
  }

  // ── 9. Build expense structure tree (excludes credit_taxes) ───────────────
  const dbRows = (structureData ?? []) as DbStructureRow[]

  // Exclude credit_taxes group and its children from the regular expense tree
  const expenseDbRows = dbRows.filter(
    (r) => r.id !== CREDIT_TAXES_ID && r.parent_id !== CREDIT_TAXES_ID,
  )

  const structure: PnlRow[] = dbRows.length
    ? buildExpenseTree(expenseDbRows, catAggr, months, null)
    : []

  // ── 10. Build formula evaluation context ──────────────────────────────────
  const profitLossPrevYearsMo: Record<string, number> = {}
  const plCatMap = catAggr.get(PROFIT_LOSS_EXPENSE_CATEGORY) ?? new Map<string, number>()
  for (const m of months) {
    profitLossPrevYearsMo[m.key] = plCatMap.get(m.key) ?? 0
  }

  const ctx = new Map<string, Record<string, number>>()
  ctx.set('revenue',                revenueMonths)
  ctx.set('gross_margin',           grossMarginMonths)
  ctx.set('profit_loss_prev_years', profitLossPrevYearsMo)

  // Add expense group rows by their keys
  function indexStructureRows(rows: PnlRow[]) {
    for (const r of rows) {
      if (r.key && r.key !== r.id) ctx.set(r.key, r.months)
      if (r.children.length) indexStructureRows(r.children)
    }
  }
  indexStructureRows(structure)

  if (structure.length && categoryDisplay.size) {
    applyCategoryDisplayNames(structure, categoryDisplay)
  }

  // ── 11. Build credit_taxes group (formula / category / manual children) ───
  const creditTaxesRow = buildCreditTaxesGroup(dbRows, ctx, settings, months, catAggr)
  if (categoryDisplay.size) applyCategoryDisplayNames([creditTaxesRow], categoryDisplay)
  ctx.set('credit_taxes', creditTaxesRow.months)
  structure.push(creditTaxesRow)

  // ── 12. Build flat category list (grand totals) ───────────────────────────
  const seenCats = [...catAggr.keys()].sort((a, b) => {
    if (a === NO_CATEGORY) return 1
    if (b === NO_CATEGORY) return -1
    const ai = categoryOrder.get(a) ?? 99999
    const bi = categoryOrder.get(b) ?? 99999
    return ai !== bi ? ai - bi : a.localeCompare(b, 'ru')
  })

  const grandTotalByMonth: Record<string, number> = {}
  let grandTotal = 0

  const categories: CategorySummary[] = seenCats.map((cat) => {
    const catMap    = catAggr.get(cat)!
    const monthsRec: Record<string, number> = {}
    let catTotal = 0

    for (const { key } of months) {
      const amt = catMap.get(key) ?? 0
      monthsRec[key]          = amt
      catTotal               += amt
      grandTotalByMonth[key]  = (grandTotalByMonth[key] ?? 0) + amt
      grandTotal             += amt
    }

    return {
      category:    cat,
      displayName: categoryDisplay.get(cat) ?? cat,
      months:      monthsRec,
      total:       catTotal,
    }
  })

  for (const { key } of months) grandTotalByMonth[key] ??= 0

  // ── 13. Build pnlRows (root-level rows in sort order) ────────────────────
  const rootDbRows = dbRows
    .filter((r) => r.parent_id === null)
    .sort((a, b) => a.sort_order - b.sort_order)

  const structureById = new Map<string, PnlRow>()
  function indexById(rows: PnlRow[]) {
    for (const r of rows) {
      structureById.set(r.id, r)
      if (r.children.length) indexById(r.children)
    }
  }
  indexById(structure)

  const pnlRows: PnlRow[] = []

  for (const dbRow of rootDbRows) {
    if (dbRow.type === 'manual') {
      const metricKey = dbRow.key ?? dbRow.category ?? ''
      const monthsRec = ctx.get(metricKey) ?? Object.fromEntries(months.map((m) => [m.key, 0]))
      const total = months.reduce((s, m) => s + (monthsRec[m.key] ?? 0), 0)
      pnlRows.push({
        id: dbRow.id, key: dbRow.key ?? dbRow.id, name: dbRow.name,
        type: 'manual', level: 0, parent_id: null, category: dbRow.category,
        months: { ...monthsRec }, total, percents: {}, totalPercent: null, children: [],
      })

    } else if (dbRow.type === 'group' || dbRow.type === 'category') {
      const structRow = structureById.get(dbRow.id)
      if (structRow) {
        pnlRows.push({ ...structRow, key: dbRow.key ?? dbRow.id })
      } else {
        const monthsRec = Object.fromEntries(months.map((m) => [m.key, 0]))
        pnlRows.push({
          id: dbRow.id, key: dbRow.key ?? dbRow.id, name: dbRow.name,
          type: dbRow.type as 'group' | 'category', level: 0,
          parent_id: null, category: dbRow.category,
          months: monthsRec, total: 0, percents: {}, totalPercent: null, children: [],
        })
      }

    } else if (dbRow.type === 'formula') {
      let formulaDef: Record<string, unknown> | null = null
      try { formulaDef = JSON.parse(dbRow.formula ?? '') } catch { /* */ }

      const monthsRec = formulaDef
        ? evalFormula(formulaDef, ctx, settings, months)
        : Object.fromEntries(months.map((m) => [m.key, 0]))

      const total = months.reduce((s, m) => s + (monthsRec[m.key] ?? 0), 0)

      pnlRows.push({
        id: dbRow.id, key: dbRow.key ?? dbRow.id, name: dbRow.name,
        type: 'formula', level: 0, parent_id: null, category: null,
        formula: formulaDef ?? undefined,
        months: monthsRec, total, percents: {}, totalPercent: null, children: [],
      })

      if (dbRow.key) ctx.set(dbRow.key, monthsRec)
    }
  }

  // ── 14. Annotate percents on all rows ─────────────────────────────────────
  const totalRevenue     = months.reduce((s, m) => s + (revenueMonths[m.key]     ?? 0), 0)
  const totalGrossMargin = months.reduce((s, m) => s + (grossMarginMonths[m.key] ?? 0), 0)

  for (const row of pnlRows)   annotatePercents(row, revenueMonths, grossMarginMonths, totalRevenue, totalGrossMargin)
  for (const row of structure) annotatePercents(row, revenueMonths, grossMarginMonths, totalRevenue, totalGrossMargin)

  const response: SummaryResponse = {
    year: responseYear,
    allTime,
    months,
    pnlRows,
    structure,
    categories,
    grandTotalByMonth,
    grandTotal,
    settings,
    categoryNorms,
    rowNorms,
  }
  return NextResponse.json(response)
}
