import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase/server'

const ALLOWED_METRICS = new Set([
  'revenue',
  'gross_margin',
])

export type MonthlyValueRow = {
  year:   number
  month:  number
  metric: string
  amount: number
}

export type MonthlyValuesResponse = {
  rows: MonthlyValueRow[]
}

// ── GET /api/pnl/monthly-values?year=2026 ─────────────────────────────────────

export async function GET(request: NextRequest): Promise<NextResponse> {
  const sp   = request.nextUrl.searchParams
  const year = parseInt(sp.get('year') ?? String(new Date().getFullYear()), 10)

  if (isNaN(year) || year < 2000 || year > 2100) {
    return NextResponse.json({ error: 'Invalid year' }, { status: 400 })
  }

  let supabase
  try { supabase = createServerClient() } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }

  const { data, error } = await supabase
    .from('pnl_monthly_values')
    .select('year, month, metric, amount')
    .eq('year', year)
    .order('month', { ascending: true })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ rows: data ?? [] } satisfies MonthlyValuesResponse)
}

// ── PUT /api/pnl/monthly-values ───────────────────────────────────────────────

export async function PUT(request: NextRequest): Promise<NextResponse> {
  let body: unknown
  try { body = await request.json() } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const b = body as Record<string, unknown>

  const year   = typeof b.year   === 'number' ? b.year   : parseInt(String(b.year),   10)
  const month  = typeof b.month  === 'number' ? b.month  : parseInt(String(b.month),  10)
  const metric = String(b.metric ?? '').trim()
  const amount = typeof b.amount === 'number' ? b.amount : parseFloat(String(b.amount))

  if (isNaN(year)  || year  < 2000 || year  > 2100) return NextResponse.json({ error: 'Invalid year'   }, { status: 400 })
  if (isNaN(month) || month < 1    || month > 12)    return NextResponse.json({ error: 'Invalid month'  }, { status: 400 })
  if (!ALLOWED_METRICS.has(metric))                   return NextResponse.json({ error: `Unknown metric "${metric}". Allowed: ${[...ALLOWED_METRICS].join(', ')}` }, { status: 400 })
  if (isNaN(amount))                                  return NextResponse.json({ error: 'Invalid amount' }, { status: 400 })

  let supabase
  try { supabase = createServerClient() } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }

  const rounded = Math.round(amount * 100) / 100

  const { data, error } = await supabase
    .from('pnl_monthly_values')
    .upsert(
      { year, month, metric, amount: rounded },
      { onConflict: 'year,month,metric' },
    )
    .select('year, month, metric, amount')
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json(data)
}
