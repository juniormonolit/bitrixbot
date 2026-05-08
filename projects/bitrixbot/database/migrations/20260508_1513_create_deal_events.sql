-- Foundation: normalized deal events (no Bitrix runtime calls).

create extension if not exists pgcrypto;

create table if not exists public.deal_events (
  id uuid primary key default gen_random_uuid(),
  event_name text not null,
  bitrix_deal_id text not null,
  stage_id text null,
  category_id text null,
  assigned_by_id text null,
  created_by_id text null,
  title text null,
  opportunity numeric null,
  currency text null,
  is_new boolean not null default false,
  occurred_at timestamptz not null default now(),
  raw_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz default now()
);

