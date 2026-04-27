import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase/server'
import type { ParsedExpense } from '@/lib/expenses/parse-expenses-excel'

// ── Request / response types ──────────────────────────────────────────────────

type ConflictAction = {
  external_number: string
  incoming: ParsedExpense
  action: 'keep_current' | 'overwrite'
}

type CommitRequest = {
  newRows: ParsedExpense[]
  conflictRows: ConflictAction[]
}

type CommitError = {
  external_number?: string
  message: string
}

type CommitSummary = {
  inserted: number
  updated: number
  skipped: number
  errors: CommitError[]
}

// ── Normalisation helpers ─────────────────────────────────────────────────────

function normStr(v: string | null | undefined): string | null {
  if (v === null || v === undefined) return null
  const s = String(v).trim()
  return s.length > 0 ? s : null
}

function roundAmount(n: unknown): number {
  const num = typeof n === 'number' ? n : parseFloat(String(n))
  return isNaN(num) ? 0 : Math.round(num * 100) / 100
}

function toDbRow(row: ParsedExpense) {
  return {
    external_number: row.external_number,
    document_title: normStr(row.document_title),
    expense_date: row.expense_date,
    contractor: normStr(row.contractor),
    comment: normStr(row.comment),
    amount: roundAmount(row.amount),
    category: normStr(row.category),
    source: 'excel' as const,
    raw_row: row.raw_row ?? {},
  }
}

// ── Request validation ────────────────────────────────────────────────────────

function parseBody(body: unknown): CommitRequest | string {
  if (!body || typeof body !== 'object') return 'Request body must be a JSON object'
  const b = body as Record<string, unknown>
  if (!Array.isArray(b.newRows)) return '"newRows" must be an array'
  if (!Array.isArray(b.conflictRows)) return '"conflictRows" must be an array'
  for (const c of b.conflictRows as ConflictAction[]) {
    if (c.action !== 'keep_current' && c.action !== 'overwrite') {
      return `Invalid action "${c.action}" for ${c.external_number}`
    }
  }
  return { newRows: b.newRows as ParsedExpense[], conflictRows: b.conflictRows as ConflictAction[] }
}

// ── Handler ───────────────────────────────────────────────────────────────────

export async function POST(request: NextRequest): Promise<NextResponse> {
  // Parse body
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const parsed = parseBody(body)
  if (typeof parsed === 'string') {
    return NextResponse.json({ error: parsed }, { status: 400 })
  }
  const { newRows, conflictRows } = parsed

  // Init Supabase
  let supabase
  try {
    supabase = createServerClient()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: `Supabase init failed: ${msg}` }, { status: 500 })
  }

  const summary: CommitSummary = { inserted: 0, updated: 0, skipped: 0, errors: [] }

  // ── 1. Insert new rows (upsert — graceful fallback if preview was stale) ────
  if (newRows.length > 0) {
    const insertData = newRows.map(toDbRow)

    const { error: upsertError } = await supabase
      .from('expenses')
      .upsert(insertData, { onConflict: 'external_number' })

    if (upsertError) {
      // Batch failed — fall back to individual inserts so we can collect errors
      for (const row of insertData) {
        const { error } = await supabase
          .from('expenses')
          .upsert(row, { onConflict: 'external_number' })
        if (error) {
          summary.errors.push({ external_number: row.external_number, message: error.message })
        } else {
          summary.inserted++
        }
      }
    } else {
      summary.inserted = newRows.length
    }
  }

  // ── 2. Handle conflict rows ───────────────────────────────────────────────
  for (const conflict of conflictRows) {
    if (conflict.action === 'keep_current') {
      summary.skipped++
      continue
    }

    // overwrite — update existing row by external_number
    // Also clears deleted_at/deleted_reason so soft-deleted rows are restored.
    const dbRow = toDbRow(conflict.incoming)
    const { error } = await supabase
      .from('expenses')
      .update({
        document_title:  dbRow.document_title,
        expense_date:    dbRow.expense_date,
        contractor:      dbRow.contractor,
        comment:         dbRow.comment,
        amount:          dbRow.amount,
        category:        dbRow.category,
        source:          dbRow.source,
        raw_row:         dbRow.raw_row,
        deleted_at:      null,
        deleted_reason:  null,
        // updated_at is maintained by the DB trigger
      })
      .eq('external_number', conflict.external_number)

    if (error) {
      summary.errors.push({
        external_number: conflict.external_number,
        message: error.message,
      })
    } else {
      summary.updated++
    }
  }

  return NextResponse.json(summary)
}
