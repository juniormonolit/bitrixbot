-- Alerting foundation tables: hierarchy, overrides, rules, cases, deliveries.
-- Idempotent DDL where possible.

create extension if not exists pgcrypto;

-- 2) org_resolved_hierarchy
create table if not exists public.org_resolved_hierarchy (
  id uuid primary key default gen_random_uuid(),
  manager_bitrix_user_id bigint not null,
  manager_name text null,
  department_id bigint null,
  department_name text null,
  rop_bitrix_user_id bigint null,
  rop_name text null,
  department_director_bitrix_user_id bigint null,
  department_director_name text null,
  company_director_bitrix_user_id bigint null,
  company_director_name text null,
  resolved_path jsonb not null default '{}'::jsonb,
  resolved_at timestamptz not null default now(),
  source_snapshot_at timestamptz null,
  is_active boolean not null default true
);

create unique index if not exists org_resolved_hierarchy_manager_unique
  on public.org_resolved_hierarchy (manager_bitrix_user_id);

create index if not exists org_resolved_hierarchy_department_id_idx
  on public.org_resolved_hierarchy (department_id);

create index if not exists org_resolved_hierarchy_rop_id_idx
  on public.org_resolved_hierarchy (rop_bitrix_user_id);

create index if not exists org_resolved_hierarchy_dept_director_id_idx
  on public.org_resolved_hierarchy (department_director_bitrix_user_id);

create index if not exists org_resolved_hierarchy_company_director_id_idx
  on public.org_resolved_hierarchy (company_director_bitrix_user_id);

-- 4) org_role_overrides
create table if not exists public.org_role_overrides (
  id uuid primary key default gen_random_uuid(),
  bitrix_user_id bigint not null,
  role_key text not null check (role_key in ('rop','department_director','company_director')),
  department_id bigint null,
  is_active boolean not null default true,
  comment text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists org_role_overrides_unique_active
  on public.org_role_overrides (role_key, bitrix_user_id, coalesce(department_id, -1))
  where is_active;

create index if not exists org_role_overrides_role_key_idx
  on public.org_role_overrides (role_key);

create index if not exists org_role_overrides_department_id_idx
  on public.org_role_overrides (department_id);

-- updated_at trigger (reuse existing function if present)
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_updated_at_org_role_overrides on public.org_role_overrides;
create trigger set_updated_at_org_role_overrides
before update on public.org_role_overrides
for each row execute function public.set_updated_at();

-- 5) message_templates (extend existing table to support alerting)
alter table if exists public.message_templates
  add column if not exists channel text not null default 'bitrix_chat',
  add column if not exists target_role text null,
  add column if not exists description text null,
  add column if not exists is_active boolean not null default true;

-- 6) notification_rules
create table if not exists public.notification_rules (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text null,
  is_active boolean not null default true,
  sort_order integer not null default 100,
  trigger_type text not null check (trigger_type in ('missed_count','no_callback_after')),
  missed_count_from integer null,
  missed_count_to integer null,
  delay_minutes integer null,
  recipient_roles jsonb not null default '[]'::jsonb,
  template_mode text not null default 'by_role',
  stop_processing boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists set_updated_at_notification_rules on public.notification_rules;
create trigger set_updated_at_notification_rules
before update on public.notification_rules
for each row execute function public.set_updated_at();

create index if not exists notification_rules_active_sort_idx
  on public.notification_rules (is_active, sort_order asc);

create index if not exists notification_rules_trigger_type_idx
  on public.notification_rules (trigger_type);

-- 7) missed_call_cases
create table if not exists public.missed_call_cases (
  id uuid primary key default gen_random_uuid(),
  phone_normalized text not null,
  deal_id bigint null,
  deal_url text null,
  contact_name text null,
  manager_bitrix_user_id bigint null,
  manager_name text null,
  department_id bigint null,
  missed_count integer not null default 1,
  first_missed_at timestamptz not null,
  last_missed_at timestamptz not null,
  last_outbound_at timestamptz null,
  last_successful_callback_at timestamptz null,
  status text not null default 'open' check (status in ('open','resolved','closed','escalated')),
  last_triggered_rule_id uuid null,
  last_triggered_at timestamptz null,
  context jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists set_updated_at_missed_call_cases on public.missed_call_cases;
create trigger set_updated_at_missed_call_cases
before update on public.missed_call_cases
for each row execute function public.set_updated_at();

create index if not exists missed_call_cases_phone_norm_idx
  on public.missed_call_cases (phone_normalized);

create index if not exists missed_call_cases_deal_id_idx
  on public.missed_call_cases (deal_id);

create index if not exists missed_call_cases_manager_id_idx
  on public.missed_call_cases (manager_bitrix_user_id);

create index if not exists missed_call_cases_status_idx
  on public.missed_call_cases (status);

create index if not exists missed_call_cases_status_last_missed_idx
  on public.missed_call_cases (status, last_missed_at desc);

-- 8) notification_deliveries
create table if not exists public.notification_deliveries (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references public.missed_call_cases(id) on delete cascade,
  rule_id uuid null references public.notification_rules(id) on delete set null,
  template_id uuid null references public.message_templates(id) on delete set null,
  recipient_role text not null check (recipient_role in ('manager','rop','department_director','company_director')),
  recipient_bitrix_user_id bigint null,
  recipient_name text null,
  message_text text not null,
  delivery_status text not null default 'pending' check (delivery_status in ('pending','sent','failed','skipped')),
  provider_name text not null default 'bitrix_bot',
  provider_message_id text null,
  error_message text null,
  sent_at timestamptz null,
  created_at timestamptz not null default now()
);

create index if not exists notification_deliveries_case_id_idx
  on public.notification_deliveries (case_id);

create index if not exists notification_deliveries_rule_id_idx
  on public.notification_deliveries (rule_id);

create index if not exists notification_deliveries_recipient_id_idx
  on public.notification_deliveries (recipient_bitrix_user_id);

create index if not exists notification_deliveries_status_idx
  on public.notification_deliveries (delivery_status);

create index if not exists notification_deliveries_created_at_idx
  on public.notification_deliveries (created_at desc);

-- Seeds: message templates (by role)
insert into public.message_templates (code, name, body, channel, target_role, description, is_active)
values
  ('missed_count_manager_default', 'Пропущенные: менеджер',
   '{message}\nМенеджер: {manager_name}\nТелефон: {phone}\nСделка: {deal_url}',
   'bitrix_chat', 'manager', 'Шаблон для менеджера при пропущенных', true),
  ('missed_count_rop_default', 'Пропущенные: РОП',
   '{message}\nМенеджер: {manager_name}\nТелефон: {phone}\nСделка: {deal_url}',
   'bitrix_chat', 'rop', 'Шаблон для РОП при пропущенных', true),
  ('missed_count_department_director_default', 'Пропущенные: директор департамента',
   '{message}\nМенеджер: {manager_name}\nТелефон: {phone}\nСделка: {deal_url}',
   'bitrix_chat', 'department_director', 'Шаблон для директора департамента при пропущенных', true),
  ('missed_count_company_director_default', 'Пропущенные: директор компании',
   '{message}\nМенеджер: {manager_name}\nТелефон: {phone}\nСделка: {deal_url}',
   'bitrix_chat', 'company_director', 'Шаблон для директора компании при пропущенных', true)
on conflict (code) do update
set name = excluded.name,
    body = excluded.body,
    channel = excluded.channel,
    target_role = excluded.target_role,
    description = excluded.description,
    is_active = excluded.is_active,
    updated_at = now();

-- Seeds: notification rules
insert into public.notification_rules (
  name, description, is_active, sort_order, trigger_type,
  missed_count_from, missed_count_to, delay_minutes,
  recipient_roles, template_mode, stop_processing
)
values
  ('1 missed: manager+rop', '1 пропущенный подряд', true, 10, 'missed_count', 1, 1, null,
   '["manager","rop"]'::jsonb, 'by_role', false),
  ('2 missed: +dept director', '2 пропущенных подряд', true, 20, 'missed_count', 2, 2, null,
   '["manager","rop","department_director"]'::jsonb, 'by_role', false),
  ('3+ missed: +company director', '3 и более пропущенных подряд', true, 30, 'missed_count', 3, null, null,
   '["manager","rop","department_director","company_director"]'::jsonb, 'by_role', true),
  ('no callback after 15m (disabled)', 'Нет обратного звонка через 15 минут', false, 100, 'no_callback_after', null, null, 15,
   '["rop"]'::jsonb, 'by_role', false);

