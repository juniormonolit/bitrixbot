import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase/server'

export type CategoryRow = {
  id: string
  name: string
  display_name: string | null
  sort_order: number
}

export type CategoriesResponse = {
  rows: CategoryRow[]
}

export async function GET(): Promise<NextResponse> {
  let supabase
  try { supabase = createServerClient() } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }

  const { data, error } = await supabase
    .from('expense_categories')
    .select('id, name, display_name, sort_order')
    .eq('is_active', true)
    .order('sort_order', { ascending: true })
    .order('name', { ascending: true })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ rows: data ?? [] } satisfies CategoriesResponse)
}
