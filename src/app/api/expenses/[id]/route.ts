import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase/server'
import type { ExpenseUpdate } from '@/lib/expenses/types'

function normStr(v: unknown): string | null {
  if (v === null || v === undefined) return null
  const s = String(v).trim()
  return s.length > 0 ? s : null
}

function roundAmount(v: unknown): number {
  const n = typeof v === 'number' ? v : parseFloat(String(v))
  return isNaN(n) ? 0 : Math.round(n * 100) / 100
}

// ── PATCH /api/expenses/[id] ──────────────────────────────────────────────────

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params

  if (!id) {
    return NextResponse.json({ error: 'id is required' }, { status: 400 })
  }

  let body: unknown
  try { body = await request.json() } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const b = body as Partial<ExpenseUpdate>

  const patch: Record<string, unknown> = {}

  if ('expense_date' in b && b.expense_date) patch.expense_date = b.expense_date
  if ('contractor'   in b)                    patch.contractor   = normStr(b.contractor)
  if ('comment'      in b)                    patch.comment      = normStr(b.comment)
  if ('amount'       in b && b.amount !== undefined) {
    const a = roundAmount(b.amount)
    if (a !== undefined) patch.amount = a
  }
  if ('category' in b) {
    const cat = normStr(b.category)
    if (!cat) {
      return NextResponse.json({ error: 'category cannot be empty' }, { status: 400 })
    }
    patch.category = cat
  }

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: 'No updatable fields provided' }, { status: 400 })
  }

  let supabase
  try { supabase = createServerClient() } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }

  // Guard: reject edits on soft-deleted rows
  const { data: existing, error: fetchErr } = await supabase
    .from('expenses')
    .select('deleted_at')
    .eq('id', id)
    .single()

  if (fetchErr || !existing) {
    return NextResponse.json({ error: 'Expense not found' }, { status: 404 })
  }
  if (existing.deleted_at !== null) {
    return NextResponse.json(
      { error: 'Нельзя редактировать удалённый расход' },
      { status: 400 },
    )
  }

  const { data, error } = await supabase
    .from('expenses')
    .update(patch)
    .eq('id', id)
    .select()
    .single()

  if (error) {
    if (error.code === 'PGRST116') {
      return NextResponse.json({ error: 'Expense not found' }, { status: 404 })
    }
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json(data)
}

// ── DELETE /api/expenses/[id] (soft-delete) ───────────────────────────────────

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params

  if (!id) {
    return NextResponse.json({ error: 'id is required' }, { status: 400 })
  }

  let deleted_reason: string | null = null
  try {
    const body = await request.json() as { deleted_reason?: string }
    deleted_reason = normStr(body?.deleted_reason)
  } catch {
    // body is optional — ignore parse errors
  }

  let supabase
  try { supabase = createServerClient() } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }

  const { error } = await supabase
    .from('expenses')
    .update({ deleted_at: new Date().toISOString(), deleted_reason })
    .eq('id', id)
    .is('deleted_at', null) // idempotent: only mark if not already deleted

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ ok: true })
}
