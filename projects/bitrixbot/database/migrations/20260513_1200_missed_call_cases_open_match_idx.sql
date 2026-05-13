-- Composite index for open-case lookup by phone + manager + recency (process missed calls / dedupe).
-- Partial index keeps size smaller (only open cases).

create index if not exists missed_call_cases_open_phone_mgr_last_idx
  on public.missed_call_cases (status, phone_normalized, manager_bitrix_user_id, last_missed_at desc)
  where status = 'open';
