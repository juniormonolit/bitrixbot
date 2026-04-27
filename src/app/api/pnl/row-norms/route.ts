import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase/server'
import {
  type PnlRowNormEntry,
  type PnlRowNormKey,
  PNL_ROW_NORM_KEYS,
  parsePnlRowNormDbRow,
} from '@/lib/pnl/row-norm'

function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/\s/g, '').replace(',', '.'))
  return Number.isFinite(n) ? n : null
}

function isRowKey(k: string): k is PnlRowNormKey {
  return (PNL_ROW_NORM_KEYS as readonly string[]).includes(k)
}

// ── GET /api/pnl/row-norms ─────────────────────────────────────────────────────

export async function GET(): Promise<NextResponse> {
  let supabase
  try { supabase = createServerClient() } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }

  const { data, error } = await supabase
    .from('pnl_row_norms')
    .select('row_key, norm_percent, norm_percent_of_revenue, attention_of_norm_pct, critical_of_norm_pct')
    .order('row_key')

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const byKey: Partial<Record<PnlRowNormKey, PnlRowNormEntry>> = {}
  for (const r of data ?? []) {
    if (!isRowKey(r.row_key)) continue
    byKey[r.row_key] = parsePnlRowNormDbRow(r)
  }

  return NextResponse.json({ rowNorms: byKey })
}

// ── PUT /api/pnl/row-norms ─────────────────────────────────────────────────────

export async function PUT(request: NextRequest): Promise<NextResponse> {
  let body: unknown
  try { body = await request.json() } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const b = body as Record<string, unknown>
  const row_key = typeof b.row_key === 'string' ? b.row_key.trim() : ''
  if (!isRowKey(row_key)) {
    return NextResponse.json({ error: 'row_key must be gross_margin or net_profit' }, { status: 400 })
  }

  if (!Object.prototype.hasOwnProperty.call(b, 'norm_percent') ||
      !Object.prototype.hasOwnProperty.call(b, 'norm_percent_of_revenue')) {
    return NextResponse.json(
      { error: 'norm_percent and norm_percent_of_revenue required (null to clear)' },
      { status: 400 },
    )
  }

  const norm_percent            = b.norm_percent === null ? null : numOrNull(b.norm_percent)
  const norm_percent_of_revenue = b.norm_percent_of_revenue === null ? null : numOrNull(b.norm_percent_of_revenue)

  if (norm_percent !== null && (norm_percent < 0 || norm_percent > 1000)) {
    return NextResponse.json({ error: 'norm_percent out of range' }, { status: 400 })
  }
  if (norm_percent_of_revenue !== null && (norm_percent_of_revenue < 0 || norm_percent_of_revenue > 1000)) {
    return NextResponse.json({ error: 'norm_percent_of_revenue out of range' }, { status: 400 })
  }

  if (row_key === 'gross_margin' && norm_percent_of_revenue != null) {
    return NextResponse.json(
      { error: 'gross_margin cannot have norm_percent_of_revenue' },
      { status: 400 },
    )
  }

  let supabase
  try { supabase = createServerClient() } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }

  if (norm_percent === null && norm_percent_of_revenue === null) {
    const { error: delErr } = await supabase.from('pnl_row_norms').delete().eq('row_key', row_key)
    if (delErr) return NextResponse.json({ error: delErr.message }, { status: 500 })
    return NextResponse.json({ ok: true, deleted: true })
  }

  if (!Object.prototype.hasOwnProperty.call(b, 'attention_of_norm_pct') ||
      !Object.prototype.hasOwnProperty.call(b, 'critical_of_norm_pct')) {
    return NextResponse.json(
      { error: 'attention_of_norm_pct and critical_of_norm_pct required when norms are set' },
      { status: 400 },
    )
  }

  const attention_of_norm_pct = numOrNull(b.attention_of_norm_pct)
  const critical_of_norm_pct  = numOrNull(b.critical_of_norm_pct)

  if (
    attention_of_norm_pct == null ||
    attention_of_norm_pct <= 0 ||
    attention_of_norm_pct >= 100
  ) {
    return NextResponse.json(
      { error: 'attention_of_norm_pct must be between 0 and 100 (share of norm, e.g. 90)' },
      { status: 400 },
    )
  }
  if (
    critical_of_norm_pct == null ||
    critical_of_norm_pct <= 0 ||
    critical_of_norm_pct >= 100 ||
    critical_of_norm_pct >= attention_of_norm_pct
  ) {
    return NextResponse.json(
      { error: 'critical_of_norm_pct must be less than attention_of_norm_pct (e.g. 75 and 90)' },
      { status: 400 },
    )
  }

  const revCol = row_key === 'gross_margin' ? null : norm_percent_of_revenue

  const { data: upserted, error: upErr } = await supabase
    .from('pnl_row_norms')
    .upsert(
      {
        row_key,
        norm_percent,
        norm_percent_of_revenue: revCol,
        attention_of_norm_pct,
        critical_of_norm_pct,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'row_key' },
    )
    .select('row_key, norm_percent, norm_percent_of_revenue, attention_of_norm_pct, critical_of_norm_pct')
    .single()

  if (upErr) return NextResponse.json({ error: upErr.message }, { status: 500 })

  return NextResponse.json({
    ok: true,
    row: parsePnlRowNormDbRow(upserted!),
  })
}
