-- Mirror copies of deliveries (mirror-to-me) with dedicated log table.

create extension if not exists pgcrypto;

create table if not exists public.notification_delivery_mirrors (
  id uuid primary key default gen_random_uuid(),
  delivery_id uuid not null references public.notification_deliveries(id) on delete cascade,
  mirror_bitrix_user_id text not null,
  message_text text not null,
  delivery_status text not null default 'pending' check (delivery_status in ('pending','sent','failed','skipped')),
  provider_name text not null default 'bitrix_bot',
  provider_message_id text null,
  error_message text null,
  sent_at timestamptz null,
  created_at timestamptz not null default now()
);

create unique index if not exists notification_delivery_mirrors_unique
  on public.notification_delivery_mirrors (delivery_id, mirror_bitrix_user_id);

create index if not exists notification_delivery_mirrors_delivery_id_idx
  on public.notification_delivery_mirrors (delivery_id);

create index if not exists notification_delivery_mirrors_mirror_user_idx
  on public.notification_delivery_mirrors (mirror_bitrix_user_id);

create index if not exists notification_delivery_mirrors_status_idx
  on public.notification_delivery_mirrors (delivery_status);

