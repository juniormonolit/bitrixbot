-- Allow storing call events even when manager user id is missing.
-- We prefer saving incomplete call_events over dropping them.

alter table if exists public.call_events
  alter column manager_bitrix_user_id drop not null;

