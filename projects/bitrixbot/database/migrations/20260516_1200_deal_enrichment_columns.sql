-- Deal enrichment from CRM activity (crm.activity.get) for missed-call pipeline.

alter table if exists public.call_events
  add column if not exists deal_title text null,
  add column if not exists deal_url text null,
  add column if not exists deal_enriched_at timestamptz null,
  add column if not exists deal_enrichment_error text null;

alter table if exists public.missed_call_cases
  add column if not exists deal_title text null,
  add column if not exists deal_enriched_at timestamptz null,
  add column if not exists deal_enrichment_error text null;
