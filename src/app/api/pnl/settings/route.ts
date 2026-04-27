import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase/server'

export type SettingRow = {
  key: string
  value: number
  label: string
  description: string | null
}

export async function GET(): Promise<NextResponse> {
  let supabase
  try { supabase = createServerClient() } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }

  const { data, error } = await supabase
    .from('pnl_settings')
    .select('key, value, label, description')
    .order('key')

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ settings: (data ?? []).map((r) => ({ ...r, value: Number(r.value) })) })
}

export async function PUT(request: NextRequest): Promise<NextResponse> {
  const { key, value } = (await request.json()) as { key: string; value: number }

  if (!key || typeof value !== 'number' || isNaN(value)) {
    return NextResponse.json({ error: 'key and numeric value required' }, { status: 400 })
  }

  let supabase
  try { supabase = createServerClient() } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }

  const { error } = await supabase
    .from('pnl_settings')
    .update({ value, updated_at: new Date().toISOString() })
    .eq('key', key)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ ok: true })
}
