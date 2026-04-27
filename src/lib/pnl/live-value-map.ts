import type { PnlRow, SummaryResponse } from '@/app/api/pnl/expenses-summary/route'

type RegularFormula = { op: 'add' | 'subtract'; left: string; right: string }
type MultiplySettingFml = { op: 'multiply_setting'; sum_refs: string[]; setting_key: string }
type FormulaJson = RegularFormula | MultiplySettingFml

/** Ключ строки в lv (совпадает с liveVal в P&L). */
export function rowLiveLookupKey(row: PnlRow): string {
  return row.key && row.key !== row.id ? row.key : row.id
}

/**
 * Та же карта «живых» сумм по ключу строки и месяцу, что в P&L (формулы, кредит/налоги и т.д.).
 */
export function buildLiveValueMap(
  summary: SummaryResponse,
  revenueByMonth: Record<string, number>,
  grossMarginByMonth: Record<string, number>,
): Map<string, Record<string, number>> {
  const lv = new Map<string, Record<string, number>>()
  const settings = summary.settings

  lv.set('revenue', { ...revenueByMonth })
  lv.set('gross_margin', { ...grossMarginByMonth })

  for (const row of summary.pnlRows) {
    if (row.type === 'group' || row.type === 'category') {
      const k = rowLiveLookupKey(row)
      if (!lv.has(k)) lv.set(k, { ...row.months })
    }
  }

  function seedFromTree(rows: PnlRow[]) {
    for (const r of rows) {
      const k = rowLiveLookupKey(r)
      if (!lv.has(k)) lv.set(k, { ...r.months })
      if (r.children.length) seedFromTree(r.children)
    }
  }
  seedFromTree(summary.structure)

  const ctStructRow = summary.structure.find((r) => r.key === 'credit_taxes')
  if (ctStructRow?.children.length) {
    for (const child of ctStructRow.children) {
      if (child.type === 'formula' && child.formula) {
        const f = child.formula as FormulaJson
        const computed: Record<string, number> = {}
        if (f.op === 'multiply_setting') {
          const sv = settings[f.setting_key] ?? 0
          for (const m of summary.months) {
            computed[m.key] = f.sum_refs.reduce((s, ref) => s + (lv.get(ref)?.[m.key] ?? 0), 0) * sv
          }
        } else {
          for (const m of summary.months) {
            const l = lv.get(f.left)?.[m.key] ?? 0
            const rgt = lv.get(f.right)?.[m.key] ?? 0
            computed[m.key] = f.op === 'subtract' ? l - rgt : l + rgt
          }
        }
        lv.set(rowLiveLookupKey(child), computed)
      }
    }
    const ctLive: Record<string, number> = {}
    for (const m of summary.months) {
      ctLive[m.key] = ctStructRow.children.reduce((s, c) => {
        return s + (lv.get(rowLiveLookupKey(c))?.[m.key] ?? c.months[m.key] ?? 0)
      }, 0)
    }
    lv.set('credit_taxes', ctLive)
  }

  for (const row of summary.pnlRows) {
    if (row.type !== 'formula' || !row.formula) continue
    const f = row.formula as FormulaJson
    const computed: Record<string, number> = {}
    if (f.op === 'multiply_setting') {
      const sv = settings[f.setting_key] ?? 0
      for (const m of summary.months) {
        computed[m.key] = f.sum_refs.reduce((s, ref) => s + (lv.get(ref)?.[m.key] ?? 0), 0) * sv
      }
    } else {
      for (const m of summary.months) {
        const left = lv.get(f.left)?.[m.key] ?? 0
        const right = lv.get(f.right)?.[m.key] ?? 0
        computed[m.key] = f.op === 'subtract' ? left - right : left + right
      }
    }
    lv.set(rowLiveLookupKey(row), computed)
  }

  return lv
}

export function liveValFromMap(
  row: PnlRow,
  monthKey: string,
  lv: Map<string, Record<string, number>>,
  lvFallback: Map<string, Record<string, number>> | null,
): number {
  const key = rowLiveLookupKey(row)
  const a = lv.get(key)?.[monthKey]
  if (a !== undefined) return a
  if (lvFallback) {
    const b = lvFallback.get(key)?.[monthKey]
    if (b !== undefined) return b
  }
  return row.months[monthKey] ?? 0
}
