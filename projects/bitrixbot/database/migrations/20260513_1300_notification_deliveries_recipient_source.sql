-- Optional provenance for how recipient was resolved (e.g. fallback when employees row missing).
alter table if exists public.notification_deliveries
  add column if not exists recipient_source text null;
