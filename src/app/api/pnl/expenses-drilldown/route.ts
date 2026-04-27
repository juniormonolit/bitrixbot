import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase/server'
import type { Expense } from '@/lib/expenses/types'

const NO_CATEGORY = 'Без категории'
const MSK_OFFSET_MS = 3 * 60 * 60 * 1000

/** Start of a Moscow calendar month → UTC ISO. */
function moscowMonthStart(year: number, month: number): string {
  return new Date(Date.UTC(year, month - 1, 1) - MSK_OFFSET_MS).toISOString()
}

/** Start of next Moscow calendar month → UTC ISO. */
function moscowMonthEnd(year: number, month: number): string {
  return new Date(Date.UTC(year, month, 1) - MSK_OFFSET_MS).toISOString()
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const sp      = request.nextUrl.searchParams
  const allTime = sp.get('allTime') === '1' || sp.get('all_time') === '1'
  const yearRaw = sp.get('year')
  const year    = parseInt(yearRaw ?? String(new Date().getFullYear()), 10)
  const month   = sp.get('month') // "2026-01" | null
  const categories = sp
    .getAll('category')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)

  if (!allTime && (isNaN(year) || year < 2000 || year > 2100)) {
    return NextResponse.json({ error: 'Invalid year' }, { status: 400 })
  }

  let supabase
  try { supabase = createServerClient() } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }

  let qb = supabase
    .from('expenses')
    .select<'*', Expense>('*')
    .is('deleted_at', null)
    .order('expense_date', { ascending: false })

  // Date filter — use Moscow-aware boundaries for month, plain UTC for year, or no bounds for all-time
  if (month) {
    const [y, m] = month.split('-').map(Number)
    qb = qb
      .gte('expense_date', moscowMonthStart(y, m))
      .lt( 'expense_date', moscowMonthEnd(y, m))
  } else if (!allTime) {
    qb = qb
      .gte('expense_date', `${year}-01-01T00:00:00.000Z`)
      .lt( 'expense_date', `${year + 1}-01-01T00:00:00.000Z`)
  }

  // Category filter: repeated `category` = one or many DB category names
  if (categories.length === 1) {
    const category = categories[0]!
    if (category === NO_CATEGORY) {
      qb = qb.or('category.is.null,category.eq.')
    } else {
      qb = qb.eq('category', category)
    }
  } else if (categories.length > 1) {
    const rest = categories.filter((c) => c !== NO_CATEGORY)
    const needsUncat = categories.includes(NO_CATEGORY)
    if (needsUncat && rest.length > 0) {
      qb = qb.or(`category.in.(${rest.join(',')}),category.is.null,category.eq.`)
    } else if (needsUncat) {
      qb = qb.or('category.is.null,category.eq.')
    } else {
      qb = qb.in('category', rest)
    }
  }

  const { data, error } = await qb

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const rows       = (data ?? []) as Expense[]
  const totalAmount = rows.reduce((s, r) => s + Number(r.amount), 0)

  return NextResponse.json({ rows, totalAmount, count: rows.length })
}
