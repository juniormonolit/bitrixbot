'use client'

import { useState, useRef } from 'react'
import Link from 'next/link'
import type { ParsedExpense } from '@/lib/expenses/parse-expenses-excel'
import type { ConflictRow, PreviewResult } from '@/lib/expenses/compare-expenses'
import { EXPENSE_CATEGORIES } from '@/lib/expenses/categories'
import { useCategories, type CategoryOption } from '@/lib/expenses/use-categories'

// ── Local types ───────────────────────────────────────────────────────────────

type ParsePreviewResult = {
  rows: ParsedExpense[]
  summary: {
    totalRows: number
    parsedRows: number
    skippedRows: number
    withoutCategory: number
    totalAmount: number
  }
}

type CommitSummary = {
  inserted: number
  updated: number
  skipped: number
  errors: Array<{ external_number?: string; message: string }>
}

type ConflictActionValue = 'keep_current' | 'overwrite'

/** Hard cap for the preview tables — prevents browser freeze on huge files. */
const PREVIEW_LIMIT = 500

// ── Steps ─────────────────────────────────────────────────────────────────────

const STEPS = [
  { n: 1, text: 'Загрузите Excel-файл с расходами' },
  { n: 2, text: 'Проверьте новые строки и конфликты с базой' },
  { n: 3, text: 'Заполните отсутствующие категории' },
  { n: 4, text: 'Нажмите «Импортировать расходы»' },
]

// ── Page ─────────────────────────────────────────────────────────────────────

export default function ImportPage() {
  const inputRef = useRef<HTMLInputElement>(null)

  const [loading, setLoading] = useState<'parse' | 'db' | 'commit' | null>(null)
  const [error, setError]     = useState<string | null>(null)

  const [parseResult, setParseResult]   = useState<ParsePreviewResult | null>(null)
  const [dbResult, setDbResult]         = useState<PreviewResult | null>(null)
  const [commitSummary, setCommitSummary] = useState<CommitSummary | null>(null)

  const { items: categoryItems } = useCategories()

  const [newCategories, setNewCategories]             = useState<Record<string, string>>({})
  const [conflictActions, setConflictActions]         = useState<Record<string, ConflictActionValue>>({})
  const [conflictCategories, setConflictCategories]   = useState<Record<string, string>>({})
  const [saveAttempted, setSaveAttempted]             = useState(false)

  function getFile(): File | null {
    const f = inputRef.current?.files?.[0] ?? null
    if (!f) setError('Выберите файл')
    return f
  }

  async function callFileEndpoint<T>(url: string, file: File): Promise<T | null> {
    const fd = new FormData()
    fd.append('file', file)
    try {
      const res  = await fetch(url, { method: 'POST', body: fd })
      const data = await res.json()
      if (!res.ok) { setError(data.error ?? `HTTP ${res.status}`); return null }
      return data as T
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Неизвестная ошибка')
      return null
    }
  }

  function applyDbResult(result: PreviewResult) {
    const actions: Record<string, ConflictActionValue> = {}
    for (const c of result.conflictRows) actions[c.external_number] = 'keep_current'
    setConflictActions(actions)
    setNewCategories({})
    setConflictCategories({})
    setSaveAttempted(false)
    setCommitSummary(null)
    setDbResult(result)
  }

  async function runDbPreview(file: File) {
    setLoading('db')
    setError(null)
    setParseResult(null)
    const data = await callFileEndpoint<PreviewResult>('/api/expenses/import/preview', file)
    if (data) applyDbResult(data)
    setLoading(null)
  }

  async function handleParse(e: React.FormEvent) {
    e.preventDefault()
    const file = getFile(); if (!file) return
    setLoading('parse'); setError(null); setParseResult(null); setDbResult(null); setCommitSummary(null)
    const data = await callFileEndpoint<ParsePreviewResult>('/api/expenses/import/parse-preview', file)
    if (data) setParseResult(data)
    setLoading(null)
  }

  async function handleDbPreview(e: React.FormEvent) {
    e.preventDefault()
    const file = getFile(); if (!file) return
    await runDbPreview(file)
  }

  function getValidationErrors(): string[] {
    if (!dbResult) return []
    const errs: string[] = []
    for (const row of dbResult.newRows) {
      if (row.category === null && !newCategories[row.external_number])
        errs.push(`Нужна категория: ${row.external_number}`)
    }
    for (const c of dbResult.conflictRows) {
      const action = conflictActions[c.external_number] ?? 'keep_current'
      if (action === 'overwrite' && c.incoming.category === null && !conflictCategories[c.external_number])
        errs.push(`Нужна категория для перезаписи: ${c.external_number}`)
    }
    return errs
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault()
    setSaveAttempted(true)
    const validationErrors = getValidationErrors()
    if (validationErrors.length > 0) { setError(`Заполните категории перед импортом (${validationErrors.length})`); return }
    if (!dbResult) return

    const newRows: ParsedExpense[] = dbResult.newRows.map((row) => ({
      ...row,
      category: newCategories[row.external_number] ?? row.category,
    }))

    const conflictRowsPayload = dbResult.conflictRows.map((c) => ({
      external_number: c.external_number,
      incoming: {
        ...c.incoming,
        category: conflictActions[c.external_number] === 'overwrite'
          ? (conflictCategories[c.external_number] ?? c.incoming.category)
          : c.incoming.category,
      },
      action: conflictActions[c.external_number] ?? 'keep_current',
    }))

    setLoading('commit')
    setError(null)
    try {
      const res  = await fetch('/api/expenses/import/commit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newRows, conflictRows: conflictRowsPayload }),
      })
      const data = await res.json()
      if (!res.ok) { setError(data.error ?? `HTTP ${res.status}`); return }
      setCommitSummary(data as CommitSummary)
      const file = inputRef.current?.files?.[0]
      if (file) await runDbPreview(file)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка при импорте')
    } finally {
      setLoading(null)
    }
  }

  const canSave          = dbResult && (dbResult.newRows.length > 0 || dbResult.conflictRows.length > 0)
  const validationErrors = saveAttempted ? getValidationErrors() : []

  // Derived: which step is the user on?
  const activeStep = !dbResult ? 1 : validationErrors.length > 0 ? 3 : canSave ? 4 : 2

  return (
    <main className="min-h-screen font-sans" style={{ background: 'var(--bg-primary)' }}>
      <div className="mx-auto max-w-7xl px-6 py-6 space-y-6">

        {/* ── Title + Steps ── */}
        <div className="flex flex-col gap-5 sm:flex-row sm:items-start sm:gap-10">
          <div className="shrink-0">
            <h1 className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>
              Импорт расходов
            </h1>
            <p className="mt-1 text-sm" style={{ color: 'var(--text-muted)' }}>
              Загрузка данных из Excel в базу
            </p>
          </div>

          {/* Steps indicator */}
          <ol className="flex flex-wrap gap-3">
            {STEPS.map((s) => {
              const isCurrent = s.n === activeStep
              const isDone    = s.n < activeStep
              return (
                <li key={s.n} className="flex items-center gap-2">
                  <span
                    className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold"
                    style={
                      isDone
                        ? { background: 'var(--success)', color: '#fff' }
                        : isCurrent
                        ? { background: 'var(--accent-primary)', color: 'var(--text-on-accent)' }
                        : { background: 'var(--bg-tertiary)', color: 'var(--text-muted)' }
                    }
                  >
                    {isDone ? '✓' : s.n}
                  </span>
                  <span
                    className="text-xs"
                    style={{ color: isCurrent ? 'var(--text-primary)' : 'var(--text-muted)' }}
                  >
                    {s.text}
                  </span>
                  {s.n < STEPS.length && (
                    <span className="ml-1 hidden sm:inline" style={{ color: 'var(--border-secondary)' }}>›</span>
                  )}
                </li>
              )
            })}
          </ol>
        </div>

        {/* ── Upload panel ── */}
        <div
          className="flex flex-wrap items-center gap-4 rounded-xl p-5"
          style={{
            background: 'var(--bg-card)',
            border: '1px solid var(--border-primary)',
            boxShadow: 'var(--shadow-sm)',
          }}
        >
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>
              Excel-файл (.xlsx, .xls)
            </label>
            <input
              ref={inputRef}
              type="file"
              accept=".xlsx,.xls"
              className="block text-sm file:mr-4 file:rounded-lg file:border-0 file:px-4 file:py-2 file:text-sm file:font-medium file:cursor-pointer"
              style={{ color: 'var(--text-secondary)' }}
            />
          </div>

          <div className="flex flex-wrap items-center gap-3 sm:ml-auto">
            <button
              onClick={handleParse}
              disabled={loading !== null}
              title="Показать содержимое файла без обращения к базе"
              className="rounded-lg px-4 py-2 text-sm font-medium transition-colors disabled:opacity-50"
              style={{
                background: 'var(--bg-secondary)',
                border: '1px solid var(--border-primary)',
                color: 'var(--text-secondary)',
              }}
              onMouseEnter={(e) => { if (!loading) (e.currentTarget as HTMLButtonElement).style.background = 'var(--bg-tertiary)' }}
              onMouseLeave={(e) => ((e.currentTarget as HTMLButtonElement).style.background = 'var(--bg-secondary)')}
            >
              {loading === 'parse' ? 'Читаем файл…' : 'Проверить файл'}
            </button>
            <button
              onClick={handleDbPreview}
              disabled={loading !== null}
              className="rounded-lg px-5 py-2 text-sm font-semibold transition-colors disabled:opacity-50"
              style={{ background: 'var(--accent-primary)', color: 'var(--text-on-accent)' }}
              onMouseEnter={(e) => { if (!loading) (e.currentTarget as HTMLButtonElement).style.background = 'var(--accent-hover)' }}
              onMouseLeave={(e) => ((e.currentTarget as HTMLButtonElement).style.background = 'var(--accent-primary)')}
            >
              {loading === 'db' ? 'Анализируем…' : 'Проверить перед импортом'}
            </button>
          </div>
        </div>

        {/* ── Error banner ── */}
        {error && (
          <div
            className="rounded-xl px-5 py-4 text-sm whitespace-pre-line"
            style={{
              background: 'var(--danger-bg)',
              border: '1px solid var(--danger-border)',
              color: 'var(--danger)',
            }}
          >
            {error}
          </div>
        )}

        {/* ── Commit success banner ── */}
        {commitSummary && <CommitBanner summary={commitSummary} />}

        {/* ── Parse-only view ── */}
        {parseResult && (
          <>
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-5">
              <StatCard label="Всего строк"   value={parseResult.summary.totalRows} />
              <StatCard label="Распарсено"    value={parseResult.summary.parsedRows}      color="success" />
              <StatCard label="Пропущено"     value={parseResult.summary.skippedRows}     color="warning" />
              <StatCard label="Без категории" value={parseResult.summary.withoutCategory} color="warning" />
              <StatCard label="Сумма"         value={fmtRub(parseResult.summary.totalAmount)} color="accent" />
            </div>
              <Section title={`Содержимое файла — ${parseResult.rows.length} строк`}>
              <ExpenseTable rows={parseResult.rows.slice(0, PREVIEW_LIMIT)} />
            </Section>
          </>
        )}

        {/* ── DB preview view ── */}
        {dbResult && (
          <>
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-6">
              <StatCard label="Всего"         value={dbResult.summary.total} />
              <StatCard label="Новые"         value={dbResult.summary.new}              color="success" />
              <StatCard label="Без изменений" value={dbResult.summary.unchanged}        color="accent" />
              <StatCard label="Конфликты"     value={dbResult.summary.conflicts}        color="danger" />
              <StatCard label="Без категории" value={dbResult.summary.withoutCategory}  color="warning" />
              <StatCard label="Сумма"         value={fmtRub(dbResult.summary.totalAmount)} color="accent" />
            </div>

            {dbResult.newRows.length > 0 && (
              <Section title={`Новые расходы (${dbResult.newRows.length})`} badge={{ label: 'НОВЫЕ', color: 'success' }}>
                <NewRowsTable
                  rows={dbResult.newRows.slice(0, PREVIEW_LIMIT)}
                  categories={newCategories}
                  allCategories={categoryItems}
                  onCategoryChange={(num, cat) => setNewCategories((prev) => ({ ...prev, [num]: cat }))}
                  showErrors={saveAttempted}
                />
              </Section>
            )}

            {dbResult.conflictRows.length > 0 && (
              <Section title={`Конфликты — строки уже есть в базе (${dbResult.conflictRows.length})`} badge={{ label: 'КОНФЛИКТ', color: 'danger' }}>
                <ConflictPanel
                  rows={dbResult.conflictRows.slice(0, PREVIEW_LIMIT)}
                  actions={conflictActions}
                  categories={conflictCategories}
                  allCategories={categoryItems}
                  onActionChange={(num, action) => setConflictActions((prev) => ({ ...prev, [num]: action }))}
                  onCategoryChange={(num, cat) => setConflictCategories((prev) => ({ ...prev, [num]: cat }))}
                  showErrors={saveAttempted}
                />
              </Section>
            )}

            {dbResult.unchangedRows.length > 0 && (
              <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
                {dbResult.unchangedRows.length} строк без изменений — будут пропущены.
              </p>
            )}

            {/* ── Import button ── */}
            {canSave && (
              <div className="flex flex-col items-start gap-3">
                {validationErrors.length > 0 && (
                  <ul
                    className="rounded-lg px-4 py-3 text-xs space-y-1"
                    style={{
                      background: 'var(--warning-bg)',
                      border: '1px solid var(--warning-border)',
                      color: 'var(--warning)',
                    }}
                  >
                    {validationErrors.map((e, i) => <li key={i}>⚠ {e}</li>)}
                  </ul>
                )}
                <button
                  onClick={handleSave}
                  disabled={loading !== null}
                  className="rounded-lg px-6 py-2.5 text-sm font-semibold transition-colors disabled:opacity-50"
                  style={{ background: 'var(--accent-primary)', color: 'var(--text-on-accent)' }}
                  onMouseEnter={(e) => { if (!loading) (e.currentTarget as HTMLButtonElement).style.background = 'var(--accent-hover)' }}
                  onMouseLeave={(e) => ((e.currentTarget as HTMLButtonElement).style.background = 'var(--accent-primary)')}
                >
                  {loading === 'commit' ? 'Импортируем…' : `Импортировать расходы (${dbResult.newRows.length + dbResult.conflictRows.filter((c) => (conflictActions[c.external_number] ?? 'keep_current') === 'overwrite').length})`}
                </button>
              </div>
            )}

            {!canSave && !commitSummary && (
              <p className="text-sm" style={{ color: 'var(--success)' }}>
                ✓ Нет новых строк и конфликтов — база уже актуальна.
              </p>
            )}
          </>
        )}
      </div>
    </main>
  )
}

// ── NewRowsTable ──────────────────────────────────────────────────────────────

function NewRowsTable({
  rows, categories, allCategories, onCategoryChange, showErrors,
}: {
  rows: ParsedExpense[]
  categories: Record<string, string>
  allCategories: CategoryOption[]
  onCategoryChange: (num: string, cat: string) => void
  showErrors: boolean
}) {
  return (
    <table className="w-full text-left text-xs" style={{ color: 'var(--text-secondary)' }}>
      <thead style={{ borderBottom: '1px solid var(--table-border)', background: 'var(--table-header-bg)' }}>
        <tr>
          <Th>#</Th><Th>Номер</Th><Th>Дата</Th>
          <Th>Контрагент</Th><Th>Комментарий</Th><Th>Сумма</Th><Th>Категория</Th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row, i) => {
          const needsCategory = row.category === null
          const chosen   = categories[row.external_number] ?? ''
          const hasError = showErrors && needsCategory && !chosen
          return (
            <tr
              key={row.external_number}
              style={{
                borderBottom: '1px solid var(--table-border)',
                background: hasError ? 'var(--danger-bg)' : undefined,
              }}
              onMouseEnter={(e) => { if (!hasError) (e.currentTarget as HTMLTableRowElement).style.background = 'var(--table-row-hover)' }}
              onMouseLeave={(e) => { if (!hasError) (e.currentTarget as HTMLTableRowElement).style.background = '' }}
            >
              <Td muted>{i + 1}</Td>
              <Td mono accent>{row.external_number}</Td>
              <Td>{fmtDate(row.expense_date)}</Td>
              <Td>{row.contractor ?? <Dash />}</Td>
              <Td truncate>{row.comment ?? <Dash />}</Td>
              <Td mono right>{fmtNum(row.amount)}</Td>
              <Td>
                {needsCategory
                  ? <CategorySelect value={chosen} onChange={(v) => onCategoryChange(row.external_number, v)} error={hasError} options={allCategories} />
                  : (
                    <span style={{ color: 'var(--text-secondary)' }}>
                      {allCategories.find((o) => o.name === row.category)?.label ?? row.category}
                    </span>
                  )}
              </Td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

// ── ConflictPanel ─────────────────────────────────────────────────────────────

function ConflictPanel({
  rows, actions, categories, allCategories, onActionChange, onCategoryChange, showErrors,
}: {
  rows: ConflictRow[]
  actions: Record<string, ConflictActionValue>
  categories: Record<string, string>
  allCategories: CategoryOption[]
  onActionChange: (num: string, action: ConflictActionValue) => void
  onCategoryChange: (num: string, cat: string) => void
  showErrors: boolean
}) {
  return (
    <div>
      {rows.map((conflict, i) => {
        const action       = actions[conflict.external_number] ?? 'keep_current'
        const isOverwrite  = action === 'overwrite'
        const needsCategory = isOverwrite && conflict.incoming.category === null
        const chosen   = categories[conflict.external_number] ?? ''
        const hasError = showErrors && needsCategory && !chosen

        const changeEntries = Object.entries(conflict.changes) as [
          string,
          { old: string | number | null; new: string | number | null },
        ][]

        return (
          <div
            key={conflict.external_number}
            className="p-4"
            style={{
              borderBottom: '1px solid var(--table-border)',
              background: hasError ? 'var(--danger-bg)' : undefined,
            }}
          >
            <div className="flex flex-wrap items-start gap-4">
              <span className="tabular-nums w-5 text-xs" style={{ color: 'var(--text-muted)' }}>{i + 1}</span>
              <span className="font-mono font-semibold text-xs" style={{ color: 'var(--accent-primary)' }}>
                {conflict.external_number}
              </span>
              {conflict.deleted && (
                <span
                  className="rounded px-1.5 py-0.5 text-xs font-semibold"
                  style={{ background: 'var(--danger-bg)', color: 'var(--danger)', border: '1px solid var(--danger-border)' }}
                >
                  удалён
                </span>
              )}

              <div className="flex gap-2 ml-auto">
                <ActionButton active={action === 'keep_current'} onClick={() => onActionChange(conflict.external_number, 'keep_current')} color="blue">
                  {conflict.deleted ? 'Оставить удалённым' : 'Оставить текущее'}
                </ActionButton>
                <ActionButton active={action === 'overwrite'} onClick={() => onActionChange(conflict.external_number, 'overwrite')} color="red">
                  {conflict.deleted ? 'Восстановить' : 'Перезаписать'}
                </ActionButton>
              </div>
            </div>

            <div className="mt-3 ml-9 flex flex-wrap gap-3">
              {changeEntries.map(([field, change]) => (
                <div
                  key={field}
                  className="rounded-lg px-3 py-2 text-xs"
                  style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}
                >
                  <span className="font-mono" style={{ color: 'var(--text-muted)' }}>{field}</span>
                  <div className="mt-1 flex items-center gap-2">
                    <span className="line-through" style={{ color: isOverwrite ? 'var(--danger)' : 'var(--text-muted)' }}>
                      {formatChangeValue(field, change.old)}
                    </span>
                    <span style={{ color: 'var(--border-secondary)' }}>→</span>
                    <span style={{ color: isOverwrite ? 'var(--success)' : 'var(--text-muted)', fontWeight: isOverwrite ? 600 : undefined }}>
                      {formatChangeValue(field, change.new)}
                    </span>
                  </div>
                </div>
              ))}

              {needsCategory && (
                <div
                  className="rounded-lg px-3 py-2 text-xs"
                  style={{ background: 'var(--warning-bg)', border: '1px solid var(--warning-border)' }}
                >
                  <span className="font-mono" style={{ color: 'var(--warning)' }}>category</span>
                  <div className="mt-1">
                    <CategorySelect
                      value={chosen}
                      onChange={(v) => onCategoryChange(conflict.external_number, v)}
                      error={hasError}
                      options={allCategories}
                    />
                  </div>
                </div>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ── CommitBanner ──────────────────────────────────────────────────────────────

function CommitBanner({ summary }: { summary: CommitSummary }) {
  const hasErrors = summary.errors.length > 0
  return (
    <div
      className="rounded-xl px-5 py-4"
      style={{
        background: hasErrors ? 'var(--warning-bg)' : 'var(--success-bg)',
        border: `1px solid ${hasErrors ? 'var(--warning-border)' : 'var(--success-border)'}`,
      }}
    >
      <p className="text-sm font-semibold" style={{ color: hasErrors ? 'var(--warning)' : 'var(--success)' }}>
        {hasErrors ? '⚠ Импортировано с ошибками' : '✓ Импорт завершён успешно'}
      </p>
      <div className="mt-2 flex flex-wrap gap-4 text-xs">
        <span style={{ color: 'var(--success)' }}>Добавлено: <b>{summary.inserted}</b></span>
        <span style={{ color: 'var(--accent-primary)' }}>Обновлено: <b>{summary.updated}</b></span>
        <span style={{ color: 'var(--text-muted)' }}>Пропущено: <b>{summary.skipped}</b></span>
        {summary.errors.length > 0 && (
          <span style={{ color: 'var(--danger)' }}>Ошибок: <b>{summary.errors.length}</b></span>
        )}
      </div>
      {hasErrors && (
        <ul className="mt-3 space-y-1 text-xs" style={{ color: 'var(--danger)' }}>
          {summary.errors.map((e, i) => (
            <li key={i}>
              {e.external_number && <span className="font-mono">{e.external_number}: </span>}
              {e.message}
            </li>
          ))}
        </ul>
      )}
      {!hasErrors && (
        <p className="mt-3 text-xs">
          <Link href="/expenses" style={{ color: 'var(--text-link)' }}>
            Перейти к таблице расходов →
          </Link>
        </p>
      )}
    </div>
  )
}

// ── Section ───────────────────────────────────────────────────────────────────

function Section({
  title, badge, children,
}: {
  title: string
  badge?: { label: string; color: 'success' | 'danger' }
  children: React.ReactNode
}) {
  const badgeStyle: React.CSSProperties = badge
    ? badge.color === 'success'
      ? { background: 'var(--success-bg)', color: 'var(--success)', border: '1px solid var(--success-border)' }
      : { background: 'var(--danger-bg)',  color: 'var(--danger)',  border: '1px solid var(--danger-border)' }
    : {}

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-semibold" style={{ color: 'var(--text-secondary)' }}>{title}</h2>
        {badge && (
          <span className="rounded px-2 py-0.5 text-xs font-bold" style={badgeStyle}>{badge.label}</span>
        )}
      </div>
      <div
        className="overflow-x-auto rounded-xl"
        style={{
          background: 'var(--table-bg)',
          border: '1px solid var(--table-border)',
          boxShadow: 'var(--shadow-sm)',
        }}
      >
        {children}
      </div>
    </div>
  )
}

// ── ExpenseTable ──────────────────────────────────────────────────────────────

function ExpenseTable({ rows }: { rows: ParsedExpense[] }) {
  return (
    <table className="w-full text-left text-xs" style={{ color: 'var(--text-secondary)' }}>
      <thead style={{ borderBottom: '1px solid var(--table-border)', background: 'var(--table-header-bg)' }}>
        <tr>
          <Th>#</Th><Th>Номер</Th><Th>Дата</Th>
          <Th>Контрагент</Th><Th>Комментарий</Th><Th>Сумма</Th><Th>Категория</Th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row, i) => (
          <tr
            key={row.external_number + i}
            style={{ borderBottom: '1px solid var(--table-border)' }}
            onMouseEnter={(e) => ((e.currentTarget as HTMLTableRowElement).style.background = 'var(--table-row-hover)')}
            onMouseLeave={(e) => ((e.currentTarget as HTMLTableRowElement).style.background = '')}
          >
            <Td muted>{i + 1}</Td>
            <Td mono accent>{row.external_number}</Td>
            <Td>{fmtDate(row.expense_date)}</Td>
            <Td>{row.contractor ?? <Dash />}</Td>
            <Td truncate>{row.comment ?? <Dash />}</Td>
            <Td mono right>{fmtNum(row.amount)}</Td>
            <Td>{row.category ?? <Dash />}</Td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

// ── ActionButton ──────────────────────────────────────────────────────────────

function ActionButton({ active, onClick, color, children }: {
  active: boolean; onClick: () => void; color: 'blue' | 'red'; children: React.ReactNode
}) {
  const activeStyle: React.CSSProperties = color === 'blue'
    ? { background: 'var(--accent-primary)', color: 'var(--text-on-accent)', border: '1px solid transparent' }
    : { background: 'var(--danger)',          color: '#fff',                  border: '1px solid transparent' }

  const inactiveStyle: React.CSSProperties = {
    background: 'var(--bg-card)',
    color: 'var(--text-secondary)',
    border: '1px solid var(--border-primary)',
  }

  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-md px-3 py-1.5 text-xs font-semibold transition-colors"
      style={active ? activeStyle : inactiveStyle}
    >
      {children}
    </button>
  )
}

// ── CategorySelect ────────────────────────────────────────────────────────────

function CategorySelect({ value, onChange, error, options }: {
  value: string
  onChange: (v: string) => void
  error?: boolean
  options?: CategoryOption[]
}) {
  const list: CategoryOption[] = options?.length
    ? options
    : EXPENSE_CATEGORIES.map((n) => ({ name: n as string, label: n as string }))
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="rounded px-2 py-1 text-xs outline-none transition-colors"
      style={
        error
          ? { background: 'var(--danger-bg)', border: '1px solid var(--danger)', color: 'var(--input-text)' }
          : { background: 'var(--input-bg)', border: '1px solid var(--input-border)', color: 'var(--input-text)' }
      }
      onFocus={(e) => (e.currentTarget.style.borderColor = 'var(--input-border-focus)')}
      onBlur={(e) => (e.currentTarget.style.borderColor = error ? 'var(--danger)' : 'var(--input-border)')}
    >
      <option value="">— выбрать —</option>
      {list.map((cat) => (
        <option key={cat.name} value={cat.name}>{cat.label}</option>
      ))}
    </select>
  )
}

// ── StatCard ──────────────────────────────────────────────────────────────────

function StatCard({ label, value, color = 'default' }: {
  label: string; value: string | number; color?: 'default' | 'success' | 'warning' | 'danger' | 'accent'
}) {
  const styleMap: Record<string, React.CSSProperties> = {
    default: { background: 'var(--bg-card)',    border: '1px solid var(--border-primary)', color: 'var(--text-primary)' },
    success: { background: 'var(--success-bg)', border: '1px solid var(--success-border)', color: 'var(--success)' },
    warning: { background: 'var(--warning-bg)', border: '1px solid var(--warning-border)', color: 'var(--warning)' },
    danger:  { background: 'var(--danger-bg)',  border: '1px solid var(--danger-border)',  color: 'var(--danger)' },
    accent:  { background: 'var(--accent-soft)', border: '1px solid var(--border-primary)', color: 'var(--accent-primary)' },
  }
  return (
    <div className="rounded-xl p-4" style={{ ...styleMap[color], boxShadow: 'var(--shadow-sm)' }}>
      <p className="text-xs font-medium opacity-70">{label}</p>
      <p className="mt-1 text-lg font-bold">{value}</p>
    </div>
  )
}

// ── Primitives ────────────────────────────────────────────────────────────────

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th className="whitespace-nowrap px-4 py-3 font-semibold tracking-wide text-xs" style={{ color: 'var(--text-muted)' }}>
      {children}
    </th>
  )
}

function Td({ children, muted, mono, accent, right, truncate, rowSpan }: {
  children: React.ReactNode
  muted?: boolean; mono?: boolean; accent?: boolean
  right?: boolean; truncate?: boolean; rowSpan?: number
}) {
  const colorStyle: React.CSSProperties = muted
    ? { color: 'var(--text-muted)' }
    : accent
    ? { color: 'var(--accent-primary)', fontWeight: 500 }
    : {}

  return (
    <td
      rowSpan={rowSpan}
      className={['px-4 py-2.5 align-top', mono ? 'font-mono' : '', right ? 'text-right' : '', truncate ? 'max-w-xs truncate' : ''].filter(Boolean).join(' ')}
      style={colorStyle}
    >
      {children}
    </td>
  )
}

function Dash() {
  return <span style={{ color: 'var(--border-secondary)' }}>—</span>
}

// ── Formatting ────────────────────────────────────────────────────────────────

function fmtDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString('ru-RU', {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow',
    })
  } catch { return iso }
}

function fmtNum(n: number): string {
  return n.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function fmtRub(n: number): string {
  return n.toLocaleString('ru-RU', { style: 'currency', currency: 'RUB', maximumFractionDigits: 2 })
}

function formatChangeValue(field: string, v: string | number | null): string {
  if (v === null) return '—'
  if (field === 'expense_date') return fmtDate(String(v))
  if (field === 'amount') return fmtNum(Number(v))
  return String(v)
}
