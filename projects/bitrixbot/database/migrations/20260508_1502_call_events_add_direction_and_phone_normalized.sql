-- Add call direction + normalized phone for analytics/useful grouping.

alter table if exists public.call_events
  add column if not exists call_direction text null,
  add column if not exists phone_normalized text null;

