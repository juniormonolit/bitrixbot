-- Foundation: raw Bitrix webhook events storage (no RLS by request)

create extension if not exists pgcrypto;

create table if not exists public.bitrix_webhook_events (
  id uuid primary key default gen_random_uuid(),
  event_name text null,
  event_token text null,
  dedupe_key text null,
  payload jsonb not null default '{}'::jsonb,
  received_at timestamptz not null default now(),
  processing_status text not null default 'pending' check (processing_status in ('pending','processed','ignored','failed')),
  error_message text null
);

create index if not exists bitrix_webhook_events_received_at_idx
  on public.bitrix_webhook_events (received_at desc);

create index if not exists bitrix_webhook_events_event_name_idx
  on public.bitrix_webhook_events (event_name);

create unique index if not exists bitrix_webhook_events_dedupe_key_unique
  on public.bitrix_webhook_events (dedupe_key)
  where dedupe_key is not null;

