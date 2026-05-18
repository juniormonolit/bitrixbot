-- Webhook-first: local deals + phone indexes (no Bitrix REST lookups at runtime).

create table if not exists public.deals (
  bitrix_deal_id text primary key,
  title text null,
  stage_id text null,
  category_id text null,
  assigned_by_id text null,
  contact_id text null,
  company_id text null,
  stage_semantic_id text null,
  is_archived boolean not null default false,
  updated_at_source timestamptz null,
  raw_snapshot jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists deals_assigned_by_idx on public.deals (assigned_by_id);
create index if not exists deals_updated_source_idx on public.deals (updated_at_source desc nulls last);
create index if not exists deals_archived_idx on public.deals (is_archived);

drop trigger if exists set_updated_at_deals on public.deals;
create trigger set_updated_at_deals
before update on public.deals
for each row execute function public.set_updated_at();

create table if not exists public.deal_phone_index (
  phone_normalized text not null,
  bitrix_deal_id text not null references public.deals (bitrix_deal_id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (phone_normalized, bitrix_deal_id)
);

create index if not exists deal_phone_index_phone_idx on public.deal_phone_index (phone_normalized);

create table if not exists public.crm_phone_index (
  phone_normalized text not null,
  entity_type text not null check (entity_type in ('deal', 'contact', 'company')),
  entity_id text not null,
  bitrix_deal_id text null references public.deals (bitrix_deal_id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (phone_normalized, entity_type, entity_id)
);

create index if not exists crm_phone_index_phone_idx on public.crm_phone_index (phone_normalized);
