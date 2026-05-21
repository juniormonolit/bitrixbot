-- Bitrix intranet LOGIN (not exposed by standard user.get); filled via custom REST on on-premise.

alter table if exists public.employees
  add column if not exists bitrix_login text null;

create index if not exists employees_bitrix_login_idx
  on public.employees (bitrix_login)
  where bitrix_login is not null;
