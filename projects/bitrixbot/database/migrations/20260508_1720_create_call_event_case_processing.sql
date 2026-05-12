-- Idempotent processing state for call_events -> missed_call_cases pipeline.

create extension if not exists pgcrypto;

create table if not exists public.call_event_case_processing (
  id uuid primary key default gen_random_uuid(),
  call_event_id uuid not null,
  bitrix_call_id text null,
  processing_status text not null default 'pending' check (processing_status in ('pending','processed','skipped','failed')),
  case_id uuid null references public.missed_call_cases(id) on delete set null,
  processing_attempts integer not null default 0,
  processed_at timestamptz null,
  error_message text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists call_event_case_processing_call_event_unique
  on public.call_event_case_processing (call_event_id);

create index if not exists call_event_case_processing_status_idx
  on public.call_event_case_processing (processing_status);

create index if not exists call_event_case_processing_created_at_idx
  on public.call_event_case_processing (created_at desc);

create index if not exists call_event_case_processing_case_id_idx
  on public.call_event_case_processing (case_id);

-- updated_at trigger
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_updated_at_call_event_case_processing on public.call_event_case_processing;
create trigger set_updated_at_call_event_case_processing
before update on public.call_event_case_processing
for each row execute function public.set_updated_at();

