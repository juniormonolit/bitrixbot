-- Metadata for activity/phone → deal resolution on missed_call_cases.

alter table if exists public.missed_call_cases
  add column if not exists deal_enrichment_confidence double precision null,
  add column if not exists deal_enrichment_matched_activity_id bigint null,
  add column if not exists deal_enrichment_matched_called_at timestamptz null,
  add column if not exists deal_enrichment_matched_by_phone boolean null,
  add column if not exists deal_enrichment_phone_manager_matched boolean null;
