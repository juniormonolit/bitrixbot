-- Migration: create_expenses
-- Created: 2026-04-24

create table if not exists public.expenses (
  id               uuid                     primary key default gen_random_uuid(),
  external_number  text                     not null unique,
  document_title   text,
  expense_date     timestamp with time zone not null,
  contractor       text,
  comment          text,
  amount           numeric(14, 2)           not null default 0,
  category         text,
  source           text                     default 'excel',
  raw_row          jsonb,
  created_at       timestamp with time zone default now(),
  updated_at       timestamp with time zone default now()
);

-- Indexes
create index if not exists idx_expenses_expense_date on public.expenses (expense_date);
create index if not exists idx_expenses_category     on public.expenses (category);
create index if not exists idx_expenses_contractor   on public.expenses (contractor);

-- Trigger: keep updated_at fresh on every row update
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create or replace trigger trg_expenses_updated_at
  before update on public.expenses
  for each row
  execute function public.set_updated_at();

-- RLS: disabled intentionally for internal MVP
-- alter table public.expenses enable row level security;

comment on table  public.expenses                is 'Расходы, импортированные из Excel или других источников';
comment on column public.expenses.external_number is 'Уникальный номер расхода из источника (например МС00-000023)';
comment on column public.expenses.document_title  is 'Полный текст документа из источника';
comment on column public.expenses.expense_date    is 'Дата создания расхода в источнике';
comment on column public.expenses.raw_row         is 'Сырые данные строки из Excel (все колонки как есть)';
comment on column public.expenses.source          is 'Источник данных: excel, api, manual и т.д.';
