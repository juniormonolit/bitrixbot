import { NextRequest, NextResponse } from 'next/server'
import { parseExpensesExcel } from '@/lib/expenses/parse-expenses-excel'

const ALLOWED_TYPES = [
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // .xlsx
  'application/vnd.ms-excel',                                           // .xls
  'application/octet-stream',                                           // some browsers send this
]

function hasExcelExtension(name: string): boolean {
  return /\.(xlsx|xls)$/i.test(name)
}

export async function POST(request: NextRequest): Promise<NextResponse> {
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
    return NextResponse.json(
      { error: 'Field "file" is required' },
      { status: 400 },
    )
  }

  if (!hasExcelExtension(file.name) && !ALLOWED_TYPES.includes(file.type)) {
    return NextResponse.json(
      { error: `Unsupported file type: "${file.name}". Upload an .xlsx or .xls file.` },
      { status: 400 },
    )
  }

  let rows
  try {
    const arrayBuffer = await file.arrayBuffer()
    const buffer = Buffer.from(arrayBuffer)
    rows = parseExpensesExcel(buffer)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json(
      { error: `Failed to parse Excel file: ${message}` },
      { status: 500 },
    )
  }

  const summary = {
    totalRows: rows.length,
    parsedRows: rows.length,
    skippedRows: 0, // rows without external_number/date are already excluded by the parser
    withoutCategory: rows.filter((r) => r.category === null).length,
    totalAmount: rows.reduce((sum, r) => sum + r.amount, 0),
  }

  return NextResponse.json({ rows, summary })
}
