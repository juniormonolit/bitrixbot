/** Full row as stored in public.expenses. */
export type Expense = {
  id: string
  external_number: string
  document_title: string | null
  expense_date: string          // UTC ISO-8601
  contractor: string | null
  comment: string | null
  amount: number
  category: string | null
  source: string | null
  raw_row: Record<string, unknown> | null
  created_at: string
  updated_at: string
  deleted_at: string | null
  deleted_reason: string | null
}

/** Body for POST /api/expenses (manual creation). */
export type ExpenseCreate = {
  expense_date: string          // UTC ISO-8601
  contractor?: string | null
  comment?: string | null
  amount: number
  category: string
}

/** Body for PATCH /api/expenses/:id. */
export type ExpenseUpdate = Partial<
  Pick<Expense, 'expense_date' | 'contractor' | 'comment' | 'amount' | 'category'>
>

/** Query params for GET /api/expenses. */
export type ExpenseListParams = {
  q?: string           // ilike search: external_number | contractor | comment
  category?: string
  dateFrom?: string    // YYYY-MM-DD, inclusive
  dateTo?: string      // YYYY-MM-DD, inclusive (end of day)
  limit?: number       // default 100, max 500
  offset?: number      // default 0
}

/** Response from GET /api/expenses. */
export type ExpenseListResponse = {
  rows: Expense[]
  total: number
}
