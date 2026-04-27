'use client'

import { useState, useEffect } from 'react'
import { EXPENSE_CATEGORIES } from './categories'

export type CategoryOption = { name: string; label: string }

const FALLBACK: CategoryOption[] = EXPENSE_CATEGORIES.map((n) => ({
  name: n as string,
  label: n as string,
}))

/**
 * Активные категории из /api/expense-categories.
 * name — значение в БД / фильтрах; label — отображаемое имя (display_name или name).
 */
export function useCategories(): { items: CategoryOption[]; loading: boolean } {
  const [items, setItems]   = useState<CategoryOption[]>(FALLBACK)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false

    fetch('/api/expense-categories')
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json() as Promise<{
          rows: Array<{ name: string; display_name: string | null }>
        }>
      })
      .then(({ rows }) => {
        if (!cancelled && rows.length > 0) {
          setItems(
            rows.map((r) => ({
              name: r.name,
              label: (r.display_name && r.display_name.trim()) || r.name,
            })),
          )
        }
      })
      .catch(() => { /* оставляем FALLBACK */ })
      .finally(() => { if (!cancelled) setLoading(false) })

    return () => { cancelled = true }
  }, [])

  return { items, loading }
}
