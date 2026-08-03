create table if not exists public.trip_state (
  id uuid primary key,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.trip_state enable row level security;

grant select, update on table public.trip_state to anon, authenticated;
revoke insert, delete on table public.trip_state from anon, authenticated;

drop policy if exists "Trip state is readable" on public.trip_state;
create policy "Trip state is readable"
on public.trip_state for select
to anon, authenticated
using (id = '00000000-0000-0000-0000-000000002027'::uuid);

drop policy if exists "Trip state can be synchronized" on public.trip_state;
create policy "Trip state can be synchronized"
on public.trip_state for update
to anon, authenticated
using (id = '00000000-0000-0000-0000-000000002027'::uuid)
with check (id = '00000000-0000-0000-0000-000000002027'::uuid);

insert into public.trip_state (id, data)
values ('00000000-0000-0000-0000-000000002027'::uuid, '{}'::jsonb)
on conflict (id) do nothing;

do $$
begin
  alter publication supabase_realtime add table public.trip_state;
exception
  when duplicate_object then null;
end $$;
