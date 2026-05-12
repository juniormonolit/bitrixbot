-- SLA execution dedupe layer: one case + one rule = one execution record.

create extension if not exists pgcrypto;

create table if not exists public.case_rule_executions (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references public.missed_call_cases(id) on delete cascade,
  rule_id uuid not null references public.notification_rules(id) on delete cascade,
  execution_status text not null default 'pending' check (execution_status in ('pending','executed','cancelled','obsolete')),
  triggered_at timestamptz not null default now(),
  resolved_at timestamptz null,
  notes text null,
  created_at timestamptz not null default now()
);

create unique index if not exists case_rule_executions_case_rule_unique
  on public.case_rule_executions (case_id, rule_id);

create index if not exists case_rule_executions_status_idx
  on public.case_rule_executions (execution_status);

create index if not exists case_rule_executions_triggered_at_idx
  on public.case_rule_executions (triggered_at desc);

