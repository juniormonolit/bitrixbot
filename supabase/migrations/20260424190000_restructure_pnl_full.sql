-- Migration: restructure_pnl_full
-- Полная перестройка P&L по образцу Excel-отчёта.
--
-- Ручные вводы (pnl_monthly_values):
--   revenue      — Выручка ИТОГО
--   gross_margin — МАРЖИНАЛЬНАЯ ПРИБЫЛЬ (вводится напрямую, Себестоимость = формула)
--
-- Структура строк:
--   Выручка ИТОГО         (manual)
--   Себестоимость ИТОГО   (formula = revenue - gross_margin)
--   МАРЖИНАЛЬНАЯ ПРИБЫЛЬ  (manual)
--   Коммерческие расходы  (group → Затраты на реализацию + Затраты на маркетинг)
--   ВАЛОВАЯ ПРИБЫЛЬ       (formula = gross_margin - commercial_expenses)
--   Косвенные расходы     (group → Административные расходы + Расходы на развитие)
--   Операционная прибыль (EBITDA) (formula = gross_profit - indirect_expenses)
--   Кредит и налоги       (group: Налог за ЗП, Налоги за безнал, Прибыль и убыток)
--   Расходы в 1с          (formula = commercial_expenses + indirect_expenses)
--   Расходы (ВСЕ)         (formula = expenses_in_1c + credit_taxes)
--   Чистая прибыль/убыток (formula = gross_margin - expenses_all)
--
-- % знаменатель:
--   Выручка, Себестоимость — без %
--   МАРЖИНАЛЬНАЯ ПРИБЫЛЬ  — % от Выручки
--   Все прочие строки      — % от МАРЖИНАЛЬНОЙ ПРИБЫЛИ

-- ── 1. Новые категории расходов (Кредит и налоги) ────────────────────────────

INSERT INTO public.expense_categories (name, sort_order)
VALUES
  ('Налог за ЗП',      180),
  ('Налоги за безнал', 190),
  ('Прибыль убыток',   200)
ON CONFLICT (name) DO NOTHING;

-- ── 2. Полная замена pnl_structure ───────────────────────────────────────────

DELETE FROM public.pnl_structure;

DO $$
DECLARE
  -- Level 0 — manual rows
  id_revenue        uuid := 'a0000000-0000-0000-0000-000000000001';
  id_gm             uuid := 'a0000000-0000-0000-0000-000000000002';

  -- Level 0 — top-level groups
  id_commercial     uuid := 'c0000000-0000-0000-0000-000000000001';
  id_indirect       uuid := 'c0000000-0000-0000-0000-000000000004';
  id_credit_taxes   uuid := 'd0000000-0000-0000-0000-000000000001';

  -- Level 0 — formula rows
  id_cogs           uuid := 'f0000000-0000-0000-0000-000000000007';
  id_gross_profit   uuid := 'f0000000-0000-0000-0000-000000000004';
  id_ebitda         uuid := 'f0000000-0000-0000-0000-000000000002';
  id_exp_1c         uuid := 'f0000000-0000-0000-0000-000000000005';
  id_exp_all        uuid := 'f0000000-0000-0000-0000-000000000006';
  id_net_profit     uuid := 'f0000000-0000-0000-0000-000000000003';

  -- Level 1 — sub-groups of Коммерческие
  id_realization    uuid := 'c0000000-0000-0000-0000-000000000002';
  id_mkt_grp        uuid := 'c0000000-0000-0000-0000-000000000003';

  -- Level 1 — sub-groups of Косвенные
  id_admin          uuid := 'c0000000-0000-0000-0000-000000000005';
  id_development    uuid := 'c0000000-0000-0000-0000-000000000006';
BEGIN

  -- ── Level 0: manual rows ─────────────────────────────────────────────────
  INSERT INTO public.pnl_structure (id, name, type, key, category, sort_order, level)
  VALUES
    (id_revenue, 'Выручка ИТОГО',        'manual', 'revenue',      'revenue',      5, 0),
    (id_gm,      'МАРЖИНАЛЬНАЯ ПРИБЫЛЬ', 'manual', 'gross_margin', 'gross_margin', 8, 0);

  -- ── Level 0: Себестоимость ИТОГО (formula = revenue - gross_margin) ──────
  INSERT INTO public.pnl_structure (id, name, type, key, formula, sort_order, level)
  VALUES (
    id_cogs, 'Себестоимость ИТОГО', 'formula', 'cogs',
    '{"op":"subtract","left":"revenue","right":"gross_margin"}',
    6, 0
  );

  -- ── Level 0: Коммерческие расходы ────────────────────────────────────────
  INSERT INTO public.pnl_structure (id, name, type, key, sort_order, level)
  VALUES (id_commercial, 'Коммерческие расходы', 'group', 'commercial_expenses', 10, 0);

  INSERT INTO public.pnl_structure (id, name, type, parent_id, sort_order, level)
  VALUES
    (id_realization, 'Затраты на реализацию', 'group', id_commercial, 10, 1),
    (id_mkt_grp,     'Затраты на маркетинг',  'group', id_commercial, 20, 1);

  INSERT INTO public.pnl_structure (name, type, parent_id, category, sort_order, level)
  VALUES
    ('ЗП (Менеджеры)', 'category', id_realization, 'ЗП МЕН',     10, 2),
    ('ЗП (РОПЫ)',      'category', id_realization, 'ЗП РОП',     20, 2),
    ('ЗП (Логисты)',   'category', id_realization, 'ЗП ЛОГ',     30, 2),
    ('Маркетинг',      'category', id_mkt_grp,     'Маркетинг',  10, 2),
    ('Колл-центр',     'category', id_mkt_grp,     'Колл-центр', 20, 2);

  -- ── Level 0: ВАЛОВАЯ ПРИБЫЛЬ (formula) ───────────────────────────────────
  INSERT INTO public.pnl_structure (id, name, type, key, formula, sort_order, level)
  VALUES (
    id_gross_profit, 'ВАЛОВАЯ ПРИБЫЛЬ', 'formula', 'gross_profit',
    '{"op":"subtract","left":"gross_margin","right":"commercial_expenses"}',
    15, 0
  );

  -- ── Level 0: Косвенные расходы ────────────────────────────────────────────
  INSERT INTO public.pnl_structure (id, name, type, key, sort_order, level)
  VALUES (id_indirect, 'Косвенные расходы', 'group', 'indirect_expenses', 20, 0);

  INSERT INTO public.pnl_structure (id, name, type, parent_id, sort_order, level)
  VALUES
    (id_admin,       'Административные расходы', 'group', id_indirect, 10, 1),
    (id_development, 'Расходы на развитие',       'group', id_indirect, 20, 1);

  INSERT INTO public.pnl_structure (name, type, parent_id, category, sort_order, level)
  VALUES
    ('Аренда офиса',             'category', id_admin, 'Аренда',                  10, 2),
    ('Склад',                    'category', id_admin, 'Склад',                   20, 2),
    ('Бухгалтерия',              'category', id_admin, 'Бухгалтерия',             30, 2),
    ('Хоз.нужды',                'category', id_admin, 'ХОЗ',                    40, 2),
    ('Найм',                     'category', id_admin, 'Найм',                    50, 2),
    ('Адаптация и мотивация',    'category', id_admin, 'Адаптация и мотивация',   60, 2),
    ('Банк',                     'category', id_admin, 'Банк',                    70, 2),
    ('IT (Абонентка)',            'category', id_admin, 'АЙТИ',                   80, 2),
    ('Прочие расходы',           'category', id_admin, 'Прочие расходы',          90, 2),
    ('Юр.услуги и безопасность', 'category', id_admin, 'Юр услуги и без',        100, 2),
    ('Курьеры',                  'category', id_admin, 'Курьеры',                110, 2),
    ('Разработка IT',            'category', id_development, 'Разработка IT',     10, 2);

  -- ── Level 0: Операционная прибыль (EBITDA) ───────────────────────────────
  INSERT INTO public.pnl_structure (id, name, type, key, formula, sort_order, level)
  VALUES (
    id_ebitda, 'Операционная прибыль (EBITDA)', 'formula', 'ebitda',
    '{"op":"subtract","left":"gross_profit","right":"indirect_expenses"}',
    25, 0
  );

  -- ── Level 0: Кредит и налоги ──────────────────────────────────────────────
  INSERT INTO public.pnl_structure (id, name, type, key, sort_order, level)
  VALUES (id_credit_taxes, 'Кредит и налоги', 'group', 'credit_taxes', 30, 0);

  INSERT INTO public.pnl_structure (name, type, parent_id, category, sort_order, level)
  VALUES
    ('Налог за ЗП (16)',          'category', id_credit_taxes, 'Налог за ЗП',      10, 1),
    ('Налоги за безнал (1,3)',    'category', id_credit_taxes, 'Налоги за безнал', 20, 1),
    ('Прибыль и убыток (пр.лет)', 'category', id_credit_taxes, 'Прибыль убыток',   30, 1);

  -- ── Level 0: Расходы в 1с (commercial + indirect) ────────────────────────
  INSERT INTO public.pnl_structure (id, name, type, key, formula, sort_order, level)
  VALUES (
    id_exp_1c, 'Расходы в 1с', 'formula', 'expenses_in_1c',
    '{"op":"add","left":"commercial_expenses","right":"indirect_expenses"}',
    35, 0
  );

  -- ── Level 0: Расходы (ВСЕ) (expenses_in_1c + credit_taxes) ──────────────
  INSERT INTO public.pnl_structure (id, name, type, key, formula, sort_order, level)
  VALUES (
    id_exp_all, 'Расходы (ВСЕ)', 'formula', 'expenses_all',
    '{"op":"add","left":"expenses_in_1c","right":"credit_taxes"}',
    38, 0
  );

  -- ── Level 0: Чистая прибыль/убыток (gross_margin - expenses_all) ─────────
  INSERT INTO public.pnl_structure (id, name, type, key, formula, sort_order, level)
  VALUES (
    id_net_profit, 'Чистая прибыль/убыток', 'formula', 'net_profit',
    '{"op":"subtract","left":"gross_margin","right":"expenses_all"}',
    40, 0
  );

END $$;
