-- Single-flight lock for cron: POST /api/internal/alerting/run-alerting-cycle

create table if not exists public.alerting_cycle_lease (
  singleton text primary key check (singleton = 'default'),
  locked_until timestamptz not null default '1970-01-01Z',
  worker_id text
);

insert into public.alerting_cycle_lease (singleton, locked_until)
values ('default', '1970-01-01Z')
on conflict (singleton) do nothing;

create or replace function public.try_acquire_alerting_cycle_lease(p_lease_seconds int)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  n int;
begin
  if p_lease_seconds is null or p_lease_seconds < 1 then
    p_lease_seconds := 900;
  end if;

  update public.alerting_cycle_lease
  set
    locked_until = now() + (p_lease_seconds * interval '1 second'),
    worker_id = 'lease:' || left(gen_random_uuid()::text, 12)
  where singleton = 'default'
    and locked_until < now();

  get diagnostics n = row_count;
  return n > 0;
end;
$$;

create or replace function public.release_alerting_cycle_lease()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.alerting_cycle_lease
  set locked_until = now() - interval '10 seconds',
      worker_id = null
  where singleton = 'default';
end;
$$;

comment on table public.alerting_cycle_lease is 'Ensures only one alerting cron worker runs missed-calls + pending pipeline at a time.';

revoke all on function public.try_acquire_alerting_cycle_lease(int) from public;
grant execute on function public.try_acquire_alerting_cycle_lease(int) to service_role;
revoke all on function public.release_alerting_cycle_lease() from public;
grant execute on function public.release_alerting_cycle_lease() to service_role;
