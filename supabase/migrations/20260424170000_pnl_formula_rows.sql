-- Migration: pnl_formula_rows
-- Добавляет formula/manual строки в pnl_structure (Выручка ИТОГО, Валовая прибыль, EBITDA, Чистая прибыль)

-- 1. Расширяем check-constraint: добавляем 'manual'
alter table public.pnl_structure
  drop constraint if exists pnl_structure_type_check;

alter table public.pnl_structure
  add constraint pnl_structure_type_check
  check (type in ('category', 'group', 'formula', 'manual'));

-- 2. Добавляем колонку key — ключ строки для ссылок в формулах
alter table public.pnl_structure
  add column if not exists key text null;

comment on column public.pnl_structure.key    is 'Ключ строки для ссылок в формулах (revenue, expenses_total, gross_profit, ebitda, net_profit)';
comment on column public.pnl_structure.formula is 'JSON-формула для type=formula: {"op":"subtract","left":"revenue","right":"expenses_total"}';

-- 3. Простановка ключа на существующую строку "Расходы всего"
update public.pnl_structure
  set key = 'expenses_total'
  where id = 'b0000000-0000-0000-0000-000000000001';

-- 4. Вставка "Выручка ИТОГО" (manual — значения из pnl_monthly_values)
insert into public.pnl_structure (id, name, type, key, category, sort_order, level, parent_id)
values (
  'a0000000-0000-0000-0000-000000000001',
  'Выручка ИТОГО', 'manual', 'revenue', 'revenue', 5, 0, null
)
on conflict (id) do nothing;

-- 5. Вставка формульных строк
insert into public.pnl_structure (id, name, type, key, formula, sort_order, level, parent_id)
values
  (
    'f0000000-0000-0000-0000-000000000001',
    'Валовая прибыль',
    'formula', 'gross_profit',
    '{"op":"subtract","left":"revenue","right":"expenses_total"}',
    20, 0, null
  ),
  (
    'f0000000-0000-0000-0000-000000000002',
    'Операционная прибыль (EBITDA)',
    'formula', 'ebitda',
    '{"op":"subtract","left":"revenue","right":"expenses_total"}',
    30, 0, null
  ),
  (
    'f0000000-0000-0000-0000-000000000003',
    'Чистая прибыль',
    'formula', 'net_profit',
    '{"op":"subtract","left":"revenue","right":"expenses_total"}',
    40, 0, null
  )
on conflict (id) do nothing;
