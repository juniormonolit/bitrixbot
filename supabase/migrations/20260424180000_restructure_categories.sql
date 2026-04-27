-- Migration: restructure_categories
-- 1. Переименовывает категории расходов в соответствие с именами из Excel-выгрузок
-- 2. Обновляет expenses.category для исторических данных
-- 3. Перестраивает иерархию pnl_structure под новую структуру P&L

-- ── 1. Переименование категорий (старое имя → имя в Excel) ──────────────────────

UPDATE public.expense_categories SET name = 'ЗП МЕН'           WHERE name = 'ЗП';
UPDATE public.expense_categories SET name = 'ЗП РОП'           WHERE name = 'ОПРЫ';
UPDATE public.expense_categories SET name = 'ЗП ЛОГ'           WHERE name = 'Логисты';
UPDATE public.expense_categories SET name = 'Аренда'           WHERE name = 'Аренда офиса';
UPDATE public.expense_categories SET name = 'ХОЗ'              WHERE name = 'ЖБИ';
UPDATE public.expense_categories SET name = 'АЙТИ'             WHERE name = 'IT';
UPDATE public.expense_categories SET name = 'Юр услуги и без'  WHERE name = 'Юр.услуги и безопасность';

-- Добавить новые категории, которых ещё нет
INSERT INTO public.expense_categories (name, sort_order) VALUES
  ('ЗП МЕН',          10),
  ('ЗП РОП',          20),
  ('ЗП ЛОГ',          30),
  ('Маркетинг',        40),
  ('Колл-центр',       50),
  ('Аренда',           60),
  ('Склад',            70),
  ('Бухгалтерия',      80),
  ('ХОЗ',              90),
  ('Найм',            100),
  ('Адаптация и мотивация', 110),
  ('Банк',            120),
  ('АЙТИ',            130),
  ('Прочие расходы',  140),
  ('Юр услуги и без', 150),
  ('Курьеры',         160),
  ('Разработка IT',   170)
ON CONFLICT (name) DO NOTHING;

-- ── 2. Обновление expenses.category для исторических данных ─────────────────────

UPDATE public.expenses SET category = 'ЗП МЕН'          WHERE category = 'ЗП';
UPDATE public.expenses SET category = 'ЗП РОП'          WHERE category = 'ОПРЫ';
UPDATE public.expenses SET category = 'ЗП ЛОГ'          WHERE category = 'Логисты';
UPDATE public.expenses SET category = 'Аренда'          WHERE category = 'Аренда офиса';
UPDATE public.expenses SET category = 'ХОЗ'             WHERE category = 'ЖБИ';
UPDATE public.expenses SET category = 'АЙТИ'            WHERE category = 'IT';
UPDATE public.expenses SET category = 'Юр услуги и без' WHERE category = 'Юр.услуги и безопасность';

-- ── 3. Перестройка иерархии pnl_structure ────────────────────────────────────────

DO $$
DECLARE
  id_total       uuid := 'b0000000-0000-0000-0000-000000000001';

  -- Уровень 1
  id_commercial  uuid := 'c0000000-0000-0000-0000-000000000001';
  id_indirect    uuid := 'c0000000-0000-0000-0000-000000000004';

  -- Уровень 2
  id_realization uuid := 'c0000000-0000-0000-0000-000000000002';
  id_mkt_grp     uuid := 'c0000000-0000-0000-0000-000000000003';
  id_admin       uuid := 'c0000000-0000-0000-0000-000000000005';
  id_development uuid := 'c0000000-0000-0000-0000-000000000006';
BEGIN
  -- Удалить старое дерево расходов (каскад на все вложенные строки)
  DELETE FROM public.pnl_structure WHERE parent_id = id_total;

  -- ── Уровень 1: Коммерческие расходы ───────────────────────────────────────
  INSERT INTO public.pnl_structure (id, name, type, parent_id, sort_order, level)
  VALUES (id_commercial, 'Коммерческие расходы', 'group', id_total, 10, 1);

  -- Уровень 2: Затраты на реализацию
  INSERT INTO public.pnl_structure (id, name, type, parent_id, sort_order, level)
  VALUES (id_realization, 'Затраты на реализацию', 'group', id_commercial, 10, 2);

  -- Уровень 3: ЗП категории
  INSERT INTO public.pnl_structure (name, type, parent_id, category, sort_order, level)
  VALUES
    ('ЗП (Менеджеры)', 'category', id_realization, 'ЗП МЕН', 10, 3),
    ('ЗП (РОПЫ)',      'category', id_realization, 'ЗП РОП', 20, 3),
    ('ЗП (Логисты)',   'category', id_realization, 'ЗП ЛОГ', 30, 3);

  -- Уровень 2: Затраты на маркетинг
  INSERT INTO public.pnl_structure (id, name, type, parent_id, sort_order, level)
  VALUES (id_mkt_grp, 'Затраты на маркетинг', 'group', id_commercial, 20, 2);

  -- Уровень 3: Маркетинг
  INSERT INTO public.pnl_structure (name, type, parent_id, category, sort_order, level)
  VALUES
    ('Маркетинг',  'category', id_mkt_grp, 'Маркетинг',  10, 3),
    ('Колл-центр', 'category', id_mkt_grp, 'Колл-центр', 20, 3);

  -- ── Уровень 1: Косвенные расходы ──────────────────────────────────────────
  INSERT INTO public.pnl_structure (id, name, type, parent_id, sort_order, level)
  VALUES (id_indirect, 'Косвенные расходы', 'group', id_total, 20, 1);

  -- Уровень 2: Административные расходы
  INSERT INTO public.pnl_structure (id, name, type, parent_id, sort_order, level)
  VALUES (id_admin, 'Административные расходы', 'group', id_indirect, 10, 2);

  -- Уровень 3: Административные категории
  INSERT INTO public.pnl_structure (name, type, parent_id, category, sort_order, level)
  VALUES
    ('Аренда офиса',             'category', id_admin, 'Аренда',                 10, 3),
    ('Склад',                    'category', id_admin, 'Склад',                  20, 3),
    ('Бухгалтерия',              'category', id_admin, 'Бухгалтерия',            30, 3),
    ('Хоз.нужды',                'category', id_admin, 'ХОЗ',                   40, 3),
    ('Найм',                     'category', id_admin, 'Найм',                   50, 3),
    ('Адаптация и мотивация',    'category', id_admin, 'Адаптация и мотивация',  60, 3),
    ('Банк',                     'category', id_admin, 'Банк',                   70, 3),
    ('IT (Абонентка)',            'category', id_admin, 'АЙТИ',                  80, 3),
    ('Прочие расходы',           'category', id_admin, 'Прочие расходы',         90, 3),
    ('Юр.услуги и безопасность', 'category', id_admin, 'Юр услуги и без',       100, 3),
    ('Курьеры',                  'category', id_admin, 'Курьеры',               110, 3);

  -- Уровень 2: Расходы на развитие
  INSERT INTO public.pnl_structure (id, name, type, parent_id, sort_order, level)
  VALUES (id_development, 'Расходы на развитие', 'group', id_indirect, 20, 2);

  -- Уровень 3: Разработка IT
  INSERT INTO public.pnl_structure (name, type, parent_id, category, sort_order, level)
  VALUES ('Разработка IT', 'category', id_development, 'Разработка IT', 10, 3);
END $$;
