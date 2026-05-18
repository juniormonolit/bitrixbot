-- Allow resolving missed-call cases when any successful contact happened after the miss.

alter table public.missed_call_cases drop constraint if exists missed_call_cases_status_check;

alter table public.missed_call_cases
  add constraint missed_call_cases_status_check
  check (status in ('open','resolved','resolved_after_contact','closed','escalated'));
