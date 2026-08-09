-- Krok 1: niezmienna kopia źródłowego JSON-a przed normalizacją.
-- Skrypt jest idempotentny: ten sam stan danych nie zostanie zapisany drugi raz.

begin;

create schema if not exists private;

create table if not exists private.trip_state_backups (
  backup_id uuid primary key default gen_random_uuid(),
  trip_state_id uuid not null,
  data jsonb not null,
  source_updated_at timestamptz,
  backed_up_at timestamptz not null default now(),
  data_md5 text not null
);

revoke all on schema private from public, anon, authenticated;
revoke all on table private.trip_state_backups from public, anon, authenticated;

insert into private.trip_state_backups (
  trip_state_id,
  data,
  source_updated_at,
  data_md5
)
select
  id,
  data,
  updated_at,
  md5(data::text)
from public.trip_state
where id = '00000000-0000-0000-0000-000000002027'
  and not exists (
    select 1
    from private.trip_state_backups as backup
    where backup.trip_state_id = public.trip_state.id
      and backup.data_md5 = md5(public.trip_state.data::text)
  );

commit;
