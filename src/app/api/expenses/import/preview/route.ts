import { NextRequest, NextResponse } from 'next/server'
import { parseExpensesExcel } from '@/lib/expenses/parse-expenses-excel'
import { buildPreviewResult, type DbExpense } from '@/lib/expenses/compare-expenses'
import { createServerClient } from '@/lib/supabase/server'

const ALLOWED_EXTENSIONS = /\.(xlsx|xls)$/i
const ALLOWED_MIME = new Set([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'application/octet-stream',
])

export async function POST(request: NextRequest): Promise<NextResponse> {
  // ── 1. Parse multipart form ──────────────────────────────────────────────
  let formData: FormData
  try {
    formData = await request.formData()
  } catch {
    return NextResponse.json(
      { error: 'Invalid multipart/form-data request' },
      { status: 400 },
    )
  }

  const file = formData.get('file')
  if (!file || !(file instanceof File)) {
    return NextResponse.json({ error: 'Field "file" is required' }, { status: 400 })
  }

  if (!ALLOWED_EXTENSIONS.test(file.name) && !ALLOWED_MIME.has(file.type)) {
    return NextResponse.json(
      { error: `Unsupported file: "${file.name}". Upload an .xlsx or .xls file.` },
      { status: 400 },
    )
  }

  // ── 2. Parse Excel ───────────────────────────────────────────────────────
  let incoming
  try {
    const buf = Buffer.from(await file.arrayBuffer())
    incoming = parseExpensesExcel(buf)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: `Excel parse failed: ${msg}` }, { status: 500 })
  }

  if (incoming.length === 0) {
    return NextResponse.json(
      { error: 'No parseable expense rows found in the file' },
      { status: 400 },
    )
  }

  // ── 3. Fetch existing records from Supabase ──────────────────────────────
  const externalNumbers = incoming.map((r) => r.external_number)

  let supabase
  try {
    supabase = createServerClient()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: `Supabase init failed: ${msg}` }, { status: 500 })
  }

  const { data: existing, error: dbError } = await supabase
    .from('expenses')
    .select(
      'id, external_number, document_title, expense_date, contractor, comment, amount, category, source, deleted_at',
    )
    .in('external_number', externalNumbers)

  if (dbError) {
    return NextResponse.json(
      { error: `DB query failed: ${dbError.message}` },
      { status: 500 },
    )
  }

  // ── 4. Build diff ────────────────────────────────────────────────────────
  const existingByNumber = new Map<string, DbExpense>(
    (existing ?? []).map((row) => [row.external_number, row as DbExpense]),
  )

  const result = buildPreviewResult(incoming, existingByNumber)

  return NextResponse.json(result)
}
