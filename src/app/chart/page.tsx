'use client'

import { useState, useEffect, useMemo } from 'react'
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import type { PnlRow, SummaryResponse } from '@/app/api/pnl/expenses-summary/route'

const CURRENT_YEAR = new Date().getFullYear()
const YEAR_OPTIONS = Array.from({ length: 5 }, (_, i) => CURRENT_YEAR - i)

type ChartPoint = {
  label: string
  key: string
  revenue: number
  grossMargin: number
  commercial: number
  indirect: number
  creditTaxes: number
  /** Сумма трёх блоков расходов (для режима без детализации). */
  expensesTotal: number
}

function findRowByKey(nodes: PnlRow[], key: string): PnlRow | undefined {
  for (const n of nodes) {
    if (n.key === key) return n
    if (n.children.length) {
      const f = findRowByKey(n.children, key)
      if (f) return f
    }
  }
  return undefined
}

function buildChartData(summary: SummaryResponse): ChartPoint[] {
  const revenue =
    summary.pnlRows.find((r) => r.key === 'revenue') ??
    findRowByKey(summary.structure, 'revenue')
  const grossMargin =
    summary.pnlRows.find((r) => r.key === 'gross_margin') ??
    findRowByKey(summary.structure, 'gross_margin')
  const commercial =
    summary.pnlRows.find((r) => r.key === 'commercial_expenses') ??
    findRowByKey(summary.structure, 'commercial_expenses')
  const indirect =
    summary.pnlRows.find((r) => r.key === 'indirect_expenses') ??
    findRowByKey(summary.structure, 'indirect_expenses')
  const creditTaxes =
    summary.structure.find((r) => r.key === 'credit_taxes') ??
    findRowByKey(summary.structure, 'credit_taxes')

  return summary.months.map((m) => {
    const commercialAmt = commercial?.months[m.key] ?? 0
    const indirectAmt   = indirect?.months[m.key] ?? 0
    const creditAmt     = creditTaxes?.months[m.key] ?? 0
    return {
      label: m.label,
      key: m.key,
      revenue: revenue?.months[m.key] ?? 0,
      grossMargin: grossMargin?.months[m.key] ?? 0,
      commercial: commercialAmt,
      indirect: indirectAmt,
      creditTaxes: creditAmt,
      expensesTotal: commercialAmt + indirectAmt + creditAmt,
    }
  })
}

/** Оставить только диапазон от первого до последнего месяца, где есть данные (не обрезать по «текущему» месяцу). */
function trimChartDataToDataRange(
  points: ChartPoint[],
  grandTotalByMonth: Record<string, number> | undefined,
): ChartPoint[] {
  const hasData = (p: ChartPoint) => {
    if (
      Math.abs(p.revenue) >= 0.01 ||
      Math.abs(p.grossMargin) >= 0.01 ||
      Math.abs(p.expensesTotal) >= 0.01
    ) {
      return true
    }
    const g = grandTotalByMonth?.[p.key] ?? 0
    return Math.abs(g) >= 0.01
  }

  const first = points.findIndex(hasData)
  let last = -1
  for (let i = points.length - 1; i >= 0; i--) {
    if (hasData(points[i]!)) {
      last = i
      break
    }
  }
  if (first === -1 || last === -1 || first > last) return points
  return points.slice(first, last + 1)
}

function fmtRub(n: number): string {
  return n.toLocaleString('ru-RU', { maximumFractionDigits: 0 }) + ' ₽'
}

function ToggleYesNo({
  label,
  value,
  onChange,
}: {
  label: string
  value: boolean
  onChange: (next: boolean) => void
}) {
  const btn = (active: boolean) =>
    active
      ? {
          background: 'var(--accent-primary)',
          color: 'var(--text-on-accent)',
        }
      : {
          background: 'var(--input-bg)',
          color: 'var(--text-secondary)',
        }

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>{label}</span>
      <div
        className="inline-flex rounded-lg overflow-hidden text-xs font-medium"
        style={{ border: '1px solid var(--input-border)' }}
      >
        <button
          type="button"
          onClick={() => onChange(true)}
          className="px-3 py-1.5 transition-colors"
          style={btn(value)}
        >
          Да
        </button>
        <button
          type="button"
          onClick={() => onChange(false)}
          className="px-3 py-1.5 transition-colors"
          style={btn(!value)}
        >
          Нет
        </button>
      </div>
    </div>
  )
}

export default function ChartPage() {
  const [year, setYear] = useState<number | 'all'>(CURRENT_YEAR)
  const [showRevenue, setShowRevenue]     = useState(true)
  const [detailExpenses, setDetailExpenses] = useState(true)
  const [summary, setSummary] = useState<SummaryResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    const q = year === 'all' ? 'allTime=1' : `year=${year}`
    fetch(`/api/pnl/expenses-summary?${q}`)
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return
        if (d.error) {
          setError(d.error)
          setSummary(null)
          return
        }
        setSummary(d as SummaryResponse)
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Ошибка загрузки')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [year])

  const data = useMemo(() => {
    if (!summary) return []
    const raw = buildChartData(summary)
    return trimChartDataToDataRange(raw, summary.grandTotalByMonth)
  }, [summary])

  return (
    <div
      className="flex flex-col font-sans"
      style={{
        height: 'calc(100vh - var(--nav-h))',
        background: 'var(--bg-primary)',
        color: 'var(--text-primary)',
      }}
    >
      <div
        className="shrink-0 flex flex-wrap items-center gap-x-6 gap-y-3 px-5 py-2.5"
        style={{ background: 'var(--bg-card)', borderBottom: '1px solid var(--border-primary)' }}
      >
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium" style={{ color: 'var(--text-secondary)' }}>
            Период
          </span>
          <select
            value={year === 'all' ? 'all' : year}
            onChange={(e) => {
              const v = e.target.value
              setYear(v === 'all' ? 'all' : Number(v))
            }}
            className="rounded-lg px-3 py-1.5 text-sm outline-none"
            style={{
              background: 'var(--input-bg)',
              border: '1px solid var(--input-border)',
              color: 'var(--input-text)',
            }}
          >
            {YEAR_OPTIONS.map((y) => (
              <option key={y} value={y}>{y}</option>
            ))}
            <option value="all">Всё время</option>
          </select>
        </div>
        <ToggleYesNo
          label="Отображать «Выручку»"
          value={showRevenue}
          onChange={setShowRevenue}
        />
        <ToggleYesNo
          label="Детализировать расходы"
          value={detailExpenses}
          onChange={setDetailExpenses}
        />
      </div>

      <div className="flex-1 min-h-0 flex flex-col p-4 md:p-5">
        {loading && (
          <div className="flex-1 flex items-center justify-center text-sm" style={{ color: 'var(--text-muted)' }}>
            Загрузка…
          </div>
        )}
        {error && !loading && (
          <div
            className="rounded-xl px-5 py-4 text-sm m-auto max-w-md"
            style={{
              background: 'var(--danger-bg)',
              border: '1px solid var(--danger-border)',
              color: 'var(--danger)',
            }}
          >
            {error}
          </div>
        )}
        {!loading && !error && data.length > 0 && (
          <div
            className="flex-1 min-h-0 w-full rounded-xl overflow-hidden"
            style={{
              background: 'var(--bg-card)',
              border: '1px solid var(--border-primary)',
              boxShadow: 'var(--shadow-sm)',
            }}
          >
            <ResponsiveContainer width="100%" height="100%" minHeight={320}>
              <ComposedChart data={data} margin={{ top: 20, right: 28, left: 4, bottom: 48 }}>
                <defs>
                  <linearGradient id="fillRevenue" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#2563EB" stopOpacity={0.35} />
                    <stop offset="100%" stopColor="#2563EB" stopOpacity={0.02} />
                  </linearGradient>
                  <linearGradient id="fillMargin" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#16A34A" stopOpacity={0.35} />
                    <stop offset="100%" stopColor="#16A34A" stopOpacity={0.02} />
                  </linearGradient>
                </defs>
                <CartesianGrid
                  strokeDasharray="3 3"
                  vertical={false}
                  stroke="var(--table-border)"
                />
                <XAxis
                  dataKey="label"
                  tick={{ fontSize: 11, fill: 'var(--text-muted)' }}
                  tickMargin={8}
                  interval={0}
                  angle={data.length > 14 ? -35 : 0}
                  textAnchor={data.length > 14 ? 'end' : 'middle'}
                  height={data.length > 14 ? 56 : 32}
                />
                <YAxis
                  tick={{ fontSize: 11, fill: 'var(--text-muted)' }}
                  tickFormatter={(v) =>
                    Number(v).toLocaleString('ru-RU', {
                      notation: 'compact',
                      compactDisplay: 'short',
                      maximumFractionDigits: 1,
                    })
                  }
                  width={56}
                />
                <Tooltip
                  contentStyle={{
                    background: 'var(--bg-elevated)',
                    border: '1px solid var(--border-primary)',
                    borderRadius: '8px',
                    fontSize: '12px',
                    color: 'var(--text-primary)',
                  }}
                  formatter={(value, name) => [fmtRub(Number(value ?? 0)), String(name ?? '')]}
                  labelStyle={{ color: 'var(--text-muted)', marginBottom: 4 }}
                />
                <Legend
                  wrapperStyle={{ fontSize: '12px', paddingTop: 16 }}
                  formatter={(value) => <span style={{ color: 'var(--text-secondary)' }}>{value}</span>}
                />
                {/* Расходы: стек или одна сумма */}
                {detailExpenses ? (
                  <>
                    <Area
                      type="monotone"
                      dataKey="commercial"
                      name="Коммерческие расходы"
                      stackId="expenses"
                      stroke="#991B1B"
                      fill="#991B1B"
                      fillOpacity={0.75}
                    />
                    <Area
                      type="monotone"
                      dataKey="indirect"
                      name="Косвенные расходы"
                      stackId="expenses"
                      stroke="#DC2626"
                      fill="#DC2626"
                      fillOpacity={0.72}
                    />
                    <Area
                      type="monotone"
                      dataKey="creditTaxes"
                      name="Кредит и налоги"
                      stackId="expenses"
                      stroke="#F87171"
                      fill="#F87171"
                      fillOpacity={0.68}
                    />
                  </>
                ) : (
                  <Area
                    type="monotone"
                    dataKey="expensesTotal"
                    name="Расходы (всего)"
                    stroke="#B91C1C"
                    fill="#DC2626"
                    fillOpacity={0.55}
                  />
                )}
                {/* Выручка и маржа — поверх расходов */}
                {showRevenue && (
                  <Area
                    type="monotone"
                    dataKey="revenue"
                    name="Выручка"
                    stroke="#2563EB"
                    strokeWidth={2}
                    fill="url(#fillRevenue)"
                    fillOpacity={1}
                  />
                )}
                <Area
                  type="monotone"
                  dataKey="grossMargin"
                  name="Маржинальная прибыль"
                  stroke="#16A34A"
                  strokeWidth={2}
                  fill="url(#fillMargin)"
                  fillOpacity={1}
                />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>
    </div>
  )
}
