'use client'

import { useState, useEffect, useCallback, useRef, Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import Link from 'next/link'
import type { Expense, ExpenseListResponse } from '@/lib/expenses/types'
import { useCategories, type CategoryOption } from '@/lib/expenses/use-categories'

// ── Constants ─────────────────────────────────────────────────────────────────

const PAGE_SIZE = 100

// ── Types ─────────────────────────────────────────────────────────────────────

type Filters = {
  q: string
  /** Empty = все категории; один или несколько имён — фильтр (несколько из drill-down по группе). */
  categories: string[]
  dateFrom: string
  dateTo: string
}

type FormData = {
  expense_date: string
  contractor: string
  comment: string
  amount: string
  category: string
}

const EMPTY_FILTERS: Filters = { q: '', categories: [], dateFrom: '', dateTo: '' }
const EMPTY_FORM: FormData   = { expense_date: '', contractor: '', comment: '', amount: '', category: '' }

// ── Date helpers (Moscow = UTC+3) ─────────────────────────────────────────────

const MSK_OFFSET_MS = 3 * 60 * 60 * 1000

function isoToMoscowInput(iso: string): string {
  try {
    const ms = new Date(iso).getTime() + MSK_OFFSET_MS
    return new Date(ms).toISOString().slice(0, 16)
  } catch { return '' }
}

function moscowInputToIso(local: string): string {
  if (!local) return ''
  const [date, time] = local.split('T')
  const [y, mo, d]   = date.split('-').map(Number)
  const [h, mi]      = (time ?? '00:00').split(':').map(Number)
  return new Date(Date.UTC(y, mo - 1, d, h, mi, 0) - MSK_OFFSET_MS).toISOString()
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleString('ru-RU', {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
      timeZone: 'Europe/Moscow',
    })
  } catch { return iso }
}

function fmtAmount(n: number | null): string {
  if (n === null || n === undefined) return '—'
  return n.toLocaleString('ru-RU', { style: 'currency', currency: 'RUB', maximumFractionDigits: 2 })
}

// ── Page ─────────────────────────────────────────────────────────────────────

function ExpensesPageInner() {
  const searchParams = useSearchParams()
  const fromCats = searchParams.getAll('categories').map((s) => s.trim()).filter(Boolean)
  const legacyCat = searchParams.get('category')?.trim()
  const initialCategories = fromCats.length > 0 ? fromCats : legacyCat ? [legacyCat] : []

  const initialFilters: Filters = {
    q:          searchParams.get('q')        ?? '',
    categories: initialCategories,
    dateFrom:   searchParams.get('dateFrom') ?? '',
    dateTo:     searchParams.get('dateTo')   ?? '',
  }

  const { items: categoryItems } = useCategories()

  const [rows, setRows]     = useState<Expense[]>([])
  const [total, setTotal]   = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError]   = useState<string | null>(null)
  const [page, setPage]     = useState(0)

  const [filters, setFilters]       = useState<Filters>(initialFilters)
  const [appliedFilters, setApplied] = useState<Filters>(initialFilters)

  const [modalOpen, setModalOpen]     = useState(false)
  const [editing, setEditing]         = useState<Expense | null>(null)
  const [form, setForm]               = useState<FormData>(EMPTY_FORM)
  const [formError, setFormError]     = useState<string | null>(null)
  const [formLoading, setFormLoading] = useState(false)

  const [deleteTarget, setDeleteTarget]     = useState<Expense | null>(null)
  const [deleteReason, setDeleteReason]     = useState('')
  const [deleteLoading, setDeleteLoading]   = useState(false)
  const [deleteError, setDeleteError]       = useState<string | null>(null)

  const fetchExpenses = useCallback(async (f: Filters, p: number) => {
    setLoading(true)
    setError(null)
    const sp = new URLSearchParams()
    if (f.q) sp.set('q', f.q)
    if (f.categories.length > 1) for (const c of f.categories) sp.append('categories', c)
    else if (f.categories.length === 1) sp.set('category', f.categories[0]!)
    if (f.dateFrom) sp.set('dateFrom', f.dateFrom)
    if (f.dateTo)   sp.set('dateTo', f.dateTo)
    sp.set('limit',  String(PAGE_SIZE))
    sp.set('offset', String(p * PAGE_SIZE))
    try {
      const res  = await fetch(`/api/expenses?${sp}`)
      const data = await res.json() as ExpenseListResponse
      if (!res.ok) { setError((data as { error?: string }).error ?? `HTTP ${res.status}`); return }
      setRows(data.rows)
      setTotal(data.total)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка загрузки')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetchExpenses(appliedFilters, page) }, [appliedFilters, page, fetchExpenses])

  function applyFilters() { setPage(0); setApplied({ ...filters }) }
  function resetFilters() { setFilters(EMPTY_FILTERS); setPage(0); setApplied(EMPTY_FILTERS) }

  function setInstantFilter<K extends keyof Filters>(key: K, value: Filters[K]) {
    setFilters((prev) => ({ ...prev, [key]: value }))
    setApplied((prev) => { const next = { ...prev, [key]: value }; setPage(0); return next })
  }

  function openCreate() {
    setEditing(null); setForm(EMPTY_FORM); setFormError(null); setModalOpen(true)
  }

  function openEdit(expense: Expense) {
    setEditing(expense)
    setForm({
      expense_date: isoToMoscowInput(expense.expense_date),
      contractor:   expense.contractor ?? '',
      comment:      expense.comment ?? '',
      amount:       String(expense.amount),
      category:     expense.category ?? '',
    })
    setFormError(null)
    setModalOpen(true)
  }

  function closeModal() { setModalOpen(false); setEditing(null); setFormError(null) }

  function openDelete(expense: Expense) {
    setDeleteTarget(expense); setDeleteReason(''); setDeleteError(null)
  }
  function closeDelete() { setDeleteTarget(null); setDeleteReason(''); setDeleteError(null) }

  async function handleDelete() {
    if (!deleteTarget) return
    setDeleteLoading(true); setDeleteError(null)
    try {
      const res = await fetch(`/api/expenses/${deleteTarget.id}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deleted_reason: deleteReason || null }),
      })
      const data = await res.json()
      if (!res.ok) { setDeleteError((data as { error?: string }).error ?? `HTTP ${res.status}`); return }
      closeDelete()
      await fetchExpenses(appliedFilters, page)
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : 'Ошибка удаления')
    } finally {
      setDeleteLoading(false)
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setFormError(null)
    if (!form.expense_date) { setFormError('Укажите дату расхода'); return }
    if (!form.category)     { setFormError('Выберите категорию'); return }
    const amount = parseFloat(form.amount)
    if (isNaN(amount))      { setFormError('Сумма должна быть числом'); return }

    const body = {
      expense_date: moscowInputToIso(form.expense_date),
      contractor:   form.contractor || null,
      comment:      form.comment || null,
      amount,
      category:     form.category,
    }
    setFormLoading(true)
    try {
      const url    = editing ? `/api/expenses/${editing.id}` : '/api/expenses'
      const method = editing ? 'PATCH' : 'POST'
      const res    = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      const data   = await res.json()
      if (!res.ok) { setFormError((data as { error?: string }).error ?? `HTTP ${res.status}`); return }
      closeModal()
      await fetchExpenses(appliedFilters, page)
    } catch (e) {
      setFormError(e instanceof Error ? e.message : 'Ошибка сохранения')
    } finally {
      setFormLoading(false)
    }
  }

  const totalPages = Math.ceil(total / PAGE_SIZE)

  return (
    <main className="min-h-screen font-sans" style={{ background: 'var(--bg-primary)' }}>
      <div className="mx-auto max-w-screen-xl px-6 py-6 space-y-5">
        {/* ── Page header ── */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>Расходы</h1>
            {!loading && (
              <p className="mt-0.5 text-sm" style={{ color: 'var(--text-muted)' }}>
                {total.toLocaleString('ru-RU')} записей
              </p>
            )}
          </div>
          <div className="flex items-center gap-3">
            <Link
              href="/expenses/import"
              className="text-sm font-medium transition-colors"
              style={{ color: 'var(--text-secondary)' }}
            >
              Импорт Excel
            </Link>
            <button
              onClick={openCreate}
              className="flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold transition-colors"
              style={{
                background: 'var(--accent-primary)',
                color: 'var(--text-on-accent)',
              }}
              onMouseEnter={(e) => ((e.currentTarget as HTMLButtonElement).style.background = 'var(--accent-hover)')}
              onMouseLeave={(e) => ((e.currentTarget as HTMLButtonElement).style.background = 'var(--accent-primary)')}
            >
              <span className="text-lg leading-none">+</span> Добавить
            </button>
          </div>
        </div>

        {/* ── Filters ── */}
        <FilterBar
          filters={filters}
          onChange={setFilters}
          onInstant={setInstantFilter}
          onApply={applyFilters}
          onReset={resetFilters}
          categoryItems={categoryItems}
        />

        {/* ── Error ── */}
        {error && (
          <div
            className="rounded-xl px-5 py-3 text-sm"
            style={{
              background: 'var(--danger-bg)',
              border: '1px solid var(--danger-border)',
              color: 'var(--danger)',
            }}
          >
            {error}
          </div>
        )}

        {/* ── Table ── */}
        <div
          className="overflow-x-auto rounded-xl"
          style={{
            background: 'var(--table-bg)',
            border: '1px solid var(--table-border)',
            boxShadow: 'var(--shadow-sm)',
          }}
        >
          {loading ? (
            <div className="px-6 py-16 text-center text-sm" style={{ color: 'var(--text-muted)' }}>
              Загрузка…
            </div>
          ) : rows.length === 0 ? (
            <div className="px-6 py-16 text-center text-sm" style={{ color: 'var(--text-muted)' }}>
              Нет расходов
            </div>
          ) : (
            <table className="w-full text-left text-sm" style={{ color: 'var(--text-secondary)' }}>
              <thead style={{ borderBottom: '1px solid var(--table-border)', background: 'var(--table-header-bg)' }}>
                <tr>
                  <Th>Дата</Th>
                  <Th>Номер</Th>
                  <Th>Контрагент</Th>
                  <Th>Комментарий</Th>
                  <Th right>Сумма</Th>
                  <Th>Категория</Th>
                  <Th>Источник</Th>
                  <Th>Действие</Th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr
                    key={row.id}
                    className="transition-colors"
                    style={{ borderBottom: '1px solid var(--table-border)' }}
                    onMouseEnter={(e) => ((e.currentTarget as HTMLTableRowElement).style.background = 'var(--table-row-hover)')}
                    onMouseLeave={(e) => ((e.currentTarget as HTMLTableRowElement).style.background = '')}
                  >
                    <Td nowrap>{fmtDate(row.expense_date)}</Td>
                    <Td mono>{row.external_number}</Td>
                    <Td>{row.contractor ?? <Dash />}</Td>
                    <Td multiline>{row.comment ?? <Dash />}</Td>
                    <Td right mono>{fmtAmount(row.amount)}</Td>
                    <Td>
                      {row.category ? (
                        <CategoryBadge>
                          {categoryItems.find((x) => x.name === row.category)?.label ?? row.category}
                        </CategoryBadge>
                      ) : (
                        <Dash />
                      )}
                    </Td>
                    <Td><SourceBadge source={row.source} /></Td>
                    <Td>
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => openEdit(row)}
                          className="rounded-md px-3 py-1 text-xs font-medium transition-colors"
                          style={{
                            border: '1px solid var(--border-primary)',
                            color: 'var(--text-secondary)',
                          }}
                          onMouseEnter={(e) => {
                            ;(e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--accent-primary)'
                            ;(e.currentTarget as HTMLButtonElement).style.color = 'var(--accent-primary)'
                          }}
                          onMouseLeave={(e) => {
                            ;(e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--border-primary)'
                            ;(e.currentTarget as HTMLButtonElement).style.color = 'var(--text-secondary)'
                          }}
                        >
                          Изменить
                        </button>
                        <button
                          onClick={() => openDelete(row)}
                          className="rounded-md px-3 py-1 text-xs font-medium transition-colors"
                          style={{
                            border: '1px solid var(--danger-border)',
                            color: 'var(--danger)',
                          }}
                          onMouseEnter={(e) => {
                            ;(e.currentTarget as HTMLButtonElement).style.background = 'var(--danger-bg)'
                          }}
                          onMouseLeave={(e) => {
                            ;(e.currentTarget as HTMLButtonElement).style.background = ''
                          }}
                        >
                          Удалить
                        </button>
                      </div>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* ── Pagination ── */}
        {totalPages > 1 && (
          <Pagination
            page={page}
            totalPages={totalPages}
            total={total}
            pageSize={PAGE_SIZE}
            onChange={setPage}
          />
        )}
      </div>

      {/* ── Edit Modal ── */}
      {modalOpen && (
        <ExpenseModal
          editing={editing}
          form={form}
          onChange={setForm}
          onSubmit={handleSubmit}
          onClose={closeModal}
          loading={formLoading}
          error={formError}
          categoryItems={categoryItems}
        />
      )}

      {/* ── Delete Confirmation Modal ── */}
      {deleteTarget && (
        <DeleteModal
          expense={deleteTarget}
          reason={deleteReason}
          onReasonChange={setDeleteReason}
          onConfirm={handleDelete}
          onClose={closeDelete}
          loading={deleteLoading}
          error={deleteError}
        />
      )}
    </main>
  )
}

export default function ExpensesPage() {
  return (
    <Suspense fallback={<div className="min-h-screen" style={{ background: 'var(--bg-primary)' }} />}>
      <ExpensesPageInner />
    </Suspense>
  )
}

// ── FilterBar ─────────────────────────────────────────────────────────────────

function FilterBar({
  filters,
  onChange,
  onInstant,
  onApply,
  onReset,
  categoryItems,
}: {
  filters: Filters
  onChange: React.Dispatch<React.SetStateAction<Filters>>
  onInstant: <K extends keyof Filters>(k: K, v: Filters[K]) => void
  onApply: () => void
  onReset: () => void
  categoryItems: CategoryOption[]
}) {
  const hasFilters =
    Boolean(filters.q) ||
    filters.categories.length > 0 ||
    Boolean(filters.dateFrom) ||
    Boolean(filters.dateTo)

  return (
    <div
      className="flex flex-wrap items-end gap-3 rounded-xl p-4"
      style={{
        background: 'var(--bg-card)',
        border: '1px solid var(--border-primary)',
        boxShadow: 'var(--shadow-sm)',
      }}
    >
      <div className="flex flex-1 min-w-48 flex-col gap-1">
        <label className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>Поиск</label>
        <input
          type="text"
          placeholder="Номер, контрагент, комментарий…"
          value={filters.q}
          onChange={(e) => onChange((prev) => ({ ...prev, q: e.target.value }))}
          onKeyDown={(e) => e.key === 'Enter' && onApply()}
          className="rounded-lg px-3 py-2 text-sm outline-none transition-colors"
          style={{
            background: 'var(--input-bg)',
            border: '1px solid var(--input-border)',
            color: 'var(--input-text)',
          }}
          onFocus={(e) => (e.currentTarget.style.borderColor = 'var(--input-border-focus)')}
          onBlur={(e) => (e.currentTarget.style.borderColor = 'var(--input-border)')}
        />
      </div>

      <div className="flex flex-col gap-1">
        <label className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>Категория</label>
        <select
          value={filters.categories.length === 1 ? filters.categories[0]! : ''}
          onChange={(e) => onInstant('categories', e.target.value ? [e.target.value] : [])}
          className="rounded-lg px-3 py-2 text-sm outline-none transition-colors"
          style={{
            background: 'var(--input-bg)',
            border: '1px solid var(--input-border)',
            color: 'var(--input-text)',
          }}
          onFocus={(e) => (e.currentTarget.style.borderColor = 'var(--input-border-focus)')}
          onBlur={(e) => (e.currentTarget.style.borderColor = 'var(--input-border)')}
        >
          <option value="">Все категории</option>
          {categoryItems.map((c) => (
            <option key={c.name} value={c.name}>{c.label}</option>
          ))}
        </select>
      </div>

      <div className="flex flex-col gap-1">
        <label className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>Дата с</label>
        <input
          type="date"
          value={filters.dateFrom}
          onChange={(e) => onInstant('dateFrom', e.target.value)}
          className="rounded-lg px-3 py-2 text-sm outline-none transition-colors"
          style={{
            background: 'var(--input-bg)',
            border: '1px solid var(--input-border)',
            color: 'var(--input-text)',
          }}
          onFocus={(e) => (e.currentTarget.style.borderColor = 'var(--input-border-focus)')}
          onBlur={(e) => (e.currentTarget.style.borderColor = 'var(--input-border)')}
        />
      </div>

      <div className="flex flex-col gap-1">
        <label className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>по</label>
        <input
          type="date"
          value={filters.dateTo}
          onChange={(e) => onInstant('dateTo', e.target.value)}
          className="rounded-lg px-3 py-2 text-sm outline-none transition-colors"
          style={{
            background: 'var(--input-bg)',
            border: '1px solid var(--input-border)',
            color: 'var(--input-text)',
          }}
          onFocus={(e) => (e.currentTarget.style.borderColor = 'var(--input-border-focus)')}
          onBlur={(e) => (e.currentTarget.style.borderColor = 'var(--input-border)')}
        />
      </div>

      <button
        onClick={onApply}
        className="rounded-lg px-4 py-2 text-sm font-semibold transition-colors"
        style={{ background: 'var(--accent-primary)', color: 'var(--text-on-accent)' }}
        onMouseEnter={(e) => ((e.currentTarget as HTMLButtonElement).style.background = 'var(--accent-hover)')}
        onMouseLeave={(e) => ((e.currentTarget as HTMLButtonElement).style.background = 'var(--accent-primary)')}
      >
        Найти
      </button>
      {hasFilters && (
        <button
          onClick={onReset}
          className="rounded-lg px-4 py-2 text-sm transition-colors"
          style={{
            border: '1px solid var(--border-primary)',
            color: 'var(--text-secondary)',
          }}
          onMouseEnter={(e) => ((e.currentTarget as HTMLButtonElement).style.background = 'var(--bg-secondary)')}
          onMouseLeave={(e) => ((e.currentTarget as HTMLButtonElement).style.background = '')}
        >
          Сбросить
        </button>
      )}
    </div>
  )
}

// ── ExpenseModal ──────────────────────────────────────────────────────────────

function ExpenseModal({
  editing,
  form,
  onChange,
  onSubmit,
  onClose,
  loading,
  error,
  categoryItems,
}: {
  editing: Expense | null
  form: FormData
  onChange: React.Dispatch<React.SetStateAction<FormData>>
  onSubmit: (e: React.FormEvent) => void
  onClose: () => void
  loading: boolean
  error: string | null
  categoryItems: CategoryOption[]
}) {
  const overlayRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    function handleKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [onClose])

  function set<K extends keyof FormData>(key: K, value: FormData[K]) {
    onChange((prev) => ({ ...prev, [key]: value }))
  }

  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'var(--bg-overlay)' }}
      onClick={(e) => { if (e.target === overlayRef.current) onClose() }}
    >
      <div
        className="w-full max-w-lg rounded-2xl"
        style={{
          background: 'var(--modal-bg)',
          boxShadow: 'var(--shadow-lg)',
        }}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between px-6 py-4"
          style={{ borderBottom: '1px solid var(--border-primary)' }}
        >
          <h2 className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>
            {editing ? 'Редактировать расход' : 'Добавить расход'}
          </h2>
          <button
            onClick={onClose}
            className="text-xl leading-none transition-colors"
            style={{ color: 'var(--text-muted)' }}
            onMouseEnter={(e) => ((e.currentTarget as HTMLButtonElement).style.color = 'var(--text-primary)')}
            onMouseLeave={(e) => ((e.currentTarget as HTMLButtonElement).style.color = 'var(--text-muted)')}
          >
            ×
          </button>
        </div>

        {/* Form */}
        <form onSubmit={onSubmit} className="px-6 py-5 space-y-4">
          <Field label="Дата расхода *">
            <input
              type="datetime-local"
              required
              value={form.expense_date}
              onChange={(e) => set('expense_date', e.target.value)}
              className={INPUT_CLS}
              style={INPUT_STYLE}
              onFocus={INPUT_FOCUS}
              onBlur={INPUT_BLUR}
            />
            <p className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>Московское время</p>
          </Field>

          <Field label="Категория *">
            <select
              required
              value={form.category}
              onChange={(e) => set('category', e.target.value)}
              className={INPUT_CLS}
              style={INPUT_STYLE}
              onFocus={INPUT_FOCUS}
              onBlur={INPUT_BLUR}
            >
              <option value="">— выбрать —</option>
              {categoryItems.map((c) => (
                <option key={c.name} value={c.name}>{c.label}</option>
              ))}
            </select>
          </Field>

          <Field label="Сумма *">
            <input
              type="number"
              required
              step="0.01"
              placeholder="0.00"
              value={form.amount}
              onChange={(e) => set('amount', e.target.value)}
              className={INPUT_CLS}
              style={INPUT_STYLE}
              onFocus={INPUT_FOCUS}
              onBlur={INPUT_BLUR}
            />
          </Field>

          <Field label="Контрагент">
            <input
              type="text"
              placeholder="Название организации или ФИО"
              value={form.contractor}
              onChange={(e) => set('contractor', e.target.value)}
              className={INPUT_CLS}
              style={INPUT_STYLE}
              onFocus={INPUT_FOCUS}
              onBlur={INPUT_BLUR}
            />
          </Field>

          <Field label="Комментарий">
            <textarea
              rows={3}
              placeholder="За что платили…"
              value={form.comment}
              onChange={(e) => set('comment', e.target.value)}
              className={`${INPUT_CLS} resize-none`}
              style={INPUT_STYLE}
              onFocus={INPUT_FOCUS}
              onBlur={INPUT_BLUR}
            />
          </Field>

          {error && (
            <div
              className="rounded-lg px-4 py-3 text-sm"
              style={{
                background: 'var(--danger-bg)',
                border: '1px solid var(--danger-border)',
                color: 'var(--danger)',
              }}
            >
              {error}
            </div>
          )}

          {editing && (
            <div
              className="rounded-lg px-4 py-3 text-xs space-y-1"
              style={{ background: 'var(--bg-secondary)', color: 'var(--text-muted)' }}
            >
              <div><span className="font-medium" style={{ color: 'var(--text-secondary)' }}>Номер:</span> {editing.external_number}</div>
              <div><span className="font-medium" style={{ color: 'var(--text-secondary)' }}>Источник:</span> {editing.source ?? '—'}</div>
            </div>
          )}

          <div className="flex justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg px-4 py-2 text-sm transition-colors"
              style={{
                border: '1px solid var(--border-primary)',
                color: 'var(--text-secondary)',
              }}
              onMouseEnter={(e) => ((e.currentTarget as HTMLButtonElement).style.background = 'var(--bg-secondary)')}
              onMouseLeave={(e) => ((e.currentTarget as HTMLButtonElement).style.background = '')}
            >
              Отмена
            </button>
            <button
              type="submit"
              disabled={loading}
              className="rounded-lg px-5 py-2 text-sm font-semibold transition-colors disabled:opacity-50"
              style={{ background: 'var(--accent-primary)', color: 'var(--text-on-accent)' }}
              onMouseEnter={(e) => { if (!loading) (e.currentTarget as HTMLButtonElement).style.background = 'var(--accent-hover)' }}
              onMouseLeave={(e) => ((e.currentTarget as HTMLButtonElement).style.background = 'var(--accent-primary)')}
            >
              {loading ? 'Сохраняем…' : editing ? 'Сохранить' : 'Создать'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ── DeleteModal ───────────────────────────────────────────────────────────────

function DeleteModal({
  expense, reason, onReasonChange, onConfirm, onClose, loading, error,
}: {
  expense: Expense
  reason: string
  onReasonChange: (v: string) => void
  onConfirm: () => void
  onClose: () => void
  loading: boolean
  error: string | null
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'var(--overlay-bg)' }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div
        className="w-full max-w-md rounded-2xl p-6 space-y-5 shadow-xl"
        style={{ background: 'var(--bg-card)', border: '1px solid var(--border-primary)' }}
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-base font-bold" style={{ color: 'var(--text-primary)' }}>
              Удалить расход?
            </h2>
            <p className="mt-1 text-xs font-mono" style={{ color: 'var(--text-muted)' }}>
              {expense.external_number}
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-lg leading-none px-1"
            style={{ color: 'var(--text-muted)' }}
          >
            ×
          </button>
        </div>

        {/* Info row */}
        <div
          className="rounded-lg px-4 py-3 text-sm space-y-1"
          style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}
        >
          <div><span style={{ color: 'var(--text-muted)' }}>Дата:</span>{' '}
            <span style={{ color: 'var(--text-secondary)' }}>{fmtDate(expense.expense_date)}</span>
          </div>
          <div><span style={{ color: 'var(--text-muted)' }}>Категория:</span>{' '}
            <span style={{ color: 'var(--text-secondary)' }}>{expense.category ?? '—'}</span>
          </div>
          <div><span style={{ color: 'var(--text-muted)' }}>Сумма:</span>{' '}
            <span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{fmtAmount(expense.amount)}</span>
          </div>
        </div>

        {/* Reason */}
        <div className="space-y-1.5">
          <label className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>
            Причина удаления <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>(необязательно)</span>
          </label>
          <input
            type="text"
            placeholder="Ошибочный расход, дублирует …"
            value={reason}
            onChange={(e) => onReasonChange(e.target.value)}
            className={INPUT_CLS}
            style={INPUT_STYLE}
            onFocus={(e) => ((e.currentTarget as HTMLInputElement).style.borderColor = 'var(--input-border-focus)')}
            onBlur={(e) => ((e.currentTarget as HTMLInputElement).style.borderColor = 'var(--input-border)')}
          />
        </div>

        {/* Warning */}
        <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
          Расход будет скрыт из таблицы и P&L. Данные сохраняются в базе (soft-delete).
        </p>

        {/* Error */}
        {error && (
          <div
            className="rounded-lg px-4 py-3 text-sm"
            style={{ background: 'var(--danger-bg)', border: '1px solid var(--danger-border)', color: 'var(--danger)' }}
          >
            {error}
          </div>
        )}

        {/* Actions */}
        <div className="flex justify-end gap-3 pt-1">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-4 py-2 text-sm transition-colors"
            style={{ border: '1px solid var(--border-primary)', color: 'var(--text-secondary)' }}
            onMouseEnter={(e) => ((e.currentTarget as HTMLButtonElement).style.background = 'var(--bg-secondary)')}
            onMouseLeave={(e) => ((e.currentTarget as HTMLButtonElement).style.background = '')}
          >
            Отмена
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={loading}
            className="rounded-lg px-5 py-2 text-sm font-semibold transition-colors disabled:opacity-50"
            style={{ background: 'var(--danger)', color: '#fff' }}
            onMouseEnter={(e) => { if (!loading) (e.currentTarget as HTMLButtonElement).style.opacity = '0.85' }}
            onMouseLeave={(e) => ((e.currentTarget as HTMLButtonElement).style.opacity = '1')}
          >
            {loading ? 'Удаляем…' : 'Удалить'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Pagination ────────────────────────────────────────────────────────────────

function Pagination({ page, totalPages, total, pageSize, onChange }: {
  page: number; totalPages: number; total: number; pageSize: number; onChange: (p: number) => void
}) {
  const from = page * pageSize + 1
  const to   = Math.min((page + 1) * pageSize, total)
  return (
    <div className="flex items-center justify-between text-sm" style={{ color: 'var(--text-muted)' }}>
      <span>{from}–{to} из {total.toLocaleString('ru-RU')}</span>
      <div className="flex gap-2">
        <PagBtn disabled={page === 0} onClick={() => onChange(page - 1)}>← Назад</PagBtn>
        <span className="flex items-center px-3 py-1.5" style={{ color: 'var(--text-muted)' }}>
          {page + 1} / {totalPages}
        </span>
        <PagBtn disabled={page >= totalPages - 1} onClick={() => onChange(page + 1)}>Вперёд →</PagBtn>
      </div>
    </div>
  )
}

function PagBtn({ onClick, disabled, children }: {
  onClick: () => void; disabled: boolean; children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="rounded-lg px-3 py-1.5 text-sm transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
      style={{ border: '1px solid var(--border-primary)', color: 'var(--text-secondary)' }}
      onMouseEnter={(e) => { if (!disabled) (e.currentTarget as HTMLButtonElement).style.background = 'var(--bg-secondary)' }}
      onMouseLeave={(e) => ((e.currentTarget as HTMLButtonElement).style.background = '')}
    >
      {children}
    </button>
  )
}

// ── Shared style helpers ──────────────────────────────────────────────────────

const INPUT_CLS = 'w-full rounded-lg px-3 py-2 text-sm outline-none transition-colors'

const INPUT_STYLE: React.CSSProperties = {
  background: 'var(--input-bg)',
  border: '1px solid var(--input-border)',
  color: 'var(--input-text)',
}

const INPUT_FOCUS = (e: React.FocusEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
  e.currentTarget.style.borderColor = 'var(--input-border-focus)'
}

const INPUT_BLUR = (e: React.FocusEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
  e.currentTarget.style.borderColor = 'var(--input-border)'
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>{label}</label>
      {children}
    </div>
  )
}

function Th({ children, right }: { children: React.ReactNode; right?: boolean }) {
  return (
    <th
      className={`whitespace-nowrap px-4 py-3 text-xs font-semibold tracking-wide ${right ? 'text-right' : ''}`}
      style={{ color: 'var(--text-muted)' }}
    >
      {children}
    </th>
  )
}

function Td({
  children, mono, right, nowrap, truncate, multiline,
}: {
  children: React.ReactNode
  mono?: boolean
  right?: boolean
  nowrap?: boolean
  truncate?: boolean
  /** Полный текст с переносами (колонка «Комментарий»). */
  multiline?: boolean
}) {
  return (
    <td className={[
      'px-4 py-3',
      multiline ? 'align-top max-w-lg break-words whitespace-pre-wrap' : 'align-middle',
      mono    ? 'font-mono text-xs' : '',
      right   ? 'text-right' : '',
      nowrap  ? 'whitespace-nowrap' : '',
      truncate ? 'max-w-xs truncate' : '',
    ].filter(Boolean).join(' ')}>
      {children}
    </td>
  )
}

function Dash() {
  return <span style={{ color: 'var(--border-secondary)' }}>—</span>
}

function CategoryBadge({ children }: { children: string }) {
  return (
    <span
      className="inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium"
      style={{
        background: 'var(--accent-soft)',
        color: 'var(--accent-primary)',
      }}
    >
      {children}
    </span>
  )
}

function SourceBadge({ source }: { source: string | null }) {
  if (!source) return <Dash />
  const styles: Record<string, React.CSSProperties> = {
    excel:  { background: 'var(--success-bg)', color: 'var(--success)' },
    manual: { background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' },
  }
  const style = styles[source] ?? { background: 'var(--bg-tertiary)', color: 'var(--text-muted)' }
  return (
    <span className="inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium" style={style}>
      {source}
    </span>
  )
}
