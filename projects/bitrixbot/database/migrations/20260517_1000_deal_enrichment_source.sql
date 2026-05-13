-- Track how deal fields were resolved on call_events / missed_call_cases.

alter table if exists public.call_events
  add column if not exists deal_enrichment_source text null;

alter table if exists public.missed_call_cases
  add column if not exists deal_enrichment_source text null;
