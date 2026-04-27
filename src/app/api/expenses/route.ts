import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase/server'
import type { Expense, ExpenseCreate, ExpenseListResponse } from '@/lib/expenses/types'

// ── Shared normalisation ──────────────────────────────────────────────────────

function normStr(v: unknown): string | null {
  if (v === null || v === undefined) return null
  const s = String(v).trim()
  return s.length > 0 ? s : null
}

function roundAmount(v: unknown): number {
  const n = typeof v === 'number' ? v : parseFloat(String(v))
  return isNaN(n) ? 0 : Math.round(n * 100) / 100
}

// ── GET /api/expenses ─────────────────────────────────────────────────────────

export async function GET(request: NextRequest): Promise<NextResponse> {
  const sp = request.nextUrl.searchParams

  const q         = sp.get('q')?.trim() || null
  const categories = sp
    .getAll('categories')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  const categoryLegacy = sp.get('category')?.trim() || null
  const dateFrom  = sp.get('dateFrom')?.trim() || null
  const dateTo    = sp.get('dateTo')?.trim() || null
  const limit     = Math.min(parseInt(sp.get('limit') ?? '100', 10) || 100, 500)
  const offset    = parseInt(sp.get('offset') ?? '0', 10) || 0

  let supabase
  try { supabase = createServerClient() } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }

  // Build query with progressive filters — TS is happy because each call
  // returns the same PostgrestFilterBuilder shape.
  let qb = supabase
    .from('expenses')
    .select<'*', Expense>('*', { count: 'exact' })
    .is('deleted_at', null)

  if (q) {
    // Supabase or() with multiple columns
    qb = qb.or(
      `external_number.ilike.%${q}%,contractor.ilike.%${q}%,comment.ilike.%${q}%`,
    )
  }
  if (categories.length > 1) {
    qb = qb.in('category', categories)
  } else if (categories.length === 1) {
    qb = qb.eq('category', categories[0]!)
  } else if (categoryLegacy) {
    qb = qb.eq('category', categoryLegacy)
  }

  // dateFrom / dateTo: treat input as start/end of the calendar day in UTC.
  // Consumers that send Moscow-local dates should subtract 3 h on their side
  // (or just accept that the boundary is at midnight UTC).
  if (dateFrom) qb = qb.gte('expense_date', `${dateFrom}T00:00:00.000Z`)
  if (dateTo)   qb = qb.lte('expense_date', `${dateTo}T23:59:59.999Z`)

  const { data, error, count } = await qb
    .order('expense_date', { ascending: false })
    .range(offset, offset + limit - 1)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const response: ExpenseListResponse = {
    rows: (data ?? []) as Expense[],
    total: count ?? 0,
  }
  return NextResponse.json(response)
}

// ── POST /api/expenses ────────────────────────────────────────────────────────

export async function POST(request: NextRequest): Promise<NextResponse> {
  let body: unknown
  try { body = await request.json() } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const b = body as Partial<ExpenseCreate>

  // Validate required fields
  if (!b.expense_date) {
    return NextResponse.json({ error: 'expense_date is required' }, { status: 400 })
  }
  if (!b.category || !normStr(b.category)) {
    return NextResponse.json({ error: 'category is required' }, { status: 400 })
  }
  if (b.amount === undefined || b.amount === null) {
    return NextResponse.json({ error: 'amount is required' }, { status: 400 })
  }
  const amount = roundAmount(b.amount)

  let supabase
  try { supabase = createServerClient() } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }

  const newRow = {
    external_number: `MANUAL-${Date.now()}`,
    document_title:  'Ручной расход',
    expense_date:    b.expense_date,
    contractor:      normStr(b.contractor),
    comment:         normStr(b.comment),
    amount,
    category:        normStr(b.category)!,
    source:          'manual' as const,
    raw_row:         null,
  }

  const { data, error } = await supabase
    .from('expenses')
    .insert(newRow)
    .select()
    .single()

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json(data, { status: 201 })
}
