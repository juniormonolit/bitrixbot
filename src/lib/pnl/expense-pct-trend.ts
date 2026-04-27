export type ExpensePctTrendMode = 'mom' | 'yoy'

export const EXPENSE_PCT_TREND_STORAGE_KEY = 'pnl-expense-pct-trend-mode'

export function parseExpensePctTrendMode(raw: string | null): ExpensePctTrendMode {
  return raw === 'yoy' ? 'yoy' : 'mom'
}

/** Предыдущий календарный месяц (для одного года нужен прошлый год в декабре). */
export function prevCalendarMonthKey(monthKey: string): string | null {
  const [ys, ms] = monthKey.split('-')
  const y = Number(ys)
  const m = Number(ms)
  if (!Number.isFinite(y) || !Number.isFinite(m) || m < 1 || m > 12) return null
  if (m === 1) return `${y - 1}-12`
  return `${y}-${String(m - 1).padStart(2, '0')}`
}

export function resolveCompareMonthKey(
  currentMk: string,
  mode: ExpensePctTrendMode,
  allTime: boolean,
  orderedMonthKeys: string[],
): string | null {
  if (mode === 'yoy') {
    const [ys, ms] = currentMk.split('-')
    const y = Number(ys)
    const mo = Number(ms)
    if (!Number.isFinite(y) || !Number.isFinite(mo)) return null
    return `${y - 1}-${String(mo).padStart(2, '0')}`
  }
  if (allTime) {
    const idx = orderedMonthKeys.indexOf(currentMk)
    if (idx <= 0) return null
    return orderedMonthKeys[idx - 1]!
  }
  return prevCalendarMonthKey(currentMk)
}

/** Доля расходов в марже: снижение доли — хорошо (зелёный). */
export function expenseTrendGoodForExpense(deltaPP: number): boolean {
  return deltaPP < -1e-6
}
