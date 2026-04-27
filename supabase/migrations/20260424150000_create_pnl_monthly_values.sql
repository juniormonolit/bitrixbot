-- Migration: create_pnl_monthly_values
-- Ручные значения для P&L (выручка и будущие метрики)

create table if not exists public.pnl_monthly_values (
  id         uuid        primary key default gen_random_uuid(),
  year       integer     not null,
  month      integer     not null check (month between 1 and 12),
  metric     text        not null,
  amount     numeric(14, 2) not null default 0,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),

  unique (year, month, metric)
);

create index if not exists idx_pnl_monthly_values_year_metric
  on public.pnl_monthly_values (year, metric);

create or replace trigger trg_pnl_monthly_values_updated_at
  before update on public.pnl_monthly_values
  for each row
  execute function public.set_updated_at();

comment on table  public.pnl_monthly_values         is 'Ручные значения P&L по месяцам (выручка и другие метрики)';
comment on column public.pnl_monthly_values.metric  is 'Тип значения: revenue, cost, etc.';
comment on column public.pnl_monthly_values.amount  is 'Значение в рублях';
