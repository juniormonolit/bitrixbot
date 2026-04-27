import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase/server'
import type { CategoryNormEntry } from '@/lib/pnl/category-norm-heat'
import { parseCategoryNormDbRow } from '@/lib/pnl/category-norm-heat'

export type CategoryNormRow = {
  category: string
  norm_percent: number | null
  norm_amount: number | null
  attention_of_norm_pct: number
  critical_of_norm_pct: number
}

function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/\s/g, '').replace(',', '.'))
  return Number.isFinite(n) ? n : null
}

// ── GET /api/pnl/category-norms ───────────────────────────────────────────────

export async function GET(): Promise<NextResponse> {
  let supabase
  try { supabase = createServerClient() } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }

  const { data, error } = await supabase
    .from('pnl_category_norms')
    .select('category, norm_percent, norm_amount, attention_of_norm_pct, critical_of_norm_pct')
    .order('category')

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const norms: CategoryNormRow[] = (data ?? []).map((r) => {
    const m = parseCategoryNormDbRow(r)
    return {
      category: r.category,
      norm_percent: m.normPercent,
      norm_amount: m.normAmount,
      attention_of_norm_pct: m.attentionOfNormPct,
      critical_of_norm_pct: m.criticalOfNormPct,
    }
  })

  const byCategory: Record<string, CategoryNormEntry> = {}
  for (const r of data ?? []) {
    byCategory[r.category] = parseCategoryNormDbRow(r)
  }

  return NextResponse.json({ norms, byCategory })
}

// ── PUT /api/pnl/category-norms ───────────────────────────────────────────────
// Body: { category, norm_percent, norm_amount, attention_of_norm_pct?, critical_of_norm_pct? }
// Если обе нормы null — удаление строки. Иначе пороги обязательны (>100, критично > внимание).

export async function PUT(request: NextRequest): Promise<NextResponse> {
  let body: unknown
  try { body = await request.json() } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const b = body as Record<string, unknown>
  const category = typeof b.category === 'string' ? b.category.trim() : ''
  if (!category) {
    return NextResponse.json({ error: 'category required' }, { status: 400 })
  }

  if (!Object.prototype.hasOwnProperty.call(b, 'norm_percent') ||
      !Object.prototype.hasOwnProperty.call(b, 'norm_amount')) {
    return NextResponse.json(
      { error: 'norm_percent and norm_amount required (use null to clear a field)' },
      { status: 400 },
    )
  }

  const norm_percent = b.norm_percent === null ? null : numOrNull(b.norm_percent)
  const norm_amount  = b.norm_amount === null ? null : numOrNull(b.norm_amount)

  if (norm_percent !== null && (norm_percent < 0 || norm_percent > 1000)) {
    return NextResponse.json({ error: 'norm_percent must be between 0 and 1000' }, { status: 400 })
  }
  if (norm_amount !== null && (norm_amount < 0 || norm_amount > 1e12)) {
    return NextResponse.json({ error: 'norm_amount out of range' }, { status: 400 })
  }

  let supabase
  try { supabase = createServerClient() } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }

  const { data: catRow, error: catErr } = await supabase
    .from('expense_categories')
    .select('name')
    .eq('name', category)
    .eq('is_active', true)
    .maybeSingle()

  if (catErr) return NextResponse.json({ error: catErr.message }, { status: 500 })
  if (!catRow) {
    return NextResponse.json({ error: `Unknown category: ${category}` }, { status: 400 })
  }

  if (norm_percent === null && norm_amount === null) {
    const { error: delErr } = await supabase.from('pnl_category_norms').delete().eq('category', category)
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

  if (attention_of_norm_pct == null || attention_of_norm_pct <= 100) {
    return NextResponse.json(
      { error: 'attention_of_norm_pct must be a number > 100 (e.g. 110 for 110% of norm)' },
      { status: 400 },
    )
  }
  if (critical_of_norm_pct == null || critical_of_norm_pct <= attention_of_norm_pct) {
    return NextResponse.json(
      { error: 'critical_of_norm_pct must be greater than attention_of_norm_pct' },
      { status: 400 },
    )
  }

  const { data: upserted, error: upErr } = await supabase
    .from('pnl_category_norms')
    .upsert(
      {
        category,
        norm_percent,
        norm_amount,
        attention_of_norm_pct,
        critical_of_norm_pct,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'category' },
    )
    .select('category, norm_percent, norm_amount, attention_of_norm_pct, critical_of_norm_pct')
    .single()

  if (upErr) return NextResponse.json({ error: upErr.message }, { status: 500 })

  return NextResponse.json({
    ok: true,
    row: parseCategoryNormDbRow(upserted!),
  })
}
