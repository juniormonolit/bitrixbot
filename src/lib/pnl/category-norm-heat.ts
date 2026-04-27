import type { CSSProperties } from 'react'

/** Нормативы и пороги отклонения (в процентах от нормы: 110 = 110%%). */
export type CategoryNormEntry = {
  normPercent: number | null
  normAmount: number | null
  attentionOfNormPct: number
  criticalOfNormPct: number
}

export const DEFAULT_ATTENTION_OF_NORM_PCT = 110
export const DEFAULT_CRITICAL_OF_NORM_PCT = 125

/** Разбор строки из БД (Supabase). */
export function parseCategoryNormDbRow(r: {
  norm_percent?: unknown
  norm_amount?: unknown
  attention_of_norm_pct?: unknown
  critical_of_norm_pct?: unknown
}): CategoryNormEntry {
  return {
    normPercent: r.norm_percent != null ? Number(r.norm_percent) : null,
    normAmount: r.norm_amount != null ? Number(r.norm_amount) : null,
    attentionOfNormPct:
      r.attention_of_norm_pct != null && Number.isFinite(Number(r.attention_of_norm_pct))
        ? Number(r.attention_of_norm_pct)
        : DEFAULT_ATTENTION_OF_NORM_PCT,
    criticalOfNormPct:
      r.critical_of_norm_pct != null && Number.isFinite(Number(r.critical_of_norm_pct))
        ? Number(r.critical_of_norm_pct)
        : DEFAULT_CRITICAL_OF_NORM_PCT,
  }
}

export type NormLevel = 'none' | 'good' | 'warn' | 'bad'

const EPS = 1e-9

/**
 * Максимум отношений «факт / норма» по всем заданным нормативам (%% и/или сумма за месяц).
 */
export function maxRatioMonth(
  actualPct: number | null,
  actualAmt: number,
  normPct: number | null,
  normAmt: number | null,
): number | null {
  if (normPct == null && normAmt == null) return null
  let maxR: number | null = null
  if (normPct != null && normPct > EPS && actualPct != null && Number.isFinite(actualPct)) {
    const r = actualPct / normPct
    maxR = maxR == null ? r : Math.max(maxR, r)
  }
  if (normAmt != null && normAmt > EPS) {
    const r = actualAmt / normAmt
    maxR = maxR == null ? r : Math.max(maxR, r)
  }
  return maxR
}

/**
 * Итого за период: для %% — факт%%/норма%%; для суммы — итого / (норма_за_мес × число месяцев).
 */
export function maxRatioTotal(
  totalPct: number | null,
  totalAmt: number,
  normPct: number | null,
  normAmt: number | null,
  monthCount: number,
): number | null {
  if (normPct == null && normAmt == null) return null
  let maxR: number | null = null
  if (normPct != null && normPct > EPS && totalPct != null && Number.isFinite(totalPct)) {
    const r = totalPct / normPct
    maxR = maxR == null ? r : Math.max(maxR, r)
  }
  if (normAmt != null && normAmt > EPS && monthCount >= 1) {
    const cap = normAmt * monthCount
    if (cap > EPS) {
      const r = totalAmt / cap
      maxR = maxR == null ? r : Math.max(maxR, r)
    }
  }
  return maxR
}

/**
 * - ≤ нормы (ratio ≤ 1): зелёный
 * - небольшое превышение: жёлтый (1 < ratio ≤ attention/100)
 * - выше порога внимания до критического: красный
 * - выше критического: красный
 */
export function normLevelFromRatio(
  maxRatio: number | null,
  attentionOfNormPct: number,
  criticalOfNormPct: number,
): NormLevel {
  if (maxRatio == null || !Number.isFinite(maxRatio)) return 'none'
  const att  = attentionOfNormPct / 100
  const crit = criticalOfNormPct / 100
  if (maxRatio <= 1 + EPS) return 'good'
  if (maxRatio > crit + EPS) return 'bad'
  if (maxRatio > att + EPS) return 'bad'
  return 'warn'
}

/** Сплошной цвет только для колонки %% (без градиента). */
export function normLevelColorStyle(level: NormLevel): CSSProperties | undefined {
  if (level === 'none') return undefined
  if (level === 'good') return { color: 'var(--success)' }
  if (level === 'warn') return { color: 'var(--warning)' }
  return { color: 'var(--danger)' }
}
