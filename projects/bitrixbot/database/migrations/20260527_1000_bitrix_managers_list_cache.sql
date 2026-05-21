-- Slim cache for mlt.managers.list (heavy full-profile REST response).

create table if not exists public.bitrix_managers_list_cache (
  cache_key text primary key default 'default',
  rows jsonb not null default '[]'::jsonb,
  row_count integer not null default 0,
  fetched_at timestamptz not null default now()
);

create index if not exists bitrix_managers_list_cache_fetched_at_idx
  on public.bitrix_managers_list_cache (fetched_at desc);
