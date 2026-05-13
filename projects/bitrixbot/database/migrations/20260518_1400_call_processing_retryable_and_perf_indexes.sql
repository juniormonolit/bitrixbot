-- Allow retry after transient upsert failures (e.g. timeout); tighten missed_call_cases lookup indexes.

-- 1) processing_status: add retryable_error (row stays eligible for next pipeline run)
alter table public.call_event_case_processing
  drop constraint if exists call_event_case_processing_processing_status_check;

alter table public.call_event_case_processing
  add constraint call_event_case_processing_processing_status_check
  check (
    processing_status in (
      'pending',
      'processed',
      'skipped',
      'failed',
      'retryable_error'
    )
  );

-- 2) call_event_id: unique index already exists (call_event_case_processing_call_event_unique)

-- 3) missed_call_cases: recency-only index (open-case query already has partial composite from 20260513)
create index if not exists missed_call_cases_last_missed_at_desc_idx
  on public.missed_call_cases (last_missed_at desc);

-- 4) Optional: open cases by phone+manager without last_missed in key (smaller index) — covered by partial composite; skip.
