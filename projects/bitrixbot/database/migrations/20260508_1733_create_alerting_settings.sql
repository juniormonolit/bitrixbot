-- Global alerting settings (kill switch, mirror-to-me, dry run).
-- Safe by default: real sending is disabled.

create extension if not exists pgcrypto;

create table if not exists public.alerting_settings (
  id uuid primary key default gen_random_uuid(),
  settings_key text not null unique,
  settings_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- updated_at trigger
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_updated_at_alerting_settings on public.alerting_settings;
create trigger set_updated_at_alerting_settings
before update on public.alerting_settings
for each row execute function public.set_updated_at();

-- seed global settings (safe by default)
insert into public.alerting_settings (settings_key, settings_payload)
values (
  'global',
  '{
    "sending_enabled": false,
    "mirror_enabled": true,
    "mirror_bitrix_user_id": "2089",
    "dry_run_mode": true,
    "updated_by": null,
    "updated_reason": null
  }'::jsonb
)
on conflict (settings_key) do update
set settings_payload = excluded.settings_payload,
    updated_at = now();

