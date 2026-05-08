-- Store key Voximplant CALLEND fields on call_events for later processing.

alter table if exists public.call_events
  add column if not exists call_type_raw text null,
  add column if not exists call_duration_seconds int null,
  add column if not exists failed_code text null,
  add column if not exists failed_reason text null,
  add column if not exists call_started_at timestamptz null;

