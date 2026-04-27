'use client'

import {
  useState, useEffect, useCallback, useRef, useMemo,
  Children, cloneElement, isValidElement,
  type CSSProperties, type ReactElement, type ReactNode,
} from 'react'
import Link from 'next/link'
import type { Expense } from '@/lib/expenses/types'
import type {
  SummaryResponse, MonthInfo, PnlRow, CategorySummary,
} from '@/app/api/pnl/expenses-summary/route'
import {
  maxRatioMonth,
  maxRatioTotal,
  normLevelColorStyle,
  normLevelFromRatio,
} from '@/lib/pnl/category-norm-heat'
import { netProfitPctStyle, profitPctStyle } from '@/lib/pnl/row-norm'
import { buildLiveValueMap, liveValFromMap } from '@/lib/pnl/live-value-map'
import {
  EXPENSE_PCT_TREND_STORAGE_KEY,
  parseExpensePctTrendMode,
  resolveCompareMonthKey,
  expenseTrendGoodForExpense,
  type ExpensePctTrendMode,
} from '@/lib/pnl/expense-pct-trend'

// ── Types ─────────────────────────────────────────────────────────────────────

type Selection = { categories: string[] | null; month: string | null }

type DrilldownState = {
  rows: Expense[]; totalAmount: number; count: number
  loading: boolean; label: string; selection: Selection
}

type MultiplySettingFml = { op: 'multiply_setting'; sum_refs: string[]; setting_key: string }

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtCell(n: number): string {
  if (n === 0) return ''
  return n.toLocaleString('ru-RU', { minimumFractionDigits: 0, maximumFractionDigits: 0 })
}

function calcPct(amount: number, denominator: number): number | null {
  if (!denominator) return null
  return (amount / denominator) * 100
}

function fmtPct(p: number | null): string {
  if (p === null) return ''
  if (Math.abs(p) < 0.05) return ''
  return p.toLocaleString('ru-RU', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + '%'
}

function fmtAmount(n: number): string {
  return n.toLocaleString('ru-RU', { style: 'currency', currency: 'RUB', maximumFractionDigits: 0 })
}

function fmtDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString('ru-RU', {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow',
    })
  } catch { return iso }
}

/** Returns display name for a row, appending setting value in parentheses for formula rows */
function rowDisplayName(row: PnlRow, settings: Record<string, number>): string {
  if (row.type === 'formula' && row.formula) {
    const f = row.formula as Partial<MultiplySettingFml>
    if (f.setting_key !== undefined && settings[f.setting_key] !== undefined) {
      const v   = settings[f.setting_key]
      const pct = (v * 100).toLocaleString('ru-RU', {
        minimumFractionDigits: 0,
        maximumFractionDigits: 2,
      })
      return `${row.name} (${pct}%)`
    }
  }
  return row.name
}

function buildLabel(
  summary: SummaryResponse | null,
  categories: string[] | null,
  month: string | null,
  titleOverride?: string | null,
) {
  let catLabel: string
  if (!categories || categories.length === 0) {
    catLabel = 'Все расходы'
  } else if (titleOverride) {
    catLabel = titleOverride
  } else if (categories.length === 1) {
    const c0 = categories[0]!
    catLabel = summary?.categories.find((c) => c.category === c0)?.displayName ?? c0
  } else {
    catLabel = `${categories.length} категорий`
  }
  if (month && summary) {
    const mi = summary.months.find((m) => m.key === month)
    return `${catLabel} — ${mi?.label ?? month}`
  }
  const period =
    summary?.allTime ? 'всё время' : `${summary?.year ?? ''} (весь год)`
  return categories && categories.length > 0
    ? `${catLabel} — ${period}`
    : `Все расходы — ${summary?.allTime ? 'всё время' : String(summary?.year ?? '')}`
}

/** Sorted join for matching drilldown selection to a category set (e.g. group vs row). */
function categoriesSelKey(cats: string[] | null | undefined): string | null {
  if (!cats || cats.length === 0) return null
  return [...cats].sort().join('\u0001')
}

/** All expense category names under a structure node (leaf `type === 'category'`). */
function collectCategoryLeaves(row: PnlRow): string[] {
  const out: string[] = []
  function walk(n: PnlRow) {
    if (n.type === 'category' && n.category) out.push(n.category)
    for (const ch of n.children) walk(ch)
  }
  for (const ch of row.children) walk(ch)
  return out
}

function monthEndDate(mk: string) {
  const [y, m] = mk.split('-').map(Number)
  const d = new Date(Date.UTC(y, m, 0))
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
}

function buildExpensesLink(sel: Selection, summary: SummaryResponse | null, yearFallback: number) {
  const sp = new URLSearchParams()
  const cats = sel.categories
  if (cats?.length === 1) sp.set('category', cats[0]!)
  else if (cats && cats.length > 1) for (const c of cats) sp.append('categories', c)
  if (sel.month) {
    sp.set('dateFrom', `${sel.month}-01`)
    sp.set('dateTo', monthEndDate(sel.month))
  } else if (summary?.allTime && summary.months.length > 0) {
    const first = summary.months[0]!.key
    const last  = summary.months[summary.months.length - 1]!.key
    sp.set('dateFrom', `${first}-01`)
    sp.set('dateTo', monthEndDate(last))
  } else {
    const y = summary?.year ?? yearFallback
    sp.set('dateFrom', `${y}-01-01`)
    sp.set('dateTo', `${y}-12-31`)
  }
  return `/expenses?${sp.toString()}`
}

function flattenTree(nodes: PnlRow[], collapsed: Set<string>): PnlRow[] {
  const result: PnlRow[] = []
  function visit(node: PnlRow) {
    result.push(node)
    if (node.type === 'group' && !collapsed.has(node.id) && node.children.length > 0) {
      for (const child of node.children) visit(child)
    }
  }
  for (const node of nodes) visit(node)
  return result
}

// Keys that don't show percents in the P&L top block
const NO_PERCENT_KEYS = new Set(['revenue', 'cogs'])

// ── Page ──────────────────────────────────────────────────────────────────────

const CURRENT_YEAR = new Date().getFullYear()
const YEAR_OPTIONS = Array.from({ length: 5 }, (_, i) => CURRENT_YEAR - i)

export default function PnlPage() {
  const [year, setYear]                     = useState<number | 'all'>(CURRENT_YEAR)
  const [summary, setSummary]               = useState<SummaryResponse | null>(null)
  const [summaryLoading, setSummaryLoading] = useState(false)
  const [summaryError, setSummaryError]     = useState<string | null>(null)
  const [drilldown, setDrilldown]           = useState<DrilldownState | null>(null)
  const [revenueByMonth, setRevenue]        = useState<Record<string, number>>({})
  const [grossMarginByMonth, setGrossMargin]= useState<Record<string, number>>({})
  const [collapsed, setCollapsed]           = useState<Set<string>>(new Set())
  const [expenseTrendMode, setExpenseTrendMode] = useState<ExpensePctTrendMode>(() =>
    typeof window !== 'undefined'
      ? parseExpensePctTrendMode(localStorage.getItem(EXPENSE_PCT_TREND_STORAGE_KEY))
      : 'mom',
  )
  const [trendSummary, setTrendSummary]         = useState<SummaryResponse | null>(null)
  const [trendRevenueByMonth, setTrendRevenue]  = useState<Record<string, number>>({})
  const [trendGrossMarginByMonth, setTrendGm]    = useState<Record<string, number>>({})

  useEffect(() => {
    localStorage.setItem(EXPENSE_PCT_TREND_STORAGE_KEY, expenseTrendMode)
  }, [expenseTrendMode])

  // ── Load summary (+ прошлый год для тренда %% расходов) ─────────────────────
  useEffect(() => {
    setSummaryLoading(true); setSummaryError(null); setSummary(null); setDrilldown(null)
    setTrendSummary(null); setTrendRevenue({}); setTrendGm({})

    const runAllTime = () =>
      fetch('/api/pnl/expenses-summary?allTime=1')
        .then((r) => r.json())
        .then((d) => ({ main: d as SummaryResponse & { error?: string }, prev: null as SummaryResponse | null }))

    const runYear = (y: number) =>
      Promise.all([
        fetch(`/api/pnl/expenses-summary?year=${y}`).then((r) => r.json()),
        fetch(`/api/pnl/expenses-summary?year=${y - 1}`)
          .then((r) => r.json())
          .catch(() => ({ error: 'fetch_failed' })),
      ]).then(([main, prev]) => ({
        main: main as SummaryResponse & { error?: string },
        prev: prev && typeof prev === 'object' && 'error' in prev && prev.error ? null : (prev as SummaryResponse),
      }))

    const p = year === 'all' ? runAllTime() : runYear(year)

    p.then(({ main, prev }) => {
      if (main.error) {
        setSummaryError(main.error)
        return
      }
      setSummary(main)
      const revRow = main.pnlRows.find((r) => r.key === 'revenue')
      if (revRow) setRevenue({ ...revRow.months })
      const gmRow = main.pnlRows.find((r) => r.key === 'gross_margin')
      if (gmRow) setGrossMargin({ ...gmRow.months })

      if (prev) {
        setTrendSummary(prev)
        const tr = prev.pnlRows.find((r) => r.key === 'revenue')
        if (tr) setTrendRevenue({ ...tr.months })
        const tg = prev.pnlRows.find((r) => r.key === 'gross_margin')
        if (tg) setTrendGm({ ...tg.months })
      }
    })
      .catch((e) => setSummaryError(e.message))
      .finally(() => setSummaryLoading(false))
  }, [year])

  const saveManual = useCallback(async (metric: string, mk: string, value: number) => {
    const [y, m] = mk.split('-').map(Number)
    const rounded = Math.round(value * 100) / 100
    if (metric === 'revenue')      setRevenue(prev => ({ ...prev, [mk]: rounded }))
    if (metric === 'gross_margin') setGrossMargin(prev => ({ ...prev, [mk]: rounded }))
    await fetch('/api/pnl/monthly-values', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ year: y, month: m, metric, amount: rounded }),
    }).catch(() => {})
  }, [])

  const loadDrilldown = useCallback((
    categories: string[] | null,
    month: string | null,
    sum: SummaryResponse | null,
    titleOverride?: string | null,
  ) => {
    const label = buildLabel(sum, categories, month, titleOverride)
    const selection: Selection = { categories, month }
    setDrilldown({ rows: [], totalAmount: 0, count: 0, loading: true, label, selection })
    const sp = new URLSearchParams()
    if (sum?.allTime) sp.set('allTime', '1')
    else sp.set('year', String(sum?.year ?? (typeof year === 'number' ? year : CURRENT_YEAR)))
    if (month) sp.set('month', month)
    if (categories?.length === 1) sp.set('category', categories[0]!)
    else if (categories && categories.length > 1) for (const c of categories) sp.append('category', c)
    fetch(`/api/pnl/expenses-drilldown?${sp}`)
      .then((r) => r.json())
      .then((d) => {
        if (d.error) { setDrilldown((p) => p ? { ...p, loading: false } : null); return }
        setDrilldown({ rows: d.rows, totalAmount: d.totalAmount, count: d.count, loading: false, label, selection })
      })
      .catch(() => setDrilldown((p) => p ? { ...p, loading: false } : null))
  }, [year])

  function toggleCollapse(id: string) {
    setCollapsed((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  return (
    <div className="flex flex-col font-sans" style={{ height: 'calc(100vh - var(--nav-h))', background: 'var(--bg-primary)' }}>
      {/* ── Toolbar ── */}
      <div
        className="shrink-0 flex items-center gap-3 px-5 py-2.5"
        style={{ background: 'var(--bg-card)', borderBottom: '1px solid var(--border-primary)' }}
      >
        <select
          value={year === 'all' ? 'all' : year}
          onChange={(e) => {
            const v = e.target.value
            setYear(v === 'all' ? 'all' : Number(v))
          }}
          className="rounded-lg px-3 py-1.5 text-sm outline-none"
          style={{ background: 'var(--input-bg)', border: '1px solid var(--input-border)', color: 'var(--input-text)' }}
        >
          {YEAR_OPTIONS.map((y) => (
            <option key={y} value={y}>{y}</option>
          ))}
          <option value="all">Всё время</option>
        </select>
        <select
          value={expenseTrendMode}
          onChange={(e) => setExpenseTrendMode(e.target.value === 'yoy' ? 'yoy' : 'mom')}
          className="rounded-lg px-3 py-1.5 text-sm outline-none"
          style={{ background: 'var(--input-bg)', border: '1px solid var(--input-border)', color: 'var(--input-text)' }}
          title="Как сравнивать долю расходов в марже для подсказки тренда у %%"
        >
          <option value="mom">Тренд %%: к пред. месяцу</option>
          <option value="yoy">Тренд %%: год к году</option>
        </select>
      </div>

      {/* ── Body ── */}
      <div className="flex-1 flex overflow-hidden">
        <div className="flex-1 overflow-auto">
          {summaryLoading && (
            <div className="flex items-center justify-center h-full text-sm" style={{ color: 'var(--text-muted)' }}>
              Загрузка…
            </div>
          )}
          {summaryError && (
            <div className="m-6 rounded-xl px-5 py-4 text-sm"
              style={{ background: 'var(--danger-bg)', border: '1px solid var(--danger-border)', color: 'var(--danger)' }}>
              {summaryError}
            </div>
          )}
          {summary && (
            <PnlTable
              summary={summary}
              revenueByMonth={revenueByMonth}
              grossMarginByMonth={grossMarginByMonth}
              expenseTrendMode={expenseTrendMode}
              trendSummary={trendSummary}
              trendRevenueByMonth={trendRevenueByMonth}
              trendGrossMarginByMonth={trendGrossMarginByMonth}
              drilldown={drilldown}
              collapsed={collapsed}
              onManualSave={saveManual}
              onOpenDrilldown={(cats, mon, title) => loadDrilldown(cats, mon, summary, title ?? null)}
              onToggleCollapse={toggleCollapse}
            />
          )}
        </div>

        {drilldown !== null && (
          <DrilldownPanel
            drilldown={drilldown}
            summary={summary}
            yearFallback={typeof year === 'number' ? year : CURRENT_YEAR}
            onClose={() => setDrilldown(null)}
          />
        )}
      </div>
    </div>
  )
}

// ── PnlTable ──────────────────────────────────────────────────────────────────

function PnlTable({
  summary, revenueByMonth, grossMarginByMonth,
  expenseTrendMode, trendSummary, trendRevenueByMonth, trendGrossMarginByMonth,
  drilldown, collapsed,
  onManualSave, onOpenDrilldown, onToggleCollapse,
}: {
  summary:                  SummaryResponse
  revenueByMonth:         Record<string, number>
  grossMarginByMonth:     Record<string, number>
  expenseTrendMode:       ExpensePctTrendMode
  trendSummary:           SummaryResponse | null
  trendRevenueByMonth:    Record<string, number>
  trendGrossMarginByMonth: Record<string, number>
  drilldown:              DrilldownState | null
  collapsed:              Set<string>
  onManualSave:           (metric: string, mk: string, v: number) => void
  onOpenDrilldown:        (categories: string[] | null, month: string | null, title?: string | null) => void
  onToggleCollapse:       (id: string) => void
}) {
  const sel      = drilldown?.selection ?? null
  const selCatKey = categoriesSelKey(sel?.categories ?? null)
  const settings = summary.settings
  const categoryNorms = summary.categoryNorms ?? {}
  const rowNorms      = summary.rowNorms ?? {}
  const monthCount    = summary.months.length

  function pctBaseStyle(cellSelected: boolean): CSSProperties {
    return {
      fontWeight: 400,
      color: cellSelected ? 'inherit' : 'var(--text-muted)',
    }
  }

  /** Подсветка только колонки %%: сравнение max(факт/норма) по %% и сумме. */
  function normPctStyleCategoryMonth(categoryKey: string, monthAmt: number, monthPct: number | null) {
    const n = categoryNorms[categoryKey]
    if (!n || (n.normPercent == null && n.normAmount == null)) return undefined
    const maxR = maxRatioMonth(monthPct, monthAmt, n.normPercent, n.normAmount)
    const level = normLevelFromRatio(maxR, n.attentionOfNormPct, n.criticalOfNormPct)
    return normLevelColorStyle(level)
  }

  function normPctStyleCategoryTotal(categoryKey: string, totalAmt: number, totalPct: number | null) {
    const n = categoryNorms[categoryKey]
    if (!n || (n.normPercent == null && n.normAmount == null)) return undefined
    const maxR = maxRatioTotal(totalPct, totalAmt, n.normPercent, n.normAmount, monthCount)
    const level = normLevelFromRatio(maxR, n.attentionOfNormPct, n.criticalOfNormPct)
    return normLevelColorStyle(level)
  }

  const orderedMonthKeys = useMemo(() => summary.months.map((m) => m.key), [summary.months])

  const lv = useMemo(
    () => buildLiveValueMap(summary, revenueByMonth, grossMarginByMonth),
    [summary, revenueByMonth, grossMarginByMonth],
  )

  const lvTrend = useMemo(() => {
    if (summary.allTime || !trendSummary) return null
    return buildLiveValueMap(trendSummary, trendRevenueByMonth, trendGrossMarginByMonth)
  }, [summary.allTime, trendSummary, trendRevenueByMonth, trendGrossMarginByMonth])

  const trendCatMonthsByName = useMemo(() => {
    const m = new Map<string, Record<string, number>>()
    if (!trendSummary) return m
    for (const c of trendSummary.categories) m.set(c.category, c.months)
    return m
  }, [trendSummary])

  function expenseTrendForRow(row: PnlRow, currentMk: string, currentPct: number | null): {
    deltaPP: number | null
    title: string
  } {
    const compareKey = resolveCompareMonthKey(
      currentMk,
      expenseTrendMode,
      summary.allTime,
      orderedMonthKeys,
    )
    if (compareKey == null || currentPct == null || !Number.isFinite(currentPct)) {
      return { deltaPP: null, title: '' }
    }
    const prevAmt = liveValFromMap(row, compareKey, lv, lvTrend)
    const prevGm =
      grossMarginByMonth[compareKey] ?? trendGrossMarginByMonth[compareKey] ?? 0
    if (prevGm === 0) return { deltaPP: null, title: '' }
    const prevPct = (prevAmt / prevGm) * 100
    const deltaPP = currentPct - prevPct
    const basis = expenseTrendMode === 'yoy' ? 'Год к году' : 'К пред. месяцу'
    const title = `${basis}: ${deltaPP >= 0 ? '+' : ''}${deltaPP.toLocaleString('ru-RU', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} п.п. к доле в марже`
    return { deltaPP, title }
  }

  function expenseTrendForCategory(cat: CategorySummary, currentMk: string, currentPct: number | null): {
    deltaPP: number | null
    title: string
  } {
    const compareKey = resolveCompareMonthKey(
      currentMk,
      expenseTrendMode,
      summary.allTime,
      orderedMonthKeys,
    )
    if (compareKey == null || currentPct == null || !Number.isFinite(currentPct)) {
      return { deltaPP: null, title: '' }
    }
    const prevAmt =
      cat.months[compareKey] ?? trendCatMonthsByName.get(cat.category)?.[compareKey] ?? 0
    const prevGm =
      grossMarginByMonth[compareKey] ?? trendGrossMarginByMonth[compareKey] ?? 0
    if (prevGm === 0) return { deltaPP: null, title: '' }
    const prevPct = (prevAmt / prevGm) * 100
    const deltaPP = currentPct - prevPct
    const basis = expenseTrendMode === 'yoy' ? 'Год к году' : 'К пред. месяцу'
    const title = `${basis}: ${deltaPP >= 0 ? '+' : ''}${deltaPP.toLocaleString('ru-RU', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} п.п. к доле в марже`
    return { deltaPP, title }
  }

  // Live value helpers
  function liveVal(row: PnlRow, mk: string): number {
    const key = row.key && row.key !== row.id ? row.key : row.id
    return lv.get(key)?.[mk] ?? row.months[mk] ?? 0
  }

  function liveTotal(row: PnlRow): number {
    return summary.months.reduce((s, m) => s + liveVal(row, m.key), 0)
  }

  // ── Annual totals ──────────────────────────────────────────────────────────
  const totalRevenue     = summary.months.reduce((s, m) => s + (revenueByMonth[m.key]     ?? 0), 0)
  const totalGrossMargin = summary.months.reduce((s, m) => s + (grossMarginByMonth[m.key] ?? 0), 0)

  // ── Percent helpers (live) ─────────────────────────────────────────────────
  function monthPct(amount: number, mk: string, rowKey: string): number | null {
    if (NO_PERCENT_KEYS.has(rowKey)) return null
    if (rowKey === 'gross_margin') return calcPct(amount, revenueByMonth[mk] ?? 0)
    return calcPct(amount, grossMarginByMonth[mk] ?? 0)
  }

  function annualPct(total: number, rowKey: string): number | null {
    if (NO_PERCENT_KEYS.has(rowKey)) return null
    if (rowKey === 'gross_margin') return calcPct(total, totalRevenue)
    return calcPct(total, totalGrossMargin)
  }

  // ── Top-level P&L rows ────────────────────────────────────────────────────
  const topRows = summary.pnlRows.filter((r) => r.level === 0 && r.parent_id === null)

  // ── Expense structure ─────────────────────────────────────────────────────
  const flatRows = flattenTree(summary.structure, collapsed)

  const structuredCategories = new Set<string>()
  function collectCats(nodes: PnlRow[]) {
    for (const n of nodes) {
      if (n.type === 'category' && n.category) structuredCategories.add(n.category)
      if (n.children.length) collectCats(n.children)
    }
  }
  collectCats(summary.structure)
  const unstructured = summary.categories.filter(
    (c) => !structuredCategories.has(c.category) && c.category !== 'Без категории' && c.total > 0,
  )
  const noCategory = summary.categories.find((c) => c.category === 'Без категории' && c.total > 0)

  const COL = summary.months.length

  return (
    <table
      className={
        'border-collapse text-sm [&_td]:align-middle [&_th]:align-middle ' +
        '[&_td]:border-x-0 [&_td]:border-y [&_td]:border-solid [&_td]:border-[var(--table-border)] ' +
        '[&_th]:border-x-0 [&_th]:border-y [&_th]:border-solid [&_th]:border-[var(--table-border)]'
      }
      style={{ minWidth: 'max-content' }}
    >
      <thead>
        <tr>
          <Th corner>Показатель</Th>
          {summary.months.map((m) => <Th key={m.key}>{m.label}</Th>)}
          <Th total>Итого</Th>
        </tr>
      </thead>

      <tbody>
        {/* ── P&L строки ──────────────────────────────────────────────────── */}
        <SectionHeaderRow colSpan={COL + 2} label="P&L" />

        {topRows.map((row) => {
          const rowKey      = row.key
          const isManual    = row.type === 'manual'
          const isFormula   = row.type === 'formula'
          const isGroup     = row.type === 'group'
          const isRevenue   = rowKey === 'revenue'
          const isGM        = rowKey === 'gross_margin'
          const isCogs      = rowKey === 'cogs'
          const isNetProfit = rowKey === 'net_profit'
          // Only commercial and indirect are clickable expense rows (credit_taxes is formula-based)
          const isExpenses  = isGroup && (rowKey === 'commercial_expenses' || rowKey === 'indirect_expenses')

          const rowTotal = liveTotal(row)

          let labelColor: string
          let labelWeight: number
          const rowBg: string | undefined = undefined
          if (isRevenue || isGM || isNetProfit) {
            labelColor = 'var(--text-primary)'
            labelWeight = 700
          } else if (isCogs) {
            labelColor = 'var(--text-muted)'
            labelWeight = 400
          } else if (isFormula) {
            labelColor = 'var(--text-primary)'
            labelWeight = 600
          } else {
            labelColor = 'var(--text-secondary)'
            labelWeight = 400
          }

          const isSubtotal = rowKey === 'expenses_in_1c' || rowKey === 'expenses_all'
          const displayName = rowDisplayName(row, settings)

          return (
            <tr
              key={row.id}
              style={{ borderBottom: '1px solid var(--table-border)', background: rowBg }}
            >
              {/* Label */}
              <td
                className="sticky left-0 z-10 px-4 py-2 text-xs whitespace-nowrap min-w-[220px]"
                style={{
                  background: rowBg ?? 'var(--table-bg)',
                  color: labelColor, fontWeight: labelWeight,
                }}
              >
                {displayName}
              </td>

              {/* Month cells */}
              {summary.months.map((m) => {
                const val    = liveVal(row, m.key)
                const pct    = isSubtotal ? null : monthPct(val, m.key, rowKey)
                const pctStr = fmtPct(pct)

                if (isManual) {
                  const gmNorm = rowKey === 'gross_margin' ? rowNorms.gross_margin : undefined
                  const pctColStyle: CSSProperties = {
                    color: 'var(--text-muted)',
                    ...profitPctStyle(pct, gmNorm?.normPercent ?? null, gmNorm),
                  }
                  return (
                    <td key={m.key} className="px-0 py-1.5 text-right text-xs tabular-nums">
                      <CellStack
                        pctStr={pctStr || undefined}
                        pctStyle={pctColStyle}
                      >
                        <EditableValue
                          monthKey={m.key}
                          value={val}
                          onSave={(mk, v) => onManualSave(rowKey, mk, v)}
                        />
                      </CellStack>
                    </td>
                  )
                }

                if (isExpenses) {
                  const isExpSel = selCatKey === null && sel?.month === m.key
                  return (
                    <td
                      key={m.key}
                      onClick={() => val > 0 && onOpenDrilldown(null, m.key)}
                      className="px-0 py-1.5 text-right text-xs tabular-nums transition-colors"
                      style={isExpSel
                        ? { background: 'var(--bg-tertiary)', color: 'var(--text-primary)', cursor: 'pointer' }
                        : val > 0 ? { color: 'var(--text-primary)', cursor: 'pointer' } : { color: 'var(--border-secondary)' }
                      }
                      onMouseEnter={(e) => { if (!isExpSel && val > 0) (e.currentTarget as HTMLElement).style.background = 'var(--bg-secondary)' }}
                      onMouseLeave={(e) => { if (!isExpSel) (e.currentTarget as HTMLElement).style.background = '' }}
                    >
                      <CellStack
                        pctStr={pctStr || undefined}
                        pctStyle={{ color: isExpSel ? 'inherit' : 'var(--text-muted)' }}
                      >
                        <span className="font-semibold">{fmtCell(val)}</span>
                      </CellStack>
                    </td>
                  )
                }

                // Чистая прибыль: две строки %% — от маржи и от выручки
                if (isNetProfit) {
                  const npNorm     = rowNorms.net_profit
                  const pctVsGm    = calcPct(val, grossMarginByMonth[m.key] ?? 0)
                  const pctVsRev   = calcPct(val, revenueByMonth[m.key] ?? 0)
                  const pctStrGm   = fmtPct(pctVsGm)
                  const pctStrRev  = fmtPct(pctVsRev)
                  const amtColor =
                    val > 0 || val < 0 ? 'var(--text-primary)' : 'var(--border-secondary)'
                  const baseMuted: CSSProperties = { color: 'var(--text-muted)' }
                  return (
                    <td key={m.key} className="px-0 py-1.5 text-right text-xs tabular-nums">
                      <CellStack
                        pctStr={pctStrGm || undefined}
                        pctStyle={{
                          ...baseMuted,
                          ...netProfitPctStyle(pctVsGm, npNorm?.normPercent ?? null, npNorm),
                        }}
                        pct2Str={pctStrRev || undefined}
                        pct2Style={{
                          ...baseMuted,
                          ...netProfitPctStyle(pctVsRev, npNorm?.normPercentOfRevenue ?? null, npNorm),
                        }}
                      >
                        <span style={{ color: amtColor, fontWeight: 600 }}>
                          {fmtCell(val)}
                        </span>
                      </CellStack>
                    </td>
                  )
                }

                // Group (credit_taxes) + прочие formula rows
                const amtColor =
                  val > 0 || val < 0 ? 'var(--text-primary)' : 'var(--border-secondary)'

                return (
                  <td key={m.key} className="px-0 py-1.5 text-right text-xs tabular-nums">
                    <CellStack
                      pctStr={pctStr || undefined}
                      pctStyle={{ color: 'var(--text-muted)' }}
                    >
                      <span style={{ color: amtColor, fontWeight: isFormula ? 600 : 400 }}>
                        {fmtCell(val)}
                      </span>
                    </CellStack>
                  </td>
                )
              })}

              {/* Annual total */}
              {(() => {
                const tPct    = isSubtotal ? null : annualPct(rowTotal, rowKey)
                const tPctStr = fmtPct(tPct)
                const tColor =
                  rowTotal > 0 || rowTotal < 0 ? 'var(--text-primary)' : 'var(--border-secondary)'
                const baseAnnualPct: CSSProperties = { color: 'var(--text-muted)', fontWeight: 400 }

                if (rowKey === 'gross_margin') {
                  const gmNorm = rowNorms.gross_margin
                  return (
                    <td
                      className={TOTAL_COL_TD_CLASS}
                      style={{ ...TOTAL_COL_STICKY_TD, color: tColor, fontWeight: labelWeight }}
                    >
                      <CellStack
                        pctStr={tPctStr || undefined}
                        pctStyle={{
                          ...baseAnnualPct,
                          ...profitPctStyle(tPct, gmNorm?.normPercent ?? null, gmNorm),
                        }}
                      >
                        <span>{fmtCell(rowTotal)}</span>
                      </CellStack>
                    </td>
                  )
                }

                if (rowKey === 'net_profit') {
                  const npNorm   = rowNorms.net_profit
                  const tPctVsGm = calcPct(rowTotal, totalGrossMargin)
                  const tPctVsRv = calcPct(rowTotal, totalRevenue)
                  return (
                    <td
                      className={TOTAL_COL_TD_CLASS}
                      style={{ ...TOTAL_COL_STICKY_TD, color: tColor, fontWeight: labelWeight }}
                    >
                      <CellStack
                        pctStr={fmtPct(tPctVsGm) || undefined}
                        pctStyle={{
                          ...baseAnnualPct,
                          ...netProfitPctStyle(tPctVsGm, npNorm?.normPercent ?? null, npNorm),
                        }}
                        pct2Str={fmtPct(tPctVsRv) || undefined}
                        pct2Style={{
                          ...baseAnnualPct,
                          ...netProfitPctStyle(tPctVsRv, npNorm?.normPercentOfRevenue ?? null, npNorm),
                        }}
                      >
                        <span>{fmtCell(rowTotal)}</span>
                      </CellStack>
                    </td>
                  )
                }

                return (
                  <td
                    className={TOTAL_COL_TD_CLASS}
                    style={{ ...TOTAL_COL_STICKY_TD, color: tColor, fontWeight: labelWeight }}
                  >
                    <CellStack
                      pctStr={tPctStr || undefined}
                      pctStyle={baseAnnualPct}
                    >
                      <span>{fmtCell(rowTotal)}</span>
                    </CellStack>
                  </td>
                )
              })()}
            </tr>
          )
        })}

        {/* ── Структура расходов ───────────────────────────────────────────── */}
        {flatRows.length > 0 && (
          <>
            <SectionHeaderRow colSpan={COL + 2} label="Структура расходов" />

            {flatRows.map((row) => {
              const isGroup       = row.type === 'group'
              const isCat         = row.type === 'category'
              const isFormulaLeaf = row.type === 'formula' && row.level > 0
              const isCollapsed   = collapsed.has(row.id)
              const groupLeaves   = isGroup ? collectCategoryLeaves(row) : []
              const groupKey      = groupLeaves.length ? categoriesSelKey(groupLeaves) : null
              const catSel        = isCat && row.category && selCatKey === categoriesSelKey([row.category]) && sel?.month === null
              const groupLabelSel = isGroup && groupKey !== null && selCatKey === groupKey && sel?.month === null
              const labelSelected = catSel || groupLabelSel
              const indent        = row.level * 18
              const displayName   = rowDisplayName(row, settings)
              const groupDrillable = isGroup && groupLeaves.length > 0

              // Determine live value for this row
              function rowLiveVal(mk: string): number {
                if (isFormulaLeaf) {
                  const key = row.key !== row.id ? row.key : row.id
                  return lv.get(key)?.[mk] ?? row.months[mk] ?? 0
                }
                return liveVal(row, mk)
              }

              const rowLiveTotal = summary.months.reduce((s, m) => s + rowLiveVal(m.key), 0)

              return (
                <tr
                  key={row.id}
                  style={{
                    borderBottom: '1px solid var(--table-border)',
                    background: isGroup ? 'var(--table-header-bg)' : undefined,
                  }}
                >
                  {/* Label cell */}
                  <td
                    className="sticky left-0 z-10 px-4 py-1.5 text-xs whitespace-nowrap transition-colors"
                    style={{
                      paddingLeft: `${indent + 16}px`,
                      fontWeight: isGroup ? 700 : 400,
                      background: labelSelected ? 'var(--bg-tertiary)' :
                                  isGroup ? 'var(--table-header-bg)' : 'var(--table-bg)',
                      color: labelSelected ? 'var(--text-primary)' :
                             isFormulaLeaf ? 'var(--text-muted)' : 'var(--text-secondary)',
                      cursor: groupDrillable || isCat ? 'pointer' : 'default',
                      minWidth: '220px',
                    }}
                    onClick={() => {
                      if (groupDrillable) onOpenDrilldown(groupLeaves, null, row.name)
                      else if (isCat && row.category) onOpenDrilldown([row.category], null)
                    }}
                    onMouseEnter={(e) => {
                      if (!labelSelected && (groupDrillable || isCat)) {
                        const el = e.currentTarget as HTMLElement
                        el.style.background = isGroup ? 'var(--bg-tertiary)' : 'var(--bg-secondary)'
                      }
                    }}
                    onMouseLeave={(e) => {
                      if (!labelSelected) {
                        const el = e.currentTarget as HTMLElement
                        el.style.background = isGroup ? 'var(--table-header-bg)' : 'var(--table-bg)'
                        el.style.color =
                          isFormulaLeaf ? 'var(--text-muted)' : 'var(--text-secondary)'
                      }
                    }}
                  >
                    <span className="flex items-center gap-1.5">
                      {isGroup && (
                        <span
                          role="button"
                          tabIndex={0}
                          className="text-[10px] select-none"
                          style={{ color: 'var(--text-muted)', width: 14, display: 'inline-block', flexShrink: 0, cursor: 'pointer' }}
                          onClick={(e) => { e.stopPropagation(); onToggleCollapse(row.id) }}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault()
                              e.stopPropagation()
                              onToggleCollapse(row.id)
                            }
                          }}
                        >
                          {isCollapsed ? '▶' : '▼'}
                        </span>
                      )}
                      {!isGroup && <span style={{ width: 14, display: 'inline-block', flexShrink: 0 }} />}
                      {displayName}
                    </span>
                  </td>

                  {/* Month cells */}
                  {summary.months.map((m) => {
                    const amt       = rowLiveVal(m.key)
                    const rawMonthPct = calcPct(amt, grossMarginByMonth[m.key] ?? 0)
                    const pctStr    = fmtPct(rawMonthPct)
                    const cellSel =
                      isCat && row.category && selCatKey === categoriesSelKey([row.category]) && sel?.month === m.key
                    const groupMonthSel = isGroup && groupKey !== null && selCatKey === groupKey && sel?.month === m.key
                    const cellSelected  = cellSel || groupMonthSel
                    const normPctStyle = isCat && row.category
                      ? normPctStyleCategoryMonth(row.category, amt, rawMonthPct)
                      : undefined
                    const expTrend = expenseTrendForRow(row, m.key, rawMonthPct)

                    return (
                      <td
                        key={m.key}
                        onClick={() => {
                          if (isCat && row.category && amt > 0) onOpenDrilldown([row.category], m.key)
                          if (groupDrillable && amt > 0) onOpenDrilldown(groupLeaves, m.key, row.name)
                        }}
                        className="px-0 py-1.5 text-right text-xs tabular-nums transition-colors"
                        style={cellSelected
                          ? { background: 'var(--bg-tertiary)', color: 'var(--text-primary)', fontWeight: 600, cursor: 'pointer' }
                          : amt > 0
                          ? { color: 'var(--text-primary)', cursor: isCat || groupDrillable ? 'pointer' : 'default', fontWeight: isGroup ? 600 : 400 }
                          : { color: 'var(--border-secondary)' }
                        }
                        onMouseEnter={(e) => {
                          if (!cellSelected && amt > 0 && (isCat || groupDrillable)) {
                            (e.currentTarget as HTMLElement).style.background = 'var(--bg-secondary)'
                          }
                        }}
                        onMouseLeave={(e) => { if (!cellSelected) (e.currentTarget as HTMLElement).style.background = '' }}
                      >
                        <CellStack
                          pctStr={pctStr || undefined}
                          pctStyle={{ ...pctBaseStyle(cellSelected), ...normPctStyle }}
                          trendDeltaPP={expTrend.deltaPP}
                          trendTitle={expTrend.title}
                        >
                          <span>{fmtCell(amt)}</span>
                        </CellStack>
                      </td>
                    )
                  })}

                  {/* Total cell */}
                  <td
                    onClick={() => {
                      if (isCat && row.category) onOpenDrilldown([row.category], null)
                      if (groupDrillable && rowLiveTotal > 0) onOpenDrilldown(groupLeaves, null, row.name)
                    }}
                    className={TOTAL_COL_TD_CLASS}
                    style={labelSelected
                      ? {
                          ...TOTAL_COL_STICKY_TD,
                          background: 'var(--bg-tertiary)',
                          color: 'var(--text-primary)',
                          cursor: 'pointer',
                          fontWeight: 600,
                        }
                      : {
                          ...TOTAL_COL_STICKY_TD,
                          color: 'var(--text-secondary)',
                          fontWeight: isGroup ? 700 : 400,
                          cursor: isCat || (groupDrillable && rowLiveTotal > 0) ? 'pointer' : 'default',
                        }
                    }
                    onMouseEnter={(e) => {
                      if (!labelSelected && (isCat || (groupDrillable && rowLiveTotal > 0))) {
                        (e.currentTarget as HTMLElement).style.background = 'var(--bg-secondary)'
                      }
                    }}
                    onMouseLeave={(e) => {
                      if (!labelSelected) {
                        (e.currentTarget as HTMLElement).style.background = 'var(--table-bg)'
                        ;(e.currentTarget as HTMLElement).style.color = isGroup ? 'var(--text-primary)' : 'var(--text-secondary)'
                      }
                    }}
                  >
                    {(() => {
                      const rawTotPct = calcPct(rowLiveTotal, totalGrossMargin)
                      const normPctStyleTot = isCat && row.category
                        ? normPctStyleCategoryTotal(row.category, rowLiveTotal, rawTotPct)
                        : undefined
                      return (
                        <CellStack
                          pctStr={fmtPct(rawTotPct) || undefined}
                          pctStyle={{ ...pctBaseStyle(labelSelected), ...normPctStyleTot }}
                        >
                          <span>{fmtCell(rowLiveTotal)}</span>
                        </CellStack>
                      )
                    })()}
                  </td>
                </tr>
              )
            })}
          </>
        )}

        {/* ── Unstructured categories ──────────────────────────────────────── */}
        {(unstructured.length > 0 || noCategory) && (
          <>
            <SectionHeaderRow colSpan={COL + 2} label="Прочие расходы (вне структуры)" />
            {[...unstructured, ...(noCategory ? [noCategory] : [])].map((cat) => (
              <tr key={cat.category} style={{ borderBottom: '1px solid var(--table-border)' }}>
                <td
                  className="sticky left-0 z-10 px-4 py-1.5 text-xs whitespace-nowrap cursor-pointer transition-colors"
                  style={{ background: 'var(--table-bg)', color: 'var(--text-secondary)', minWidth: '220px' }}
                  onClick={() => onOpenDrilldown([cat.category], null)}
                  onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'var(--bg-secondary)' }}
                  onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'var(--table-bg)' }}
                >
                  {cat.displayName}
                </td>
                {summary.months.map((m) => {
                  const amt     = cat.months[m.key] ?? 0
                  const cellSel = selCatKey === categoriesSelKey([cat.category]) && sel?.month === m.key
                  const rawMp   = calcPct(amt, grossMarginByMonth[m.key] ?? 0)
                  const pctStr  = fmtPct(rawMp)
                  const normPctSt = normPctStyleCategoryMonth(cat.category, amt, rawMp)
                  const uTrend = expenseTrendForCategory(cat, m.key, rawMp)
                  return (
                    <td key={m.key} onClick={() => amt > 0 && onOpenDrilldown([cat.category], m.key)}
                      className="px-0 py-1.5 text-right text-xs tabular-nums transition-colors"
                      style={cellSel ? { background: 'var(--bg-tertiary)', color: 'var(--text-primary)', cursor: 'pointer', fontWeight: 600 } : amt > 0 ? { color: 'var(--text-primary)', cursor: 'pointer' } : { color: 'var(--border-secondary)' }}
                      onMouseEnter={(e) => { if (!cellSel && amt > 0) (e.currentTarget as HTMLElement).style.background = 'var(--bg-secondary)' }}
                      onMouseLeave={(e) => { if (!cellSel) (e.currentTarget as HTMLElement).style.background = '' }}
                    >
                      <CellStack
                        pctStr={pctStr || undefined}
                        pctStyle={{ ...pctBaseStyle(cellSel), ...normPctSt }}
                        trendDeltaPP={uTrend.deltaPP}
                        trendTitle={uTrend.title}
                      >
                        <span>{fmtCell(amt)}</span>
                      </CellStack>
                    </td>
                  )
                })}
                <td
                  className={`${TOTAL_COL_TD_CLASS} font-semibold cursor-pointer`}
                  style={{ ...TOTAL_COL_STICKY_TD, color: 'var(--text-secondary)' }}
                  onClick={() => onOpenDrilldown([cat.category], null)}
                >
                  {(() => {
                    const rawTp       = calcPct(cat.total, totalGrossMargin)
                    const normPctTotS = normPctStyleCategoryTotal(cat.category, cat.total, rawTp)
                    return (
                      <CellStack
                        pctStr={fmtPct(rawTp) || undefined}
                        pctStyle={{ ...pctBaseStyle(false), ...normPctTotS }}
                      >
                        <span>{fmtCell(cat.total)}</span>
                      </CellStack>
                    )
                  })()}
                </td>
              </tr>
            ))}
          </>
        )}
      </tbody>
    </table>
  )
}

// ── UI Helpers ────────────────────────────────────────────────────────────────

/** Закрепление столбца «Итого» справа при горизонтальном скролле. */
const TOTAL_COL_STICKY_TD: CSSProperties = {
  background: 'var(--table-bg)',
  boxShadow: '-4px 0 10px -6px rgba(0, 0, 0, 0.12)',
}

const TOTAL_COL_TD_CLASS =
  'sticky right-0 z-10 px-4 py-1.5 text-right text-xs tabular-nums transition-colors'

function Th({ children, corner, total }: {
  children?: React.ReactNode; corner?: boolean; total?: boolean
}) {
  const isCorner = Boolean(corner)
  const isTotal  = Boolean(total)
  const pos = isCorner
    ? 'sticky top-0 left-0 z-30'
    : isTotal
    ? 'sticky top-0 right-0 z-30'
    : 'sticky top-0 z-20'
  const side = isCorner
    ? 'text-left min-w-[220px] px-3'
    : isTotal
    ? 'text-center px-4 min-w-[124px]'
    : 'text-center min-w-[104px] px-0'
  const base = `${pos} py-3 text-xs font-semibold whitespace-nowrap ${side}`
  return (
    <th
      className={base}
      style={{
        background: 'var(--table-header-bg)',
        color: isTotal ? 'var(--text-secondary)' : 'var(--text-muted)',
        boxShadow: isTotal ? '-4px 0 10px -6px rgba(0, 0, 0, 0.12)' : undefined,
      }}
    >
      {children}
    </th>
  )
}

function SectionHeaderRow({ colSpan, label }: { colSpan: number; label: string }) {
  const rowStyle = { borderTop: '2px solid var(--border-secondary)' } as const
  const stickyCellStyle: CSSProperties = {
    background: 'var(--bg-secondary)',
    color: 'var(--text-muted)',
    minWidth: '220px',
  }
  const fillerStyle: CSSProperties = { background: 'var(--bg-secondary)' }

  if (colSpan <= 1) {
    return (
      <tr style={rowStyle}>
        <td
          className="sticky left-0 z-10 px-4 py-1.5 text-xs font-semibold uppercase tracking-wider"
          style={stickyCellStyle}
        >
          {label}
        </td>
      </tr>
    )
  }

  if (colSpan >= 3) {
    return (
      <tr style={rowStyle}>
        <td
          className="sticky left-0 z-10 px-4 py-1.5 text-xs font-semibold uppercase tracking-wider"
          style={stickyCellStyle}
        >
          {label}
        </td>
        <td
          colSpan={colSpan - 2}
          className="py-1.5"
          style={fillerStyle}
          aria-hidden
        />
        <td
          className="sticky right-0 z-10 py-1.5 min-w-[124px]"
          style={{
            ...fillerStyle,
            boxShadow: '-4px 0 10px -6px rgba(0, 0, 0, 0.12)',
          }}
          aria-hidden
        />
      </tr>
    )
  }

  return (
    <tr style={rowStyle}>
      <td
        className="sticky left-0 z-10 px-4 py-1.5 text-xs font-semibold uppercase tracking-wider"
        style={stickyCellStyle}
      >
        {label}
      </td>
      <td
        colSpan={colSpan - 1}
        className="py-1.5"
        style={fillerStyle}
        aria-hidden
      />
    </tr>
  )
}

/** Доля тренда в п.п.: при целой части ≥100 (3+ цифры) — целое, иначе одна цифра после запятой. */
function formatTrendDeltaAbs(abs: number): string {
  const intLen = abs < 1 ? 1 : String(Math.trunc(abs)).length
  const fd = intLen > 2 ? 0 : 1
  return abs.toLocaleString('ru-RU', {
    minimumFractionDigits: fd,
    maximumFractionDigits: fd,
  })
}

/** Фиксированные 2 колонки: сумма (1fr) | % (фикс. ширина). Пустая колонка % без прочерка; 0% не показываем. */
function CellStack({
  children,
  pctStr,
  pctStyle,
  pct2Str,
  pct2Style,
  amountStyle,
  trendDeltaPP,
  trendTitle,
}: {
  children: ReactNode
  pctStr?: string | null
  pctStyle?: CSSProperties
  pct2Str?: string | null
  pct2Style?: CSSProperties
  amountStyle?: CSSProperties
  /** Изменение доли в марже в п.п. (расходы: ниже — лучше). */
  trendDeltaPP?: number | null
  trendTitle?: string
}) {
  const hasPct  = Boolean(pctStr && pctStr.trim() !== '')
  const hasPct2 = Boolean(pct2Str && pct2Str.trim() !== '')
  const showTrend =
    trendDeltaPP != null &&
    Number.isFinite(trendDeltaPP) &&
    Math.abs(trendDeltaPP) >= 0.05
  const amountEl = (() => {
    if (!amountStyle) return children
    const ch = Children.only(children)
    if (isValidElement(ch)) {
      const el = ch as ReactElement<{ style?: CSSProperties; className?: string }>
      const p  = el.props
      return cloneElement(el, {
        style: { ...p.style, ...amountStyle },
        className: [p.className, 'inline-block'].filter(Boolean).join(' '),
      })
    }
    return <span className="inline-block tabular-nums" style={amountStyle}>{children}</span>
  })()
  return (
    <div
      className="grid w-full grid-cols-[6rem_auto] gap-x-1 items-center leading-tight min-w-[12.5rem]"
    >
      <div className="text-right min-w-0 text-xs tabular-nums">{amountEl}</div>
      <div className="flex flex-row items-center justify-end gap-0 min-w-0">
        <div
          className="w-[2.875rem] shrink-0 text-right text-[10px] tabular-nums flex flex-col items-end gap-0.5 leading-tight justify-center"
          style={{ minHeight: hasPct2 ? '2.2em' : undefined }}
        >
          {hasPct ? <span style={pctStyle}>{pctStr}</span> : hasPct2 ? <span aria-hidden className="inline-block h-[1em]" /> : null}
          {hasPct2 ? <span style={pct2Style}>{pct2Str}</span> : null}
        </div>
        <div className="w-[2.75rem] shrink-0 text-right text-[9px] tabular-nums flex items-center justify-end">
          {showTrend ? (
            <span
              className="inline-flex items-center justify-end gap-0 select-none pl-1 leading-none"
              style={{
                color: expenseTrendGoodForExpense(trendDeltaPP!)
                  ? 'var(--success)'
                  : 'var(--danger)',
              }}
              title={trendTitle}
            >
              <span>{trendDeltaPP! > 0 ? '▲' : '▼'}</span>
              <span className="inline-block min-w-[1.2rem] text-right">
                {formatTrendDeltaAbs(Math.abs(trendDeltaPP!))}
              </span>
            </span>
          ) : null}
        </div>
      </div>
    </div>
  )
}

// ── EditableValue — клик для редактирования ───────────────────────────────────

function EditableValue({
  monthKey, value, onSave,
}: {
  monthKey: string
  value: number
  onSave: (mk: string, v: number) => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft]     = useState('')
  const [saving, setSaving]   = useState(false)
  const inputRef              = useRef<HTMLInputElement>(null)

  function startEdit() {
    setDraft(value === 0 ? '' : String(value))
    setEditing(true)
    setTimeout(() => inputRef.current?.focus(), 0)
  }

  function commit() {
    const n     = parseFloat(draft.replace(/\s/g, '').replace(',', '.'))
    const final = isNaN(n) ? 0 : n
    setEditing(false)
    setSaving(true)
    Promise.resolve(onSave(monthKey, final)).finally(() => setSaving(false))
  }

  if (editing) {
    return (
      <input
        ref={inputRef}
        autoFocus
        type="text"
        inputMode="numeric"
        placeholder=""
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter')  e.currentTarget.blur()
          if (e.key === 'Escape') setEditing(false)
        }}
        className="box-border w-full max-w-none m-0 p-0 text-right text-xs tabular-nums leading-tight outline-none rounded border-0"
        style={{
          background: 'var(--input-bg)',
          boxShadow: 'inset 0 0 0 1px var(--input-border-focus)',
          color: 'var(--text-primary)',
          fontFamily: 'inherit',
        }}
      />
    )
  }

  return (
    <span
      className="block w-full min-w-0 max-w-none m-0 p-0 min-h-[1.25em] text-right text-xs tabular-nums leading-tight cursor-pointer select-none"
      onClick={startEdit}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); startEdit() }
      }}
      title="Нажмите для редактирования"
      style={{
        color: value !== 0 ? 'var(--text-primary)' : 'var(--text-muted)',
        opacity: saving ? 0.5 : 1,
        fontFamily: 'inherit',
      }}
    >
      {fmtCell(value)}
    </span>
  )
}

// ── DrilldownPanel ────────────────────────────────────────────────────────────

function DrilldownPanel({
  drilldown,
  summary,
  yearFallback,
  onClose,
}: {
  drilldown: DrilldownState
  summary: SummaryResponse | null
  yearFallback: number
  onClose: () => void
}) {
  return (
    <aside className="w-[400px] shrink-0 flex flex-col overflow-hidden"
      style={{ background: 'var(--bg-card)', borderLeft: '1px solid var(--border-primary)' }}>
      <div className="shrink-0 flex items-start justify-between gap-3 px-5 py-4"
        style={{ borderBottom: '1px solid var(--border-primary)', background: 'var(--bg-secondary)' }}>
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-wider mb-1" style={{ color: 'var(--text-muted)' }}>
            Детализация
          </p>
          <p className="text-sm font-semibold leading-snug" style={{ color: 'var(--text-primary)' }}>
            {drilldown.label}
          </p>
          {!drilldown.loading && (
            <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
              {drilldown.count} расходов · {fmtAmount(drilldown.totalAmount)}
            </p>
          )}
        </div>
        <button onClick={onClose} className="shrink-0 mt-0.5 text-xl leading-none"
          style={{ color: 'var(--text-muted)' }}
          onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.color = 'var(--text-primary)')}
          onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.color = 'var(--text-muted)')}>
          ×
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {drilldown.loading
          ? <div className="flex items-center justify-center h-32 text-sm" style={{ color: 'var(--text-muted)' }}>Загрузка…</div>
          : drilldown.rows.length === 0
          ? <div className="flex items-center justify-center h-32 text-sm" style={{ color: 'var(--text-muted)' }}>Нет расходов</div>
          : <ul>{drilldown.rows.map((row) => <DrilldownRow key={row.id} row={row} />)}</ul>
        }
      </div>

      {!drilldown.loading && drilldown.rows.length > 0 && (
        <div className="shrink-0 px-5 py-3"
          style={{ borderTop: '1px solid var(--border-primary)', background: 'var(--bg-secondary)' }}>
          <Link href={buildExpensesLink(drilldown.selection, summary, yearFallback)}
            className="text-xs font-medium underline underline-offset-2" style={{ color: 'var(--text-secondary)' }}>
            Открыть в таблице расходов →
          </Link>
        </div>
      )}
    </aside>
  )
}

function DrilldownRow({ row }: { row: Expense }) {
  const primary   = row.comment || row.contractor || row.document_title || row.external_number
  const secondary = [row.contractor && row.comment ? row.contractor : null, fmtDate(row.expense_date)].filter(Boolean).join(' · ')
  return (
    <li onClick={() => window.open(`/expenses?q=${encodeURIComponent(row.external_number)}`, '_blank')}
      className="flex items-start gap-3 px-5 py-3 cursor-pointer transition-colors"
      style={{ borderBottom: '1px solid var(--table-border)' }}
      onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.background = 'var(--table-row-hover)')}
      onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.background = '')}>
      <div className="flex-1 min-w-0">
        <p className="text-sm truncate" style={{ color: 'var(--text-primary)' }}>{primary}</p>
        <p className="text-xs mt-0.5 truncate" style={{ color: 'var(--text-muted)' }}>{secondary}</p>
        <p className="text-xs font-mono mt-0.5" style={{ color: 'var(--border-strong)' }}>{row.external_number}</p>
      </div>
      <span className="shrink-0 text-sm font-semibold tabular-nums" style={{ color: 'var(--text-primary)' }}>
        {row.amount.toLocaleString('ru-RU', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
      </span>
    </li>
  )
}
