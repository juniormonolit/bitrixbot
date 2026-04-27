'use client'

import { useState, useEffect, useRef } from 'react'
import type { SettingRow } from '@/app/api/pnl/settings/route'
import type { CategoryRow } from '@/app/api/expense-categories/route'
import type { CategoryNormEntry } from '@/lib/pnl/category-norm-heat'
import {
  DEFAULT_ATTENTION_OF_NORM_PCT,
  DEFAULT_CRITICAL_OF_NORM_PCT,
} from '@/lib/pnl/category-norm-heat'
import type { PnlRowNormEntry, PnlRowNormKey } from '@/lib/pnl/row-norm'
import {
  DEFAULT_PNL_ROW_ATTENTION_OF_NORM_PCT,
  DEFAULT_PNL_ROW_CRITICAL_OF_NORM_PCT,
} from '@/lib/pnl/row-norm'

type SettingsTab = 'coefficients' | 'categories' | 'norms'

// ── Settings page ─────────────────────────────────────────────────────────────

export default function SettingsPage() {
  const [tab, setTab]           = useState<SettingsTab>('coefficients')
  const [settings, setSettings] = useState<SettingRow[]>([])
  const [categories, setCategories] = useState<CategoryRow[]>([])
  const [categoriesError, setCategoriesError] = useState<string | null>(null)
  const [normByCategory, setNormByCategory] = useState<Record<string, CategoryNormEntry>>({})
  const [normsError, setNormsError] = useState<string | null>(null)
  const [rowNormsMap, setRowNormsMap] = useState<Partial<Record<PnlRowNormKey, PnlRowNormEntry>>>({})
  const [rowNormsError, setRowNormsError] = useState<string | null>(null)
  const [loading, setLoading]   = useState(true)
  const [error, setError]       = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    setCategoriesError(null)
    setNormsError(null)
    Promise.all([
      fetch('/api/pnl/settings').then((r) => r.json()),
      fetch('/api/expense-categories').then((r) => r.json()),
      fetch('/api/pnl/category-norms').then((r) => r.json()),
      fetch('/api/pnl/row-norms').then((r) => r.json()),
    ])
      .then(([s, c, n, rn]) => {
        if (cancelled) return
        if (s.error) { setError(s.error); return }
        setSettings(s.settings ?? [])
        if (c.error) {
          setCategoriesError(c.error)
          setCategories([])
        } else {
          setCategories(c.rows ?? [])
        }
        if (n.error) {
          setNormsError(n.error)
          setNormByCategory({})
        } else {
          setNormByCategory((n.byCategory ?? {}) as Record<string, CategoryNormEntry>)
        }
        if (rn.error) {
          setRowNormsError(rn.error)
          setRowNormsMap({})
        } else {
          setRowNormsError(null)
          setRowNormsMap((rn.rowNorms ?? {}) as Partial<Record<PnlRowNormKey, PnlRowNormEntry>>)
        }
      })
      .catch((e) => { if (!cancelled) setError(e.message) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [])

  async function saveSetting(key: string, value: number) {
    await fetch('/api/pnl/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, value }),
    })
    setSettings((prev) => prev.map((s) => s.key === key ? { ...s, value } : s))
  }

  return (
    <div
      className="min-h-screen font-sans"
      style={{ background: 'var(--bg-primary)', color: 'var(--text-primary)' }}
    >
      <div className="max-w-3xl mx-auto px-6 py-10">
        <h1 className="text-xl font-bold mb-1" style={{ color: 'var(--text-primary)' }}>
          Настройки P&L
        </h1>
        <p className="text-sm mb-6" style={{ color: 'var(--text-muted)' }}>
          Коэффициенты P&amp;L, подписи категорий и целевые % / суммы для подсветки строк в отчёте.
        </p>

        <div
          className="flex gap-0.5 mb-6 p-0.5 rounded-xl w-fit"
          style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}
          role="tablist"
          aria-label="Разделы настроек"
        >
          {([
            ['coefficients', 'Коэффициенты'],
            ['categories', 'Категории расходов'],
            ['norms', 'Нормативы'],
          ] as const).map(([id, label]) => {
            const active = tab === id
            return (
              <button
                key={id}
                type="button"
                role="tab"
                id={`settings-tab-${id}`}
                aria-controls={`settings-panel-${id}`}
                aria-selected={active}
                onClick={() => setTab(id)}
                className="rounded-lg px-4 py-2 text-sm font-medium transition-colors"
                style={
                  active
                    ? {
                        background: 'var(--bg-card)',
                        color: 'var(--accent-primary)',
                        boxShadow: 'var(--shadow-sm)',
                      }
                    : { color: 'var(--text-secondary)' }
                }
              >
                {label}
              </button>
            )
          })}
        </div>

        {loading && (
          <div className="text-sm" style={{ color: 'var(--text-muted)' }}>Загрузка…</div>
        )}

        {error && (
          <div className="rounded-xl px-5 py-4 text-sm"
            style={{ background: 'var(--danger-bg)', border: '1px solid var(--danger-border)', color: 'var(--danger)' }}>
            {error}
          </div>
        )}

        {!loading && !error && tab === 'coefficients' && (
          <div
            className="rounded-xl overflow-hidden"
            style={{ border: '1px solid var(--border-primary)', background: 'var(--bg-card)' }}
            role="tabpanel"
            id="settings-panel-coefficients"
            aria-labelledby="settings-tab-coefficients"
          >
            {settings.map((s, i) => (
              <SettingItem
                key={s.key}
                setting={s}
                onSave={(v) => saveSetting(s.key, v)}
                divider={i < settings.length - 1}
              />
            ))}
            {settings.length === 0 && (
              <div className="px-6 py-8 text-center text-sm" style={{ color: 'var(--text-muted)' }}>
                Настройки не найдены. Проверьте, что миграция применена.
              </div>
            )}
          </div>
        )}

        {!loading && !error && tab === 'norms' && (
          <div role="tabpanel" id="settings-panel-norms" aria-labelledby="settings-tab-norms">
            <p className="text-xs mb-3" style={{ color: 'var(--text-muted)' }}>
              <strong className="font-medium" style={{ color: 'var(--text-secondary)' }}>Категории:</strong>{' '}
              норма % — доля от валовой по месяцу; норма ₽/мес — лимит суммы. Подсветка только у колонки %% (max факт/норма по %% и сумме). Блок прибыли ниже: чем выше %% к норме, тем лучше; зелёный при выполнении нормы, жёлтый при доле нормы от порога «внимание» до 100%, красный ниже «внимание» (пороги — %% факта от нормы, по умолчанию 90 и 75).
            </p>
            {rowNormsError && (
              <div
                className="rounded-xl px-4 py-3 text-sm mb-3"
                style={{
                  background: 'var(--warning-bg)',
                  border: '1px solid var(--warning-border)',
                  color: 'var(--warning)',
                }}
              >
                Нормативы строк P&amp;L: {rowNormsError}
              </div>
            )}
            <div
              className="rounded-xl overflow-hidden mb-6"
              style={{ border: '1px solid var(--border-primary)', background: 'var(--bg-card)' }}
            >
              <div className="px-6 py-3 text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)', borderBottom: '1px solid var(--border-primary)' }}>
                Маржинальная и чистая прибыль
              </div>
              <PnlRowNormEditor
                rowKey="gross_margin"
                title="Маржинальная прибыль"
                hint="Норма % от выручки (как первая колонка %% в P&amp;L)."
                showSecondNorm={false}
                norm={rowNormsMap.gross_margin ?? {
                  normPercent: null,
                  normPercentOfRevenue: null,
                  attentionOfNormPct: DEFAULT_PNL_ROW_ATTENTION_OF_NORM_PCT,
                  criticalOfNormPct: DEFAULT_PNL_ROW_CRITICAL_OF_NORM_PCT,
                }}
                divider
                onUpdated={(e) => {
                  setRowNormsMap((prev) => {
                    const next = { ...prev }
                    if (e === 'deleted') delete next.gross_margin
                    else next.gross_margin = e
                    return next
                  })
                }}
              />
              <PnlRowNormEditor
                rowKey="net_profit"
                title="Чистая прибыль / убыток"
                hint="Первая норма % — от маржинальной прибыли; вторая — от выручки (вторая строка %% в отчёте)."
                showSecondNorm
                norm={rowNormsMap.net_profit ?? {
                  normPercent: null,
                  normPercentOfRevenue: null,
                  attentionOfNormPct: DEFAULT_PNL_ROW_ATTENTION_OF_NORM_PCT,
                  criticalOfNormPct: DEFAULT_PNL_ROW_CRITICAL_OF_NORM_PCT,
                }}
                divider={false}
                onUpdated={(e) => {
                  setRowNormsMap((prev) => {
                    const next = { ...prev }
                    if (e === 'deleted') delete next.net_profit
                    else next.net_profit = e
                    return next
                  })
                }}
              />
            </div>
            {normsError && (
              <div
                className="rounded-xl px-4 py-3 text-sm mb-3"
                style={{
                  background: 'var(--warning-bg)',
                  border: '1px solid var(--warning-border)',
                  color: 'var(--warning)',
                }}
              >
                Нормативы недоступны: {normsError}
              </div>
            )}
            <div
              className="rounded-xl overflow-hidden"
              style={{ border: '1px solid var(--border-primary)', background: 'var(--bg-card)' }}
            >
              {categories.map((c, i) => (
                <CategoryNormEditorRow
                  key={c.id}
                  row={c}
                  norm={normByCategory[c.name] ?? {
                    normPercent: null,
                    normAmount: null,
                    attentionOfNormPct: DEFAULT_ATTENTION_OF_NORM_PCT,
                    criticalOfNormPct: DEFAULT_CRITICAL_OF_NORM_PCT,
                  }}
                  divider={i < categories.length - 1}
                  onUpdated={(entry) => {
                    setNormByCategory((prev) => {
                      const next = { ...prev }
                      if (entry.normPercent == null && entry.normAmount == null) delete next[c.name]
                      else next[c.name] = entry
                      return next
                    })
                  }}
                />
              ))}
              {categories.length === 0 && (
                <div className="px-6 py-8 text-center text-sm" style={{ color: 'var(--text-muted)' }}>
                  Категории не найдены.
                </div>
              )}
            </div>
          </div>
        )}

        {!loading && !error && tab === 'categories' && (
          <div role="tabpanel" id="settings-panel-categories" aria-labelledby="settings-tab-categories">
            <p className="text-xs mb-3" style={{ color: 'var(--text-muted)' }}>
              Техническое имя (как в базе и выгрузках) не меняется. Подпись видна в P&amp;L, расходах и импорте.
            </p>
            {categoriesError && (
              <div
                className="rounded-xl px-4 py-3 text-sm mb-3"
                style={{
                  background: 'var(--warning-bg)',
                  border: '1px solid var(--warning-border)',
                  color: 'var(--warning)',
                }}
              >
                Не удалось загрузить категории: {categoriesError}
              </div>
            )}
            <div
              className="rounded-xl overflow-hidden"
              style={{ border: '1px solid var(--border-primary)', background: 'var(--bg-card)' }}
            >
              {categories.map((c, i) => (
                <CategoryDisplayRow
                  key={c.id}
                  row={c}
                  divider={i < categories.length - 1}
                  onSaved={(patch) => {
                    setCategories((prev) => prev.map((x) => (x.id === patch.id ? { ...x, ...patch } : x)))
                  }}
                />
              ))}
              {categories.length === 0 && (
                <div className="px-6 py-8 text-center text-sm" style={{ color: 'var(--text-muted)' }}>
                  Категории не найдены.
                </div>
              )}
            </div>
          </div>
        )}

        {!loading && !error && (
          <p className="mt-6 text-xs" style={{ color: 'var(--text-muted)' }}>
            Коэффициенты, нормативы и подписи применяются при следующей загрузке P&amp;L (переключите год или обновите страницу).
          </p>
        )}
      </div>
    </div>
  )
}

// ── SettingItem ───────────────────────────────────────────────────────────────

function SettingItem({
  setting, onSave, divider,
}: {
  setting: SettingRow
  onSave: (v: number) => Promise<void>
  divider: boolean
}) {
  const [editing, setEditing]   = useState(false)
  const [draft, setDraft]       = useState('')
  const [saving, setSaving]     = useState(false)
  const [saved, setSaved]       = useState(false)
  const inputRef                = useRef<HTMLInputElement>(null)

  function startEdit() {
    setDraft((setting.value * 100).toLocaleString('ru-RU', {
      minimumFractionDigits: 0,
      maximumFractionDigits: 4,
    }))
    setEditing(true)
    setTimeout(() => inputRef.current?.focus(), 0)
  }

  async function commit() {
    const raw   = draft.replace(/\s/g, '').replace(',', '.')
    const pct   = parseFloat(raw)
    const final = isNaN(pct) ? setting.value : pct / 100
    setEditing(false)
    if (final === setting.value) return
    setSaving(true)
    await onSave(final).catch(() => {})
    setSaving(false)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  const displayPct = (setting.value * 100).toLocaleString('ru-RU', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 4,
  })

  return (
    <div
      className="px-6 py-5 flex items-start gap-6"
      style={divider ? { borderBottom: '1px solid var(--border-primary)' } : undefined}
    >
      {/* Description */}
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
          {setting.label}
        </p>
        {setting.description && (
          <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
            {setting.description}
          </p>
        )}
        <p className="text-xs mt-1 font-mono" style={{ color: 'var(--text-muted)' }}>
          {setting.key}
        </p>
      </div>

      {/* Value editor */}
      <div className="shrink-0 flex items-center gap-2">
        {editing ? (
          <div className="flex items-center gap-1.5">
            <input
              ref={inputRef}
              autoFocus
              type="text"
              inputMode="decimal"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commit}
              onKeyDown={(e) => {
                if (e.key === 'Enter')  e.currentTarget.blur()
                if (e.key === 'Escape') setEditing(false)
              }}
              className="rounded-lg px-3 py-1.5 text-sm text-right outline-none tabular-nums"
              style={{
                width: '100px',
                background: 'var(--input-bg)',
                border: '1px solid var(--input-border-focus)',
                color: 'var(--input-text)',
              }}
            />
            <span className="text-sm" style={{ color: 'var(--text-muted)' }}>%</span>
          </div>
        ) : (
          <div
            className="group/sv flex items-center gap-2 cursor-pointer"
            onClick={startEdit}
            title="Нажмите для редактирования"
          >
            <span
              className="text-2xl font-bold tabular-nums"
              style={{
                color: saved ? 'var(--success)' : 'var(--accent-primary)',
                opacity: saving ? 0.5 : 1,
              }}
            >
              {displayPct}%
            </span>
            <span
              className="text-sm opacity-0 group-hover/sv:opacity-40 transition-opacity"
              style={{ color: 'var(--text-muted)' }}
              aria-hidden
            >
              ✏
            </span>
          </div>
        )}
        {saved && !editing && (
          <span className="text-xs" style={{ color: 'var(--success)' }}>Сохранено</span>
        )}
      </div>
    </div>
  )
}

// ── PnlRowNormEditor (маржа / чистая прибыль) ─────────────────────────────────

function PnlRowNormEditor({
  rowKey,
  title,
  hint,
  showSecondNorm,
  norm,
  divider,
  onUpdated,
}: {
  rowKey: PnlRowNormKey
  title: string
  hint: string
  showSecondNorm: boolean
  norm: PnlRowNormEntry
  divider: boolean
  onUpdated: (e: PnlRowNormEntry | 'deleted') => void
}) {
  const [pctDraft, setPctDraft] = useState(
    () => (norm.normPercent != null ? String(norm.normPercent) : ''),
  )
  const [revDraft, setRevDraft] = useState(
    () => (norm.normPercentOfRevenue != null ? String(norm.normPercentOfRevenue) : ''),
  )
  const [attDraft, setAttDraft] = useState(() => String(norm.attentionOfNormPct))
  const [critDraft, setCritDraft] = useState(() => String(norm.criticalOfNormPct))
  const [saving, setSaving] = useState(false)
  const [err, setErr]       = useState<string | null>(null)

  useEffect(() => {
    setPctDraft(norm.normPercent != null ? String(norm.normPercent) : '')
    setRevDraft(norm.normPercentOfRevenue != null ? String(norm.normPercentOfRevenue) : '')
    setAttDraft(String(norm.attentionOfNormPct))
    setCritDraft(String(norm.criticalOfNormPct))
  }, [rowKey, norm.normPercent, norm.normPercentOfRevenue, norm.attentionOfNormPct, norm.criticalOfNormPct])

  function revertDrafts() {
    setPctDraft(norm.normPercent != null ? String(norm.normPercent) : '')
    setRevDraft(norm.normPercentOfRevenue != null ? String(norm.normPercentOfRevenue) : '')
    setAttDraft(String(norm.attentionOfNormPct))
    setCritDraft(String(norm.criticalOfNormPct))
  }

  async function save() {
    setErr(null)
    const pctVal = pctDraft.trim() === '' ? null : parseFloat(pctDraft.replace(/\s/g, '').replace(',', '.'))
    const revVal = showSecondNorm
      ? (revDraft.trim() === '' ? null : parseFloat(revDraft.replace(/\s/g, '').replace(',', '.')))
      : null
    const attVal = parseFloat(attDraft.replace(/\s/g, '').replace(',', '.'))
    const critVal = parseFloat(critDraft.replace(/\s/g, '').replace(',', '.'))

    if (pctVal !== null && (isNaN(pctVal) || pctVal < 0 || pctVal > 1000)) {
      setErr('Норма %: 0…1000 или пусто')
      return
    }
    if (showSecondNorm && revVal !== null && (isNaN(revVal) || revVal < 0 || revVal > 1000)) {
      setErr('Норма %% от выручки: 0…1000 или пусто')
      return
    }
    if (isNaN(attVal) || attVal <= 0 || attVal >= 100) {
      setErr('«Внимание»: доля нормы (факт/норма), 0…100, меньше 100')
      return
    }
    if (isNaN(critVal) || critVal <= 0 || critVal >= 100 || critVal >= attVal) {
      setErr('«Критично»: доля нормы, меньше чем «Внимание» (например 75 при внимании 90)')
      return
    }

    const samePct =
      (pctVal == null && norm.normPercent == null) ||
      (pctVal != null && norm.normPercent != null && Math.abs(pctVal - norm.normPercent) < 1e-6)
    const sameRev =
      !showSecondNorm ||
      (revVal == null && norm.normPercentOfRevenue == null) ||
      (revVal != null && norm.normPercentOfRevenue != null && Math.abs(revVal - norm.normPercentOfRevenue) < 1e-6)
    const sameAtt = Math.abs(attVal - norm.attentionOfNormPct) < 1e-6
    const sameCrit = Math.abs(critVal - norm.criticalOfNormPct) < 1e-6

    const hadSaved = norm.normPercent != null || norm.normPercentOfRevenue != null

    if (pctVal === null && (revVal === null || !showSecondNorm)) {
      if (!hadSaved) {
        if (!sameAtt || !sameCrit) {
          setErr('Сначала укажите хотя бы одну норму %%')
          setAttDraft(String(norm.attentionOfNormPct))
          setCritDraft(String(norm.criticalOfNormPct))
        }
        return
      }
      setSaving(true)
      try {
        const res = await fetch('/api/pnl/row-norms', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            row_key: rowKey,
            norm_percent: null,
            norm_percent_of_revenue: showSecondNorm ? null : null,
          }),
        })
        const data = await res.json()
        if (!res.ok) {
          setErr((data as { error?: string }).error ?? `HTTP ${res.status}`)
          revertDrafts()
          return
        }
        onUpdated('deleted')
        setPctDraft('')
        setRevDraft('')
        setAttDraft(String(DEFAULT_PNL_ROW_ATTENTION_OF_NORM_PCT))
        setCritDraft(String(DEFAULT_PNL_ROW_CRITICAL_OF_NORM_PCT))
      } catch (e) {
        setErr(e instanceof Error ? e.message : 'Ошибка')
        revertDrafts()
      } finally {
        setSaving(false)
      }
      return
    }

    if (samePct && sameRev && sameAtt && sameCrit) return

    setSaving(true)
    try {
      const res = await fetch('/api/pnl/row-norms', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          row_key: rowKey,
          norm_percent: pctVal,
          norm_percent_of_revenue: showSecondNorm ? revVal : null,
          attention_of_norm_pct: attVal,
          critical_of_norm_pct: critVal,
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        setErr((data as { error?: string }).error ?? `HTTP ${res.status}`)
        revertDrafts()
        return
      }
      if ((data as { deleted?: boolean }).deleted) {
        onUpdated('deleted')
        setPctDraft('')
        setRevDraft('')
        setAttDraft(String(DEFAULT_PNL_ROW_ATTENTION_OF_NORM_PCT))
        setCritDraft(String(DEFAULT_PNL_ROW_CRITICAL_OF_NORM_PCT))
        return
      }
      const r = (data as { row?: PnlRowNormEntry }).row
      if (r) {
        onUpdated(r)
        setPctDraft(r.normPercent != null ? String(r.normPercent) : '')
        setRevDraft(r.normPercentOfRevenue != null ? String(r.normPercentOfRevenue) : '')
        setAttDraft(String(r.attentionOfNormPct))
        setCritDraft(String(r.criticalOfNormPct))
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Ошибка')
      revertDrafts()
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      className="px-6 py-4 flex flex-col lg:flex-row lg:items-start gap-4"
      style={divider ? { borderBottom: '1px solid var(--border-primary)' } : undefined}
    >
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
          {title}
        </p>
        <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
          {hint}
        </p>
        <p className="text-xs mt-1 font-mono" style={{ color: 'var(--text-muted)' }}>
          {rowKey}
        </p>
        {err && <p className="text-xs mt-1" style={{ color: 'var(--danger)' }}>{err}</p>}
      </div>
      <div className="shrink-0 grid grid-cols-2 sm:grid-cols-4 gap-x-3 gap-y-3 lg:justify-items-end">
        <div className="w-full sm:w-28">
          <label className="text-[10px] font-medium uppercase tracking-wide block" style={{ color: 'var(--text-muted)' }}>
            Норма %
          </label>
          <input
            type="text"
            inputMode="decimal"
            disabled={saving}
            value={pctDraft}
            onChange={(e) => setPctDraft(e.target.value)}
            onBlur={() => void save()}
            placeholder="—"
            className="mt-1 w-full rounded-lg px-3 py-2 text-sm text-right tabular-nums outline-none"
            style={{
              background: 'var(--input-bg)',
              border: '1px solid var(--input-border)',
              color: 'var(--input-text)',
            }}
          />
        </div>
        {showSecondNorm && (
          <div className="w-full sm:w-28">
            <label className="text-[10px] font-medium uppercase tracking-wide block" style={{ color: 'var(--text-muted)' }}>
              % от выручки
            </label>
            <input
              type="text"
              inputMode="decimal"
              disabled={saving}
              value={revDraft}
              onChange={(e) => setRevDraft(e.target.value)}
              onBlur={() => void save()}
              placeholder="—"
              className="mt-1 w-full rounded-lg px-3 py-2 text-sm text-right tabular-nums outline-none"
              style={{
                background: 'var(--input-bg)',
                border: '1px solid var(--input-border)',
                color: 'var(--input-text)',
              }}
            />
          </div>
        )}
        <div className="w-full sm:w-28">
          <label className="text-[10px] font-medium uppercase tracking-wide block" style={{ color: 'var(--text-muted)' }}>
            Внимание, % нормы
          </label>
          <input
            type="text"
            inputMode="decimal"
            disabled={saving}
            value={attDraft}
            onChange={(e) => setAttDraft(e.target.value)}
            onBlur={() => void save()}
            className="mt-1 w-full rounded-lg px-3 py-2 text-sm text-right tabular-nums outline-none"
            style={{
              background: 'var(--input-bg)',
              border: '1px solid var(--input-border)',
              color: 'var(--input-text)',
            }}
          />
        </div>
        <div className="w-full sm:w-28">
          <label className="text-[10px] font-medium uppercase tracking-wide block" style={{ color: 'var(--text-muted)' }}>
            Критично, % нормы
          </label>
          <input
            type="text"
            inputMode="decimal"
            disabled={saving}
            value={critDraft}
            onChange={(e) => setCritDraft(e.target.value)}
            onBlur={() => void save()}
            className="mt-1 w-full rounded-lg px-3 py-2 text-sm text-right tabular-nums outline-none"
            style={{
              background: 'var(--input-bg)',
              border: '1px solid var(--input-border)',
              color: 'var(--input-text)',
            }}
          />
        </div>
      </div>
    </div>
  )
}

// ── CategoryNormEditorRow ─────────────────────────────────────────────────────

function CategoryNormEditorRow({
  row,
  norm,
  divider,
  onUpdated,
}: {
  row: CategoryRow
  norm: CategoryNormEntry
  divider: boolean
  onUpdated: (entry: CategoryNormEntry) => void
}) {
  const [pctDraft, setPctDraft] = useState(
    () => (norm.normPercent != null ? String(norm.normPercent) : ''),
  )
  const [amtDraft, setAmtDraft] = useState(
    () => (norm.normAmount != null ? String(norm.normAmount) : ''),
  )
  const [attDraft, setAttDraft] = useState(
    () => String(norm.attentionOfNormPct ?? DEFAULT_ATTENTION_OF_NORM_PCT),
  )
  const [critDraft, setCritDraft] = useState(
    () => String(norm.criticalOfNormPct ?? DEFAULT_CRITICAL_OF_NORM_PCT),
  )
  const [saving, setSaving] = useState(false)
  const [err, setErr]       = useState<string | null>(null)

  useEffect(() => {
    setPctDraft(norm.normPercent != null ? String(norm.normPercent) : '')
    setAmtDraft(norm.normAmount != null ? String(norm.normAmount) : '')
    setAttDraft(String(norm.attentionOfNormPct ?? DEFAULT_ATTENTION_OF_NORM_PCT))
    setCritDraft(String(norm.criticalOfNormPct ?? DEFAULT_CRITICAL_OF_NORM_PCT))
  }, [row.name, norm.normPercent, norm.normAmount, norm.attentionOfNormPct, norm.criticalOfNormPct])

  const shownLabel = (row.display_name && row.display_name.trim()) || row.name

  function revertDrafts() {
    setPctDraft(norm.normPercent != null ? String(norm.normPercent) : '')
    setAmtDraft(norm.normAmount != null ? String(norm.normAmount) : '')
    setAttDraft(String(norm.attentionOfNormPct ?? DEFAULT_ATTENTION_OF_NORM_PCT))
    setCritDraft(String(norm.criticalOfNormPct ?? DEFAULT_CRITICAL_OF_NORM_PCT))
  }

  async function saveBoth() {
    setErr(null)
    const pctVal = pctDraft.trim() === '' ? null : parseFloat(pctDraft.replace(/\s/g, '').replace(',', '.'))
    const amtVal = amtDraft.trim() === '' ? null : parseFloat(amtDraft.replace(/\s/g, '').replace(',', '.'))
    const attVal = parseFloat(attDraft.replace(/\s/g, '').replace(',', '.'))
    const critVal = parseFloat(critDraft.replace(/\s/g, '').replace(',', '.'))

    if (pctVal !== null && (isNaN(pctVal) || pctVal < 0 || pctVal > 1000)) {
      setErr('Норма %: число от 0 до 1000 или пусто')
      return
    }
    if (amtVal !== null && (isNaN(amtVal) || amtVal < 0)) {
      setErr('Норма суммы: неотрицательное число или пусто')
      return
    }
    if (isNaN(attVal) || attVal <= 100) {
      setErr('«Внимание»: число больше 100 (например 110 = 110% от нормы)')
      return
    }
    if (isNaN(critVal) || critVal <= attVal) {
      setErr('«Критично» должно быть больше «Внимание»')
      return
    }

    const samePct =
      (pctVal == null && norm.normPercent == null) ||
      (pctVal != null && norm.normPercent != null && Math.abs(pctVal - norm.normPercent) < 1e-6)
    const sameAmt =
      (amtVal == null && norm.normAmount == null) ||
      (amtVal != null && norm.normAmount != null && Math.abs(amtVal - norm.normAmount) < 1e-6)
    const sameAtt = Math.abs(attVal - norm.attentionOfNormPct) < 1e-6
    const sameCrit = Math.abs(critVal - norm.criticalOfNormPct) < 1e-6

    if (pctVal === null && amtVal === null) {
      if (norm.normPercent == null && norm.normAmount == null) {
        if (!sameAtt || !sameCrit) {
          setErr('Сначала укажите норму %% или ₽/мес, чтобы сохранить пороги')
          setAttDraft(String(norm.attentionOfNormPct))
          setCritDraft(String(norm.criticalOfNormPct))
        }
        return
      }
      setSaving(true)
      try {
        const res = await fetch('/api/pnl/category-norms', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            category: row.name,
            norm_percent: null,
            norm_amount: null,
          }),
        })
        const data = await res.json()
        if (!res.ok) {
          setErr((data as { error?: string }).error ?? `HTTP ${res.status}`)
          revertDrafts()
          return
        }
        onUpdated({
          normPercent: null,
          normAmount: null,
          attentionOfNormPct: DEFAULT_ATTENTION_OF_NORM_PCT,
          criticalOfNormPct: DEFAULT_CRITICAL_OF_NORM_PCT,
        })
        setPctDraft('')
        setAmtDraft('')
        setAttDraft(String(DEFAULT_ATTENTION_OF_NORM_PCT))
        setCritDraft(String(DEFAULT_CRITICAL_OF_NORM_PCT))
      } catch (e) {
        setErr(e instanceof Error ? e.message : 'Ошибка')
        revertDrafts()
      } finally {
        setSaving(false)
      }
      return
    }

    if (samePct && sameAmt && sameAtt && sameCrit) return

    setSaving(true)
    try {
      const res = await fetch('/api/pnl/category-norms', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          category: row.name,
          norm_percent: pctVal,
          norm_amount: amtVal,
          attention_of_norm_pct: attVal,
          critical_of_norm_pct: critVal,
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        setErr((data as { error?: string }).error ?? `HTTP ${res.status}`)
        revertDrafts()
        return
      }
      if ((data as { deleted?: boolean }).deleted) {
        onUpdated({
          normPercent: null,
          normAmount: null,
          attentionOfNormPct: DEFAULT_ATTENTION_OF_NORM_PCT,
          criticalOfNormPct: DEFAULT_CRITICAL_OF_NORM_PCT,
        })
        setPctDraft('')
        setAmtDraft('')
        setAttDraft(String(DEFAULT_ATTENTION_OF_NORM_PCT))
        setCritDraft(String(DEFAULT_CRITICAL_OF_NORM_PCT))
        return
      }
      const r = (data as { row?: CategoryNormEntry }).row
      if (r) {
        onUpdated(r)
        setPctDraft(r.normPercent != null ? String(r.normPercent) : '')
        setAmtDraft(r.normAmount != null ? String(r.normAmount) : '')
        setAttDraft(String(r.attentionOfNormPct))
        setCritDraft(String(r.criticalOfNormPct))
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Ошибка')
      revertDrafts()
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      className="px-6 py-4 flex flex-col lg:flex-row lg:items-start gap-4"
      style={divider ? { borderBottom: '1px solid var(--border-primary)' } : undefined}
    >
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
          {shownLabel}
        </p>
        <p className="text-xs mt-1 font-mono" style={{ color: 'var(--text-muted)' }}>
          {row.name}
        </p>
        {err && <p className="text-xs mt-1" style={{ color: 'var(--danger)' }}>{err}</p>}
      </div>
      <div className="shrink-0 grid grid-cols-2 sm:grid-cols-4 gap-x-3 gap-y-3 lg:justify-items-end">
        <div className="w-full sm:w-28">
          <label className="text-[10px] font-medium uppercase tracking-wide block" style={{ color: 'var(--text-muted)' }}>
            Норма %
          </label>
          <input
            type="text"
            inputMode="decimal"
            disabled={saving}
            value={pctDraft}
            onChange={(e) => setPctDraft(e.target.value)}
            onBlur={() => void saveBoth()}
            placeholder="—"
            className="mt-1 w-full rounded-lg px-3 py-2 text-sm text-right tabular-nums outline-none"
            style={{
              background: 'var(--input-bg)',
              border: '1px solid var(--input-border)',
              color: 'var(--input-text)',
            }}
          />
        </div>
        <div className="w-full sm:w-32">
          <label className="text-[10px] font-medium uppercase tracking-wide block" style={{ color: 'var(--text-muted)' }}>
            Норма ₽/мес
          </label>
          <input
            type="text"
            inputMode="decimal"
            disabled={saving}
            value={amtDraft}
            onChange={(e) => setAmtDraft(e.target.value)}
            onBlur={() => void saveBoth()}
            placeholder="—"
            className="mt-1 w-full rounded-lg px-3 py-2 text-sm text-right tabular-nums outline-none"
            style={{
              background: 'var(--input-bg)',
              border: '1px solid var(--input-border)',
              color: 'var(--input-text)',
            }}
          />
        </div>
        <div className="w-full sm:w-28">
          <label className="text-[10px] font-medium uppercase tracking-wide block" style={{ color: 'var(--text-muted)' }}>
            Внимание %
          </label>
          <input
            type="text"
            inputMode="decimal"
            disabled={saving}
            value={attDraft}
            onChange={(e) => setAttDraft(e.target.value)}
            onBlur={() => void saveBoth()}
            title="Порог в процентах от нормы (110 = при факт/норма > 1.10 заканчивается «жёлтая» зона)"
            className="mt-1 w-full rounded-lg px-3 py-2 text-sm text-right tabular-nums outline-none"
            style={{
              background: 'var(--input-bg)',
              border: '1px solid var(--input-border)',
              color: 'var(--input-text)',
            }}
          />
        </div>
        <div className="w-full sm:w-28">
          <label className="text-[10px] font-medium uppercase tracking-wide block" style={{ color: 'var(--text-muted)' }}>
            Критично %
          </label>
          <input
            type="text"
            inputMode="decimal"
            disabled={saving}
            value={critDraft}
            onChange={(e) => setCritDraft(e.target.value)}
            onBlur={() => void saveBoth()}
            title="Красный при факт/норма выше этого %% от нормы (125 = 1.25)"
            className="mt-1 w-full rounded-lg px-3 py-2 text-sm text-right tabular-nums outline-none"
            style={{
              background: 'var(--input-bg)',
              border: '1px solid var(--input-border)',
              color: 'var(--input-text)',
            }}
          />
        </div>
      </div>
    </div>
  )
}

// ── CategoryDisplayRow ────────────────────────────────────────────────────────

function CategoryDisplayRow({
  row,
  divider,
  onSaved,
}: {
  row: CategoryRow
  divider: boolean
  onSaved: (patch: { id: string; display_name: string | null }) => void
}) {
  const [draft, setDraft] = useState(
    () => row.display_name?.trim() ?? '',
  )
  const [saving, setSaving] = useState(false)
  const [err, setErr]       = useState<string | null>(null)
  const lastCommitted       = useRef(row.display_name)

  useEffect(() => {
    setDraft(row.display_name?.trim() ?? '')
    lastCommitted.current = row.display_name
  }, [row.id, row.display_name])

  async function commit() {
    const t = draft.trim()
    const nextVal: string | null = t === '' || t === row.name ? null : t.slice(0, 200)
    const prevNorm = lastCommitted.current?.trim() || null
    const nextNorm = nextVal
    if (prevNorm === nextNorm || (prevNorm === null && nextNorm === null)) return

    setSaving(true)
    setErr(null)
    try {
      const res = await fetch(`/api/expense-categories/${row.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ display_name: nextVal }),
      })
      const data = await res.json()
      if (!res.ok) {
        setErr((data as { error?: string }).error ?? `HTTP ${res.status}`)
        setDraft(row.display_name?.trim() ?? '')
        return
      }
      const dn = (data as { row?: { display_name: string | null } }).row?.display_name ?? null
      lastCommitted.current = dn
      onSaved({ id: row.id, display_name: dn })
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Ошибка')
      setDraft(row.display_name?.trim() ?? '')
    } finally {
      setSaving(false)
    }
  }

  const shownLabel = (row.display_name && row.display_name.trim()) || row.name

  return (
    <div
      className="px-6 py-4 flex flex-col sm:flex-row sm:items-start gap-4"
      style={divider ? { borderBottom: '1px solid var(--border-primary)' } : undefined}
    >
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
          {shownLabel}
        </p>
        <p className="text-xs mt-1 font-mono" style={{ color: 'var(--text-muted)' }}>
          {row.name}
        </p>
        {err && (
          <p className="text-xs mt-1" style={{ color: 'var(--danger)' }}>{err}</p>
        )}
      </div>
      <div className="shrink-0 w-full sm:w-64">
        <label className="text-[10px] font-medium uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
          Отображаемое имя
        </label>
        <input
          type="text"
          value={draft}
          disabled={saving}
          placeholder={row.name}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={(e) => {
            (e.currentTarget as HTMLInputElement).style.borderColor = 'var(--input-border)'
            void commit()
          }}
          className="mt-1 w-full rounded-lg px-3 py-2 text-sm outline-none"
          style={{
            background: 'var(--input-bg)',
            border: '1px solid var(--input-border)',
            color: 'var(--input-text)',
            opacity: saving ? 0.6 : 1,
          }}
          onFocus={(e) => { (e.currentTarget as HTMLInputElement).style.borderColor = 'var(--input-border-focus)' }}
        />
      </div>
    </div>
  )
}
