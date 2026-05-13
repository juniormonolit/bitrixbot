-- Department heads from Bitrix (UF_HEAD) + optional explicit director id for hierarchy resolution.

alter table if exists public.departments
  add column if not exists head_bitrix_user_id text null;

alter table if exists public.departments
  add column if not exists director_bitrix_user_id text null;

create index if not exists departments_head_bitrix_user_id_idx
  on public.departments (head_bitrix_user_id)
  where head_bitrix_user_id is not null;
