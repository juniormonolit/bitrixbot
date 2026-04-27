import { type NormLevel, normLevelColorStyle } from '@/lib/pnl/category-norm-heat'
import type { CSSProperties } from 'react'

export const PNL_ROW_NORM_KEYS = ['gross_margin', 'net_profit'] as const
export type PnlRowNormKey = (typeof PNL_ROW_NORM_KEYS)[number]

/** Пороги для строк прибыли: %% доли нормы (факт/норма), 0–100; внимание > критично. */
export const DEFAULT_PNL_ROW_ATTENTION_OF_NORM_PCT = 90
export const DEFAULT_PNL_ROW_CRITICAL_OF_NORM_PCT = 75

/** Нормативы для строки верхнего уровня P&L. */
export type PnlRowNormEntry = {
  normPercent: number | null
  /** Только чистая прибыль: вторая строка %% от выручки. */
  normPercentOfRevenue: number | null
  /** Нижняя граница жёлтого: жёлтый при доле нормы ∈ [attention..100%). */
  attentionOfNormPct: number
  /** Граница «критично» (глубже недобора); оба уровня ниже attention — красные. */
  criticalOfNormPct: number
}

export function parsePnlRowNormDbRow(r: {
  norm_percent?: unknown
  norm_percent_of_revenue?: unknown
  attention_of_norm_pct?: unknown
  critical_of_norm_pct?: unknown
}): PnlRowNormEntry {
  return {
    normPercent: r.norm_percent != null ? Number(r.norm_percent) : null,
    normPercentOfRevenue:
      r.norm_percent_of_revenue != null ? Number(r.norm_percent_of_revenue) : null,
    attentionOfNormPct:
      r.attention_of_norm_pct != null && Number.isFinite(Number(r.attention_of_norm_pct))
        ? Number(r.attention_of_norm_pct)
        : DEFAULT_PNL_ROW_ATTENTION_OF_NORM_PCT,
    criticalOfNormPct:
      r.critical_of_norm_pct != null && Number.isFinite(Number(r.critical_of_norm_pct))
        ? Number(r.critical_of_norm_pct)
        : DEFAULT_PNL_ROW_CRITICAL_OF_NORM_PCT,
  }
}

const EPS = 1e-9

/**
 * Строки прибыли: чем выше %% к норме, тем лучше.
 * q = факт/норма: зелёный при q ≥ 100%; жёлтый при q ∈ [attention..100%); красный при q < attention.
 */
export function normLevelForProfitLine(
  actualPct: number | null,
  normPct: number | null,
  entry: PnlRowNormEntry | undefined,
): NormLevel {
  if (!entry || normPct == null) return 'none'
  if (actualPct == null || !Number.isFinite(actualPct)) return 'none'
  if (normPct <= EPS) return 'none'
  if (actualPct < 0) return 'bad'
  if (actualPct <= EPS) return 'bad'

  const q = actualPct / normPct
  if (q >= 1 - EPS) return 'good'

  const att = entry.attentionOfNormPct / 100
  const crit = entry.criticalOfNormPct / 100
  if (att <= EPS || att >= 1 - EPS || crit <= EPS || crit >= att - EPS) return 'none'

  if (q >= att - EPS) return 'warn'
  return 'bad'
}

export function profitPctStyle(
  actualPct: number | null,
  normPct: number | null,
  entry: PnlRowNormEntry | undefined,
): CSSProperties | undefined {
  return normLevelColorStyle(normLevelForProfitLine(actualPct, normPct, entry))
}

/** Чистая прибыль: отрицательные %% всегда красные (в т.ч. без нормы). */
export function netProfitPctStyle(
  actualPct: number | null,
  normPct: number | null,
  entry: PnlRowNormEntry | undefined,
): CSSProperties | undefined {
  if (actualPct != null && Number.isFinite(actualPct) && actualPct < 0) {
    return normLevelColorStyle('bad')
  }
  return profitPctStyle(actualPct, normPct, entry)
}
