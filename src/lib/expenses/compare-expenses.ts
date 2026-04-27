import type { ParsedExpense } from './parse-expenses-excel'

/** A row as it currently exists in the DB. */
export type DbExpense = {
  id: string
  external_number: string
  document_title: string | null
  expense_date: string   // ISO string as returned by Supabase (UTC)
  contractor: string | null
  comment: string | null
  amount: number
  category: string | null
  source: string | null
  deleted_at: string | null
}

export type FieldChange<T> = { old: T | null; new: T | null }

export type ExpenseChanges = {
  expense_date?: FieldChange<string>
  contractor?: FieldChange<string>
  comment?: FieldChange<string>
  amount?: FieldChange<number>
  category?: FieldChange<string>
}

export type ConflictRow = {
  external_number: string
  current: DbExpense
  incoming: ParsedExpense
  changes: ExpenseChanges
  /** true when the existing DB row was soft-deleted */
  deleted: boolean
}

export type PreviewResult = {
  newRows: ParsedExpense[]
  unchangedRows: ParsedExpense[]
  conflictRows: ConflictRow[]
  rowsWithoutCategory: ParsedExpense[]
  summary: {
    total: number
    new: number
    unchanged: number
    conflicts: number
    withoutCategory: number
    totalAmount: number
  }
}

// ---------------------------------------------------------------------------
// Normalisation helpers
// ---------------------------------------------------------------------------

/** Round to 2 decimal places — same precision as numeric(14,2) in Postgres. */
function roundAmount(n: number): number {
  return Math.round(n * 100) / 100
}

/** Trim and coerce empty string to null. */
function normStr(v: string | null | undefined): string | null {
  if (v === null || v === undefined) return null
  const s = v.trim()
  return s.length > 0 ? s : null
}

/**
 * Normalise a timestamptz value to a comparable UTC ISO string.
 * Supabase may return "2026-01-16T07:11:35+00:00" or "2026-01-16T07:11:35.000Z".
 * We convert both to the "Z" form so string comparison works.
 */
function normDate(iso: string | null | undefined): string | null {
  if (!iso) return null
  try {
    return new Date(iso).toISOString()
  } catch {
    return iso ?? null
  }
}

// ---------------------------------------------------------------------------
// Core comparison
// ---------------------------------------------------------------------------

export function compareExpense(
  current: DbExpense,
  incoming: ParsedExpense,
): ExpenseChanges {
  const changes: ExpenseChanges = {}

  const oldDate = normDate(current.expense_date)
  const newDate = normDate(incoming.expense_date)
  if (oldDate !== newDate) {
    changes.expense_date = { old: oldDate, new: newDate }
  }

  const oldContractor = normStr(current.contractor)
  const newContractor = normStr(incoming.contractor)
  if (oldContractor !== newContractor) {
    changes.contractor = { old: oldContractor, new: newContractor }
  }

  const oldComment = normStr(current.comment)
  const newComment = normStr(incoming.comment)
  if (oldComment !== newComment) {
    changes.comment = { old: oldComment, new: newComment }
  }

  const oldAmount = roundAmount(Number(current.amount))
  const newAmount = roundAmount(incoming.amount)
  if (oldAmount !== newAmount) {
    changes.amount = { old: oldAmount, new: newAmount }
  }

  const oldCategory = normStr(current.category)
  const newCategory = normStr(incoming.category)
  if (oldCategory !== newCategory) {
    changes.category = { old: oldCategory, new: newCategory }
  }

  return changes
}

// ---------------------------------------------------------------------------
// High-level diff builder
// ---------------------------------------------------------------------------

export function buildPreviewResult(
  incoming: ParsedExpense[],
  existingByNumber: Map<string, DbExpense>,
): PreviewResult {
  const newRows: ParsedExpense[] = []
  const unchangedRows: ParsedExpense[] = []
  const conflictRows: ConflictRow[] = []

  for (const row of incoming) {
    const current = existingByNumber.get(row.external_number)

    if (!current) {
      newRows.push(row)
      continue
    }

    const isDeleted = current.deleted_at !== null

    // Soft-deleted records always surface as conflicts so the user can decide
    // to restore (overwrite) or skip them.
    if (isDeleted) {
      conflictRows.push({
        external_number: row.external_number,
        current,
        incoming: row,
        changes: compareExpense(current, row),
        deleted: true,
      })
      continue
    }

    const changes = compareExpense(current, row)

    if (Object.keys(changes).length === 0) {
      unchangedRows.push(row)
    } else {
      conflictRows.push({
        external_number: row.external_number,
        current,
        incoming: row,
        changes,
        deleted: false,
      })
    }
  }

  const allRows = [...newRows, ...unchangedRows, ...conflictRows.map((c) => c.incoming)]
  const rowsWithoutCategory = allRows.filter((r) => r.category === null)
  const totalAmount = incoming.reduce((s, r) => s + r.amount, 0)

  return {
    newRows,
    unchangedRows,
    conflictRows,
    rowsWithoutCategory,
    summary: {
      total: incoming.length,
      new: newRows.length,
      unchanged: unchangedRows.length,
      conflicts: conflictRows.length,
      withoutCategory: rowsWithoutCategory.length,
      totalAmount,
    },
  }
}
