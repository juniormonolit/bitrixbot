-- Fix alerting tables id type mismatches.
-- departments.id is uuid; employees.bitrix_user_id is text.

-- Drop dependent indexes
drop index if exists public.org_resolved_hierarchy_manager_unique;
drop index if exists public.org_resolved_hierarchy_department_id_idx;
drop index if exists public.org_resolved_hierarchy_rop_id_idx;
drop index if exists public.org_resolved_hierarchy_dept_director_id_idx;
drop index if exists public.org_resolved_hierarchy_company_director_id_idx;

drop index if exists public.org_role_overrides_unique_active;
drop index if exists public.org_role_overrides_role_key_idx;
drop index if exists public.org_role_overrides_department_id_idx;

drop index if exists public.missed_call_cases_manager_id_idx;
drop index if exists public.missed_call_cases_status_idx;
drop index if exists public.missed_call_cases_status_last_missed_idx;
drop index if exists public.missed_call_cases_deal_id_idx;
drop index if exists public.missed_call_cases_phone_norm_idx;

drop index if exists public.notification_deliveries_recipient_id_idx;

-- org_resolved_hierarchy
alter table public.org_resolved_hierarchy
  alter column manager_bitrix_user_id type text using manager_bitrix_user_id::text,
  alter column department_id type uuid using null,
  alter column rop_bitrix_user_id type text using rop_bitrix_user_id::text,
  alter column department_director_bitrix_user_id type text using department_director_bitrix_user_id::text,
  alter column company_director_bitrix_user_id type text using company_director_bitrix_user_id::text;

-- org_role_overrides
alter table public.org_role_overrides
  alter column bitrix_user_id type text using bitrix_user_id::text,
  alter column department_id type uuid using null;

-- missed_call_cases
alter table public.missed_call_cases
  alter column manager_bitrix_user_id type text using manager_bitrix_user_id::text,
  alter column department_id type uuid using null;

-- notification_deliveries
alter table public.notification_deliveries
  alter column recipient_bitrix_user_id type text using recipient_bitrix_user_id::text;

-- Recreate indexes
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

create unique index if not exists org_role_overrides_unique_active
  on public.org_role_overrides (role_key, bitrix_user_id, coalesce(department_id::text, '__global__'))
  where is_active;
create index if not exists org_role_overrides_role_key_idx
  on public.org_role_overrides (role_key);
create index if not exists org_role_overrides_department_id_idx
  on public.org_role_overrides (department_id);

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

create index if not exists notification_deliveries_recipient_id_idx
  on public.notification_deliveries (recipient_bitrix_user_id);

