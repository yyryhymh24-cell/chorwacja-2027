-- Chorwacja 2027: bezpieczna normalizacja trip_state do tabel relacyjnych.
-- Stary trip_state i wcześniejsze tabele pozostają zachowane jako kopia/rollback.

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

insert into private.trip_state_backups (trip_state_id, data, source_updated_at, data_md5)
select id, data, updated_at, md5(data::text)
from public.trip_state
where id = '00000000-0000-0000-0000-000000002027'
  and not exists (
    select 1
    from private.trip_state_backups b
    where b.trip_state_id = public.trip_state.id
      and b.data_md5 = md5(public.trip_state.data::text)
  );

-- trip_state zawiera wpłaty, kontakty i inne dane grupy, więc nie jest publiczny.
drop policy if exists "Trip state can be synchronized" on public.trip_state;
drop policy if exists "Trip state is readable" on public.trip_state;
revoke all on table public.trip_state from anon, authenticated;

-- Zachowaj poprzednią, częściową próbę modelu relacyjnego bez utraty danych.
drop trigger if exists on_auth_user_created on auth.users;
drop function if exists private.create_profile_for_new_user();

do $$
begin
  if to_regclass('public.legacy_v1_profiles') is null and to_regclass('public.profiles') is not null then
    alter table public.profiles rename to legacy_v1_profiles;
  end if;
  if to_regclass('public.legacy_v1_trips') is null and to_regclass('public.trips') is not null then
    alter table public.trips rename to legacy_v1_trips;
  end if;
  if to_regclass('public.legacy_v1_trip_members') is null and to_regclass('public.trip_members') is not null then
    alter table public.trip_members rename to legacy_v1_trip_members;
  end if;
  if to_regclass('public.legacy_v1_expenses') is null and to_regclass('public.expenses') is not null then
    alter table public.expenses rename to legacy_v1_expenses;
  end if;
  if to_regclass('public.legacy_v1_expense_shares') is null and to_regclass('public.expense_shares') is not null then
    alter table public.expense_shares rename to legacy_v1_expense_shares;
  end if;
  if to_regclass('public.legacy_v1_payments') is null and to_regclass('public.payments') is not null then
    alter table public.payments rename to legacy_v1_payments;
  end if;
  if to_regclass('public.legacy_v1_checklist_items') is null and to_regclass('public.checklist_items') is not null then
    alter table public.checklist_items rename to legacy_v1_checklist_items;
  end if;
  if to_regclass('public.legacy_v1_checklist_completions') is null and to_regclass('public.checklist_completions') is not null then
    alter table public.checklist_completions rename to legacy_v1_checklist_completions;
  end if;
  if to_regclass('public.legacy_v1_plan_items') is null and to_regclass('public.plan_items') is not null then
    alter table public.plan_items rename to legacy_v1_plan_items;
  end if;
  if to_regclass('public.legacy_v1_route_stops') is null and to_regclass('public.route_stops') is not null then
    alter table public.route_stops rename to legacy_v1_route_stops;
  end if;
end $$;

create table public.trips (
  id uuid primary key,
  name text not null check (char_length(name) between 1 and 120),
  destination text not null check (char_length(destination) between 1 and 160),
  start_date date not null,
  end_date date not null,
  participant_limit smallint not null default 7 check (participant_limit between 1 and 50),
  budget numeric(12,2) not null default 0 check (budget >= 0),
  currency text not null default 'PLN' check (currency ~ '^[A-Z]{3}$'),
  description text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (end_date >= start_date)
);

create table public.trip_members (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips(id) on delete cascade,
  auth_user_id uuid references auth.users(id) on delete set null,
  legacy_key text not null,
  display_name text not null check (char_length(display_name) between 1 and 80),
  role text not null default 'user' check (role in ('admin', 'user')),
  status text not null default 'pending' check (status in ('active', 'pending')),
  sort_order smallint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, trip_id),
  unique (trip_id, legacy_key),
  check ((status = 'active' and auth_user_id is not null) or status = 'pending')
);

create unique index trip_members_trip_auth_user_uidx
  on public.trip_members (trip_id, auth_user_id)
  where auth_user_id is not null;
create index trip_members_auth_user_idx on public.trip_members (auth_user_id);
create index trip_members_trip_sort_idx on public.trip_members (trip_id, sort_order);

create table public.expenses (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips(id) on delete cascade,
  owner_member_id uuid not null,
  source_key text,
  name text not null check (char_length(name) between 1 and 160),
  category text not null default 'Inne',
  amount numeric(12,2) not null check (amount >= 0),
  status text not null default 'planned' check (status in ('planned', 'paid')),
  expense_date date not null default current_date,
  note text not null default '',
  has_deposit boolean not null default false,
  deposit_amount numeric(12,2) not null default 0 check (deposit_amount >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, trip_id),
  foreign key (owner_member_id, trip_id)
    references public.trip_members(id, trip_id) on delete restrict,
  check ((has_deposit and deposit_amount > 0) or (not has_deposit and deposit_amount = 0))
);

create unique index expenses_trip_source_uidx
  on public.expenses (trip_id, source_key)
  where source_key is not null;
create index expenses_trip_date_idx on public.expenses (trip_id, expense_date desc);
create index expenses_owner_idx on public.expenses (owner_member_id);

create table public.expense_participants (
  expense_id uuid not null,
  trip_id uuid not null,
  member_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (expense_id, member_id),
  foreign key (expense_id, trip_id)
    references public.expenses(id, trip_id) on delete cascade,
  foreign key (member_id, trip_id)
    references public.trip_members(id, trip_id) on delete restrict
);

create index expense_participants_trip_idx on public.expense_participants (trip_id);
create index expense_participants_member_idx on public.expense_participants (member_id);

create table public.payments (
  trip_id uuid not null references public.trips(id) on delete cascade,
  member_id uuid not null,
  amount numeric(12,2) not null default 0 check (amount >= 0),
  note text not null default '',
  updated_at timestamptz not null default now(),
  primary key (trip_id, member_id),
  foreign key (member_id, trip_id)
    references public.trip_members(id, trip_id) on delete cascade
);

create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips(id) on delete cascade,
  source_key text,
  title text not null check (char_length(title) between 1 and 200),
  category text not null default 'Inne',
  deadline date,
  comment text not null default '',
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, trip_id)
);

create unique index tasks_trip_source_uidx
  on public.tasks (trip_id, source_key)
  where source_key is not null;
create index tasks_trip_sort_idx on public.tasks (trip_id, sort_order);

create table public.task_assignees (
  task_id uuid not null,
  trip_id uuid not null,
  member_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (task_id, member_id),
  foreign key (task_id, trip_id)
    references public.tasks(id, trip_id) on delete cascade,
  foreign key (member_id, trip_id)
    references public.trip_members(id, trip_id) on delete cascade
);

create index task_assignees_trip_idx on public.task_assignees (trip_id);
create index task_assignees_member_idx on public.task_assignees (member_id);

create table public.task_completions (
  task_id uuid not null,
  trip_id uuid not null,
  member_id uuid not null,
  completed_at timestamptz not null default now(),
  primary key (task_id, member_id),
  foreign key (task_id, trip_id)
    references public.tasks(id, trip_id) on delete cascade,
  foreign key (member_id, trip_id)
    references public.trip_members(id, trip_id) on delete cascade
);

create index task_completions_trip_idx on public.task_completions (trip_id);
create index task_completions_member_idx on public.task_completions (member_id);

create table public.trip_plan (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips(id) on delete cascade,
  source_key text,
  day_number smallint not null check (day_number between 1 and 60),
  plan_date date not null,
  title text not null check (char_length(title) between 1 and 160),
  description text not null default '',
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index trip_plan_trip_source_uidx
  on public.trip_plan (trip_id, source_key)
  where source_key is not null;
create index trip_plan_trip_day_idx on public.trip_plan (trip_id, day_number, sort_order);

create table public.driver_shifts (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips(id) on delete cascade,
  source_key text,
  leg text not null check (char_length(leg) between 1 and 160),
  driver_member_id uuid not null,
  backup_member_id uuid not null,
  start_at timestamptz not null,
  end_at timestamptz not null,
  note text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (driver_member_id, trip_id)
    references public.trip_members(id, trip_id) on delete restrict,
  foreign key (backup_member_id, trip_id)
    references public.trip_members(id, trip_id) on delete restrict,
  check (end_at > start_at)
);

create unique index driver_shifts_trip_source_uidx
  on public.driver_shifts (trip_id, source_key)
  where source_key is not null;
create index driver_shifts_trip_start_idx on public.driver_shifts (trip_id, start_at);

create table public.documents (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips(id) on delete cascade,
  source_key text,
  title text not null check (char_length(title) between 1 and 120),
  document_type text not null default 'Inne',
  url text not null check (url ~ '^https://'),
  note text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index documents_trip_source_uidx
  on public.documents (trip_id, source_key)
  where source_key is not null;
create index documents_trip_idx on public.documents (trip_id);

create table public.emergency_contacts (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips(id) on delete cascade,
  source_key text,
  name text not null check (char_length(name) between 1 and 120),
  phone text not null default '',
  category text not null default 'Inne',
  note text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index emergency_contacts_trip_source_uidx
  on public.emergency_contacts (trip_id, source_key)
  where source_key is not null;
create index emergency_contacts_trip_idx on public.emergency_contacts (trip_id);

create table public.payment_schedule (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips(id) on delete cascade,
  source_key text,
  title text not null check (char_length(title) between 1 and 120),
  amount_per_person numeric(12,2) not null check (amount_per_person >= 0),
  due_date date not null,
  note text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index payment_schedule_trip_source_uidx
  on public.payment_schedule (trip_id, source_key)
  where source_key is not null;
create index payment_schedule_trip_due_idx on public.payment_schedule (trip_id, due_date);

create table public.route_stops (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips(id) on delete cascade,
  source_key text,
  position integer not null check (position > 0),
  city text not null,
  country text not null,
  note text not null default '',
  distance_from_start_km numeric(9,1) not null default 0 check (distance_from_start_km >= 0),
  latitude double precision not null check (latitude between -90 and 90),
  longitude double precision not null check (longitude between -180 and 180),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (trip_id, position)
);

create index route_stops_trip_position_idx on public.route_stops (trip_id, position);

create table public.fuel_settings (
  trip_id uuid primary key references public.trips(id) on delete cascade,
  distance_km numeric(9,1) not null check (distance_km > 0),
  consumption_l_per_100km numeric(6,2) not null check (consumption_l_per_100km > 0),
  price_pln_per_l numeric(6,2) not null check (price_pln_per_l > 0),
  updated_at timestamptz not null default now()
);

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

do $$
declare
  target_table text;
begin
  foreach target_table in array array[
    'trips', 'trip_members', 'expenses', 'payments', 'tasks', 'trip_plan',
    'driver_shifts', 'documents', 'emergency_contacts', 'payment_schedule',
    'route_stops', 'fuel_settings'
  ]
  loop
    execute format('drop trigger if exists touch_updated_at on public.%I', target_table);
    execute format(
      'create trigger touch_updated_at before update on public.%I for each row execute function public.touch_updated_at()',
      target_table
    );
  end loop;
end $$;

-- Przenieś dane z aktualnej kopii JSON.
with state as (
  select data from public.trip_state
  where id = '00000000-0000-0000-0000-000000002027'
)
insert into public.trips (
  id, name, destination, start_date, end_date, participant_limit,
  budget, currency, description
)
select
  '00000000-0000-0000-0000-000000002027'::uuid,
  data->'trip'->>'name',
  data->'trip'->>'destination',
  (data->'trip'->>'start')::date,
  (data->'trip'->>'end')::date,
  (data->'trip'->>'people')::smallint,
  (data->'trip'->>'budget')::numeric,
  'PLN',
  coalesce(data->'trip'->>'description', '')
from state;

with state as (
  select data from public.trip_state
  where id = '00000000-0000-0000-0000-000000002027'
), source_users as (
  select item, ordinality::smallint as sort_order
  from state,
  jsonb_array_elements(data->'users') with ordinality as u(item, ordinality)
), previous_admin as (
  select user_id
  from public.legacy_v1_trip_members
  where trip_id = '00000000-0000-0000-0000-000000002027'
    and role = 'admin'
  order by joined_at
  limit 1
)
insert into public.trip_members (
  trip_id, auth_user_id, legacy_key, display_name, role, status, sort_order
)
select
  '00000000-0000-0000-0000-000000002027'::uuid,
  case when item->>'id' = 'admin' then (select user_id from previous_admin) end,
  item->>'id',
  item->>'name',
  case when item->>'role' = 'admin' then 'admin' else 'user' end,
  case
    when item->>'id' = 'admin' and (select user_id from previous_admin) is not null then 'active'
    else 'pending'
  end,
  sort_order
from source_users;

with state as (
  select data from public.trip_state
  where id = '00000000-0000-0000-0000-000000002027'
), source_expenses as (
  select item
  from state, jsonb_array_elements(data->'expenses') as e(item)
)
insert into public.expenses (
  trip_id, owner_member_id, source_key, name, category, amount, status,
  expense_date, note, has_deposit, deposit_amount
)
select
  '00000000-0000-0000-0000-000000002027'::uuid,
  owner_member.id,
  item->>'id',
  item->>'name',
  coalesce(item->>'category', 'Inne'),
  (item->>'amount')::numeric,
  case when item->>'status' = 'paid' then 'paid' else 'planned' end,
  (item->>'date')::date,
  coalesce(item->>'note', ''),
  coalesce((item->>'hasDeposit')::boolean, false),
  case when coalesce((item->>'hasDeposit')::boolean, false)
    then coalesce((item->>'depositAmount')::numeric, 0)
    else 0
  end
from source_expenses
join public.trip_members owner_member
  on owner_member.trip_id = '00000000-0000-0000-0000-000000002027'
 and owner_member.legacy_key = item->>'owner';

with state as (
  select data from public.trip_state
  where id = '00000000-0000-0000-0000-000000002027'
), source_expenses as (
  select item
  from state, jsonb_array_elements(data->'expenses') as e(item)
)
insert into public.expense_participants (expense_id, trip_id, member_id)
select expense.id, expense.trip_id, member.id
from source_expenses
join public.expenses expense
  on expense.trip_id = '00000000-0000-0000-0000-000000002027'
 and expense.source_key = item->>'id'
cross join lateral jsonb_array_elements_text(coalesce(item->'participants', '[]'::jsonb)) participant(legacy_key)
join public.trip_members member
  on member.trip_id = expense.trip_id
 and member.legacy_key = participant.legacy_key;

with state as (
  select data from public.trip_state
  where id = '00000000-0000-0000-0000-000000002027'
)
insert into public.payments (trip_id, member_id, amount)
select
  '00000000-0000-0000-0000-000000002027'::uuid,
  member.id,
  payment.amount::numeric
from state
cross join lateral jsonb_each_text(data->'payments') as payment(legacy_key, amount)
join public.trip_members member
  on member.trip_id = '00000000-0000-0000-0000-000000002027'
 and member.legacy_key = payment.legacy_key;

with state as (
  select data from public.trip_state
  where id = '00000000-0000-0000-0000-000000002027'
)
insert into public.tasks (
  trip_id, source_key, title, category, deadline, comment, sort_order
)
select
  '00000000-0000-0000-0000-000000002027'::uuid,
  item->>'id',
  item->>'title',
  coalesce(item->>'category', 'Inne'),
  nullif(item->>'deadline', '')::date,
  coalesce(item->>'comment', ''),
  ordinality::integer
from state,
jsonb_array_elements(data->'tasks') with ordinality as task(item, ordinality);

with state as (
  select data from public.trip_state
  where id = '00000000-0000-0000-0000-000000002027'
), source_tasks as (
  select item
  from state, jsonb_array_elements(data->'tasks') as task(item)
)
insert into public.task_assignees (task_id, trip_id, member_id)
select task.id, task.trip_id, member.id
from source_tasks
join public.tasks task
  on task.trip_id = '00000000-0000-0000-0000-000000002027'
 and task.source_key = item->>'id'
join public.trip_members member on member.trip_id = task.trip_id
where exists (
    select 1 from jsonb_array_elements_text(coalesce(item->'assignees', '[]'::jsonb)) a(value)
    where a.value = 'all'
  )
   or member.legacy_key in (
    select value from jsonb_array_elements_text(coalesce(item->'assignees', '[]'::jsonb))
  );

with state as (
  select data from public.trip_state
  where id = '00000000-0000-0000-0000-000000002027'
), source_tasks as (
  select item
  from state, jsonb_array_elements(data->'tasks') as task(item)
)
insert into public.task_completions (task_id, trip_id, member_id)
select task.id, task.trip_id, member.id
from source_tasks
join public.tasks task
  on task.trip_id = '00000000-0000-0000-0000-000000002027'
 and task.source_key = item->>'id'
cross join lateral jsonb_array_elements_text(coalesce(item->'doneBy', '[]'::jsonb)) done(legacy_key)
join public.trip_members member
  on member.trip_id = task.trip_id
 and member.legacy_key = done.legacy_key;

with state as (
  select data from public.trip_state
  where id = '00000000-0000-0000-0000-000000002027'
)
insert into public.trip_plan (
  trip_id, source_key, day_number, plan_date, title, description, sort_order
)
select
  '00000000-0000-0000-0000-000000002027'::uuid,
  item->>'id',
  (item->>'day')::smallint,
  (item->>'date')::date,
  item->>'title',
  coalesce(item->>'description', ''),
  ordinality::integer
from state,
jsonb_array_elements(data->'plan') with ordinality as plan(item, ordinality);

with state as (
  select data from public.trip_state
  where id = '00000000-0000-0000-0000-000000002027'
)
insert into public.driver_shifts (
  trip_id, source_key, leg, driver_member_id, backup_member_id,
  start_at, end_at, note
)
select
  '00000000-0000-0000-0000-000000002027'::uuid,
  item->>'id',
  item->>'leg',
  driver.id,
  backup.id,
  (item->>'start')::timestamp at time zone 'Europe/Warsaw',
  (item->>'end')::timestamp at time zone 'Europe/Warsaw',
  coalesce(item->>'note', '')
from state,
jsonb_array_elements(data->'driverShifts') as shift(item)
join public.trip_members driver
  on driver.trip_id = '00000000-0000-0000-0000-000000002027'
 and driver.legacy_key = item->>'driver'
join public.trip_members backup
  on backup.trip_id = '00000000-0000-0000-0000-000000002027'
 and backup.legacy_key = item->>'backup';

with state as (
  select data from public.trip_state
  where id = '00000000-0000-0000-0000-000000002027'
)
insert into public.documents (
  trip_id, source_key, title, document_type, url, note
)
select
  '00000000-0000-0000-0000-000000002027'::uuid,
  item->>'id', item->>'title', item->>'type', item->>'url', coalesce(item->>'note', '')
from state, jsonb_array_elements(data->'documents') as document(item);

with state as (
  select data from public.trip_state
  where id = '00000000-0000-0000-0000-000000002027'
)
insert into public.emergency_contacts (
  trip_id, source_key, name, phone, category, note
)
select
  '00000000-0000-0000-0000-000000002027'::uuid,
  item->>'id', item->>'name', coalesce(item->>'phone', ''),
  coalesce(item->>'category', 'Inne'), coalesce(item->>'note', '')
from state, jsonb_array_elements(data->'emergencyContacts') as contact(item);

with state as (
  select data from public.trip_state
  where id = '00000000-0000-0000-0000-000000002027'
)
insert into public.payment_schedule (
  trip_id, source_key, title, amount_per_person, due_date, note
)
select
  '00000000-0000-0000-0000-000000002027'::uuid,
  item->>'id', item->>'title', (item->>'amount')::numeric,
  (item->>'due')::date, coalesce(item->>'note', '')
from state, jsonb_array_elements(data->'paymentSchedule') as schedule(item);

with state as (
  select data from public.trip_state
  where id = '00000000-0000-0000-0000-000000002027'
)
insert into public.route_stops (
  trip_id, source_key, position, city, country, note,
  distance_from_start_km, latitude, longitude
)
select
  '00000000-0000-0000-0000-000000002027'::uuid,
  'route-' || ordinality,
  ordinality::integer,
  item->>'city', item->>'country', coalesce(item->>'note', ''),
  (item->>'km')::numeric, (item->>'lat')::double precision,
  (item->>'lng')::double precision
from state,
jsonb_array_elements(data->'route') with ordinality as stop(item, ordinality);

with state as (
  select data from public.trip_state
  where id = '00000000-0000-0000-0000-000000002027'
)
insert into public.fuel_settings (
  trip_id, distance_km, consumption_l_per_100km, price_pln_per_l
)
select
  '00000000-0000-0000-0000-000000002027'::uuid,
  (data->'fuel'->>'distance')::numeric,
  (data->'fuel'->>'consumption')::numeric,
  (data->'fuel'->>'price')::numeric
from state;

-- Funkcje członkostwa są używane wyłącznie przez RLS.
create or replace function private.current_trip_member_id(target_trip uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select member.id
  from public.trip_members member
  where member.trip_id = target_trip
    and member.auth_user_id = (select auth.uid())
    and member.status = 'active'
  limit 1
$$;

create or replace function private.is_trip_member(target_trip uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (select auth.uid()) is not null and exists (
    select 1
    from public.trip_members member
    where member.trip_id = target_trip
      and member.auth_user_id = (select auth.uid())
      and member.status = 'active'
  )
$$;

create or replace function private.is_trip_admin(target_trip uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (select auth.uid()) is not null and exists (
    select 1
    from public.trip_members member
    where member.trip_id = target_trip
      and member.auth_user_id = (select auth.uid())
      and member.status = 'active'
      and member.role = 'admin'
  )
$$;

revoke all on function private.current_trip_member_id(uuid) from public, anon;
revoke all on function private.is_trip_member(uuid) from public, anon;
revoke all on function private.is_trip_admin(uuid) from public, anon;
grant execute on function private.current_trip_member_id(uuid) to authenticated;
grant execute on function private.is_trip_member(uuid) to authenticated;
grant execute on function private.is_trip_admin(uuid) to authenticated;

-- Włącz RLS dla każdej tabeli dostępnej przez Data API.
alter table public.trips enable row level security;
alter table public.trip_members enable row level security;
alter table public.expenses enable row level security;
alter table public.expense_participants enable row level security;
alter table public.payments enable row level security;
alter table public.tasks enable row level security;
alter table public.task_assignees enable row level security;
alter table public.task_completions enable row level security;
alter table public.trip_plan enable row level security;
alter table public.driver_shifts enable row level security;
alter table public.documents enable row level security;
alter table public.emergency_contacts enable row level security;
alter table public.payment_schedule enable row level security;
alter table public.route_stops enable row level security;
alter table public.fuel_settings enable row level security;

create policy "members read their trip" on public.trips
  for select to authenticated
  using ((select private.is_trip_member(id)));
create policy "admins update their trip" on public.trips
  for update to authenticated
  using ((select private.is_trip_admin(id)))
  with check ((select private.is_trip_admin(id)));

create policy "members read trip members" on public.trip_members
  for select to authenticated
  using ((select private.is_trip_member(trip_id)));
create policy "admins manage trip members" on public.trip_members
  for all to authenticated
  using ((select private.is_trip_admin(trip_id)))
  with check ((select private.is_trip_admin(trip_id)));

create policy "members read expenses" on public.expenses
  for select to authenticated
  using ((select private.is_trip_member(trip_id)));
create policy "admins manage expenses" on public.expenses
  for all to authenticated
  using ((select private.is_trip_admin(trip_id)))
  with check ((select private.is_trip_admin(trip_id)));
create policy "users add own expenses" on public.expenses
  for insert to authenticated
  with check (
    (select private.is_trip_member(trip_id))
    and owner_member_id = (select private.current_trip_member_id(trip_id))
  );
create policy "users edit own expenses" on public.expenses
  for update to authenticated
  using (
    owner_member_id = (select private.current_trip_member_id(trip_id))
    and (select private.is_trip_member(trip_id))
  )
  with check (
    owner_member_id = (select private.current_trip_member_id(trip_id))
    and (select private.is_trip_member(trip_id))
  );

create policy "members read expense participants" on public.expense_participants
  for select to authenticated
  using ((select private.is_trip_member(trip_id)));
create policy "expense owners manage participants" on public.expense_participants
  for all to authenticated
  using (
    (select private.is_trip_admin(trip_id))
    or exists (
      select 1 from public.expenses expense
      where expense.id = expense_id
        and expense.trip_id = trip_id
        and expense.owner_member_id = (select private.current_trip_member_id(trip_id))
    )
  )
  with check (
    ((select private.is_trip_admin(trip_id))
      or exists (
        select 1 from public.expenses expense
        where expense.id = expense_id
          and expense.trip_id = trip_id
          and expense.owner_member_id = (select private.current_trip_member_id(trip_id))
      ))
    and exists (
      select 1 from public.trip_members member
      where member.id = member_id and member.trip_id = trip_id
    )
  );

create policy "members read payments" on public.payments
  for select to authenticated
  using ((select private.is_trip_member(trip_id)));
create policy "admins manage payments" on public.payments
  for all to authenticated
  using ((select private.is_trip_admin(trip_id)))
  with check ((select private.is_trip_admin(trip_id)));

create policy "members read tasks" on public.tasks
  for select to authenticated
  using ((select private.is_trip_member(trip_id)));
create policy "admins manage tasks" on public.tasks
  for all to authenticated
  using ((select private.is_trip_admin(trip_id)))
  with check ((select private.is_trip_admin(trip_id)));

create policy "members read task assignees" on public.task_assignees
  for select to authenticated
  using ((select private.is_trip_member(trip_id)));
create policy "admins manage task assignees" on public.task_assignees
  for all to authenticated
  using ((select private.is_trip_admin(trip_id)))
  with check ((select private.is_trip_admin(trip_id)));

create policy "members read task completions" on public.task_completions
  for select to authenticated
  using ((select private.is_trip_member(trip_id)));
create policy "admins manage task completions" on public.task_completions
  for all to authenticated
  using ((select private.is_trip_admin(trip_id)))
  with check ((select private.is_trip_admin(trip_id)));
create policy "users add own task completion" on public.task_completions
  for insert to authenticated
  with check (
    member_id = (select private.current_trip_member_id(trip_id))
    and (select private.is_trip_member(trip_id))
  );
create policy "users update own task completion" on public.task_completions
  for update to authenticated
  using (member_id = (select private.current_trip_member_id(trip_id)))
  with check (member_id = (select private.current_trip_member_id(trip_id)));
create policy "users remove own task completion" on public.task_completions
  for delete to authenticated
  using (member_id = (select private.current_trip_member_id(trip_id)));

-- Powtarzalny wzorzec: członkowie czytają, administrator zarządza.
create policy "members read trip plan" on public.trip_plan
  for select to authenticated using ((select private.is_trip_member(trip_id)));
create policy "admins manage trip plan" on public.trip_plan
  for all to authenticated using ((select private.is_trip_admin(trip_id)))
  with check ((select private.is_trip_admin(trip_id)));

create policy "members read driver shifts" on public.driver_shifts
  for select to authenticated using ((select private.is_trip_member(trip_id)));
create policy "admins manage driver shifts" on public.driver_shifts
  for all to authenticated using ((select private.is_trip_admin(trip_id)))
  with check ((select private.is_trip_admin(trip_id)));

create policy "members read documents" on public.documents
  for select to authenticated using ((select private.is_trip_member(trip_id)));
create policy "admins manage documents" on public.documents
  for all to authenticated using ((select private.is_trip_admin(trip_id)))
  with check ((select private.is_trip_admin(trip_id)));

create policy "members read emergency contacts" on public.emergency_contacts
  for select to authenticated using ((select private.is_trip_member(trip_id)));
create policy "admins manage emergency contacts" on public.emergency_contacts
  for all to authenticated using ((select private.is_trip_admin(trip_id)))
  with check ((select private.is_trip_admin(trip_id)));

create policy "members read payment schedule" on public.payment_schedule
  for select to authenticated using ((select private.is_trip_member(trip_id)));
create policy "admins manage payment schedule" on public.payment_schedule
  for all to authenticated using ((select private.is_trip_admin(trip_id)))
  with check ((select private.is_trip_admin(trip_id)));

create policy "members read route stops" on public.route_stops
  for select to authenticated using ((select private.is_trip_member(trip_id)));
create policy "admins manage route stops" on public.route_stops
  for all to authenticated using ((select private.is_trip_admin(trip_id)))
  with check ((select private.is_trip_admin(trip_id)));

create policy "members read fuel settings" on public.fuel_settings
  for select to authenticated using ((select private.is_trip_member(trip_id)));
create policy "admins manage fuel settings" on public.fuel_settings
  for all to authenticated using ((select private.is_trip_admin(trip_id)))
  with check ((select private.is_trip_admin(trip_id)));

-- Data API: anon nie ma dostępu; authenticated dostaje tylko operacje potrzebne aplikacji.
revoke all on all tables in schema public from anon;
revoke all on all tables in schema public from authenticated;

grant select, update on public.trips to authenticated;
grant select, insert, update, delete on public.trip_members to authenticated;
grant select, insert, update, delete on public.expenses to authenticated;
grant select, insert, update, delete on public.expense_participants to authenticated;
grant select, insert, update, delete on public.payments to authenticated;
grant select, insert, update, delete on public.tasks to authenticated;
grant select, insert, update, delete on public.task_assignees to authenticated;
grant select, insert, update, delete on public.task_completions to authenticated;
grant select, insert, update, delete on public.trip_plan to authenticated;
grant select, insert, update, delete on public.driver_shifts to authenticated;
grant select, insert, update, delete on public.documents to authenticated;
grant select, insert, update, delete on public.emergency_contacts to authenticated;
grant select, insert, update, delete on public.payment_schedule to authenticated;
grant select, insert, update, delete on public.route_stops to authenticated;
grant select, insert, update, delete on public.fuel_settings to authenticated;

alter default privileges for role postgres in schema public
  revoke select, insert, update, delete on tables from anon, authenticated;
alter default privileges for role postgres in schema public
  revoke execute on functions from public, anon, authenticated;

revoke all on function public.touch_updated_at() from public, anon, authenticated;

-- Włącz synchronizację nowych tabel między urządzeniami.
do $$
declare
  target_table text;
begin
  foreach target_table in array array[
    'trips', 'trip_members', 'expenses', 'expense_participants', 'payments',
    'tasks', 'task_assignees', 'task_completions', 'trip_plan', 'driver_shifts',
    'documents', 'emergency_contacts', 'payment_schedule', 'route_stops', 'fuel_settings'
  ]
  loop
    begin
      execute format('alter publication supabase_realtime add table public.%I', target_table);
    exception when duplicate_object then
      null;
    end;
  end loop;
end $$;

commit;
