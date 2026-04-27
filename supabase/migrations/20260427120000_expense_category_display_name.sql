-- Подпись категории в интерфейсе (значение в расходах остаётся name)

alter table public.expense_categories
  add column if not exists display_name text;

comment on column public.expense_categories.display_name is
  'Отображаемое название; если null или пусто — показывается name';
