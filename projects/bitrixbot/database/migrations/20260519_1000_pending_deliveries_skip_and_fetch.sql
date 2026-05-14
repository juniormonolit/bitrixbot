-- Batch-skip invalid/stale pending notification_deliveries (manual action).
-- Fetch valid pending for sender: newest first, excludes bad recipients and "Не назначен" placeholders.

create or replace function public.skip_invalid_pending_notification_deliveries(
  p_limit int default 5000,
  p_stale_minutes int default 30
)
returns jsonb
language sql
security definer
set search_path = public
as $$
  with eligible as (
    select
      nd.id,
      case
        when nd.recipient_bitrix_user_id is null
          or btrim(coalesce(nd.recipient_bitrix_user_id, '')) = ''
          or nd.recipient_bitrix_user_id = '0'
          then 'invalid_recipient'
        when coalesce(nd.message_text, '') ilike '%Менеджер: Не назначен%'
          then 'manager_not_assigned_placeholder'
        when coalesce(nd.message_text, '') ilike '%Основной получатель: Не назначен%'
          then 'primary_recipient_not_assigned_placeholder'
        when nd.created_at < now() - (p_stale_minutes * interval '1 minute')
          then 'stale_pending'
      end as skip_reason
    from public.notification_deliveries nd
    where nd.delivery_status = 'pending'
      and (
        nd.recipient_bitrix_user_id is null
        or btrim(coalesce(nd.recipient_bitrix_user_id, '')) = ''
        or nd.recipient_bitrix_user_id = '0'
        or coalesce(nd.message_text, '') ilike '%Менеджер: Не назначен%'
        or coalesce(nd.message_text, '') ilike '%Основной получатель: Не назначен%'
        or nd.created_at < now() - (p_stale_minutes * interval '1 minute')
      )
    order by nd.created_at asc
    limit case when coalesce(p_limit, 0) < 1 then 2147483647 else p_limit end
  ),
  upd as (
    update public.notification_deliveries n
    set
      delivery_status = 'skipped',
      error_message = 'manual_skip_invalid:' || e.skip_reason
    from eligible e
    where n.id = e.id
    returning e.skip_reason
  )
  select jsonb_build_object(
    'candidates_in_batch', (select count(*)::int from eligible),
    'skipped', (select count(*)::int from upd),
    'reasons',
    coalesce(
      (
        select jsonb_object_agg(skip_reason, cnt)
        from (select skip_reason, count(*)::int as cnt from upd group by skip_reason) s
      ),
      '{}'::jsonb
    )
  );
$$;

comment on function public.skip_invalid_pending_notification_deliveries(int, int) is
  'Manual cleanup: marks pending rows skipped when recipient invalid/zero, placeholder text, or older than stale window.';

create or replace function public.fetch_valid_pending_notification_deliveries(p_limit int default 50)
returns table (
  id uuid,
  case_id uuid,
  rule_id uuid,
  recipient_role text,
  recipient_bitrix_user_id text,
  recipient_name text,
  message_text text,
  delivery_status text,
  created_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select
    nd.id,
    nd.case_id,
    nd.rule_id,
    nd.recipient_role,
    nd.recipient_bitrix_user_id,
    nd.recipient_name,
    nd.message_text,
    nd.delivery_status,
    nd.created_at
  from public.notification_deliveries nd
  where nd.delivery_status = 'pending'
    and nd.recipient_bitrix_user_id is not null
    and btrim(nd.recipient_bitrix_user_id) <> ''
    and nd.recipient_bitrix_user_id <> '0'
    and coalesce(nd.message_text, '') not ilike '%Менеджер: Не назначен%'
    and coalesce(nd.message_text, '') not ilike '%Основной получатель: Не назначен%'
  order by nd.created_at desc
  limit case when coalesce(p_limit, 0) < 1 then 1 else p_limit end;
$$;

comment on function public.fetch_valid_pending_notification_deliveries(int) is
  'Returns newest valid pending deliveries for the sender (excludes bad recipient and placeholder lines).';

revoke all on function public.skip_invalid_pending_notification_deliveries(int, int) from public;
grant execute on function public.skip_invalid_pending_notification_deliveries(int, int) to service_role;

revoke all on function public.fetch_valid_pending_notification_deliveries(int) from public;
grant execute on function public.fetch_valid_pending_notification_deliveries(int) to service_role;
