-- Migration: pnl_settings
-- Adds configurable tax rate settings and converts credit_taxes children to formula/manual rows.
--
-- New table: pnl_settings
--   tax_rate_payroll  = 0.16   (N: Налог на ЗП = (Найм + Реализация + Адаптация) * N)
--   tax_rate_cashless = 0.0075 (X: Налоги за безнал = Выручка * X)
--
-- pnl_structure changes:
--   1. Add key='realization' to "Затраты на реализацию" group (for formula ref)
--   2. Add key='naim'        to "Найм" category
--   3. Add key='adaptation'  to "Адаптация и мотивация" category
--   4. "Налог за ЗП (16)"           → formula, multiply_setting
--   5. "Налоги за безнал (1,3)"     → formula, multiply_setting
--   6. "Прибыль и убыток (пр.лет)"  → manual, key='profit_loss_prev_years'

-- ── 1. Create pnl_settings ────────────────────────────────────────────────────

CREATE TABLE public.pnl_settings (
  key         TEXT PRIMARY KEY,
  value       NUMERIC(12, 6) NOT NULL,
  label       TEXT           NOT NULL,
  description TEXT           NULL,
  updated_at  TIMESTAMPTZ    DEFAULT now()
);

INSERT INTO public.pnl_settings (key, value, label, description) VALUES
  ('tax_rate_payroll',  0.16,   'Налог на ЗП',       '(Найм + Затраты на реализацию + Адаптация) × N'),
  ('tax_rate_cashless', 0.0075, 'Налоги за безнал',  'Выручка ИТОГО × X');

-- ── 2. Add formula-reference keys to expense rows ─────────────────────────────

UPDATE public.pnl_structure
SET key = 'realization'
WHERE id = 'c0000000-0000-0000-0000-000000000002';  -- Затраты на реализацию

UPDATE public.pnl_structure
SET key = 'naim'
WHERE name = 'Найм' AND type = 'category';

UPDATE public.pnl_structure
SET key = 'adaptation'
WHERE name = 'Адаптация и мотивация' AND type = 'category';

-- ── 3. Convert "Налог за ЗП (16)" to formula row ─────────────────────────────

UPDATE public.pnl_structure
SET
  type     = 'formula',
  name     = 'Налог на ЗП',
  key      = 'tax_payroll',
  category = NULL,
  formula  = '{"op":"multiply_setting","sum_refs":["realization","naim","adaptation"],"setting_key":"tax_rate_payroll"}'
WHERE name = 'Налог за ЗП (16)';

-- ── 4. Convert "Налоги за безнал (1,3)" to formula row ───────────────────────

UPDATE public.pnl_structure
SET
  type     = 'formula',
  name     = 'Налоги за безнал',
  key      = 'tax_cashless',
  category = NULL,
  formula  = '{"op":"multiply_setting","sum_refs":["revenue"],"setting_key":"tax_rate_cashless"}'
WHERE name = 'Налоги за безнал (1,3)';

-- ── 5. Convert "Прибыль и убыток (пр.лет)" to manual row ─────────────────────

UPDATE public.pnl_structure
SET
  type     = 'manual',
  key      = 'profit_loss_prev_years',
  category = 'profit_loss_prev_years'
WHERE name = 'Прибыль и убыток (пр.лет)';
