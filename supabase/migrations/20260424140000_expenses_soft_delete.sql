-- Migration: expenses_soft_delete
-- Добавляет поля soft-delete в таблицу expenses

alter table public.expenses
  add column if not exists deleted_at     timestamptz null,
  add column if not exists deleted_reason text        null;

create index if not exists idx_expenses_deleted_at
  on public.expenses (deleted_at);

comment on column public.expenses.deleted_at     is 'Дата мягкого удаления. NULL = активная запись.';
comment on column public.expenses.deleted_reason is 'Причина удаления (опционально)';
