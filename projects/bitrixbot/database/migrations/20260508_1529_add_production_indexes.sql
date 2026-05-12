-- Production indexes for ingestion tables.
-- Use IF NOT EXISTS to keep migrations idempotent.

-- public.call_events
create index if not exists call_events_occurred_at_idx
  on public.call_events (occurred_at desc);

create index if not exists call_events_manager_occurred_at_idx
  on public.call_events (manager_bitrix_user_id, occurred_at desc);

create index if not exists call_events_phone_norm_occurred_at_idx
  on public.call_events (phone_normalized, occurred_at desc);

create index if not exists call_events_crm_activity_id_idx
  on public.call_events (crm_activity_id);

create index if not exists call_events_bitrix_call_id_idx
  on public.call_events (bitrix_call_id);

-- public.deal_events
create index if not exists deal_events_occurred_at_idx
  on public.deal_events (occurred_at desc);

create index if not exists deal_events_deal_occurred_at_idx
  on public.deal_events (bitrix_deal_id, occurred_at desc);

create index if not exists deal_events_event_occurred_at_idx
  on public.deal_events (event_name, occurred_at desc);

-- public.bitrix_webhook_events
create index if not exists bitrix_webhook_events_event_received_at_idx
  on public.bitrix_webhook_events (event_name, received_at desc);

create index if not exists bitrix_webhook_events_status_received_at_idx
  on public.bitrix_webhook_events (processing_status, received_at desc);

