import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase/server'

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/** PATCH /api/expense-categories/[id] — только display_name (пустая строка → сброс) */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params
  if (!id || !UUID_RE.test(id)) {
    return NextResponse.json({ error: 'Invalid category id' }, { status: 400 })
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const b = body as { display_name?: unknown }
  if (!('display_name' in b)) {
    return NextResponse.json({ error: 'display_name is required' }, { status: 400 })
  }

  const raw = b.display_name
  let displayName: string | null
  if (raw === null || raw === undefined) {
    displayName = null
  } else if (typeof raw === 'string') {
    const t = raw.trim()
    displayName = t.length ? t.slice(0, 200) : null
  } else {
    return NextResponse.json({ error: 'display_name must be string or null' }, { status: 400 })
  }

  let supabase
  try {
    supabase = createServerClient()
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }

  const { data, error } = await supabase
    .from('expense_categories')
    .update({ display_name: displayName, updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('is_active', true)
    .select('id, name, display_name, sort_order')
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!data) return NextResponse.json({ error: 'Category not found' }, { status: 404 })

  return NextResponse.json({ row: data })
}
