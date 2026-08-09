-- Dalsze utwardzenie po uruchomieniu Database Advisors.

begin;

-- Stary trip_state zostaje zachowany, ale jawnie odmawia dostępu klientom.
drop policy if exists "trip_state denied to clients" on public.trip_state;
create policy "trip_state denied to clients"
on public.trip_state
for all
to anon, authenticated
using (false)
with check (false);

-- Archiwalne tabele nie są częścią Data API.
do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'legacy_v1_profiles', 'legacy_v1_trips', 'legacy_v1_trip_members',
    'legacy_v1_expenses', 'legacy_v1_expense_shares', 'legacy_v1_payments',
    'legacy_v1_checklist_items', 'legacy_v1_checklist_completions',
    'legacy_v1_plan_items', 'legacy_v1_route_stops'
  ]
  loop
    if to_regclass(format('public.%I', table_name)) is not null then
      execute format('alter table public.%I set schema private', table_name);
      execute format('revoke all on table private.%I from public, anon, authenticated', table_name);
    end if;
  end loop;
end $$;

-- Indeksy pokrywające kompletne klucze obce.
create index expenses_owner_trip_idx
  on public.expenses (owner_member_id, trip_id);
create index expense_participants_expense_trip_idx
  on public.expense_participants (expense_id, trip_id);
create index expense_participants_member_trip_idx
  on public.expense_participants (member_id, trip_id);
create index payments_member_trip_idx
  on public.payments (member_id, trip_id);
create index task_assignees_task_trip_idx
  on public.task_assignees (task_id, trip_id);
create index task_assignees_member_trip_idx
  on public.task_assignees (member_id, trip_id);
create index task_completions_task_trip_idx
  on public.task_completions (task_id, trip_id);
create index task_completions_member_trip_idx
  on public.task_completions (member_id, trip_id);
create index driver_shifts_driver_trip_idx
  on public.driver_shifts (driver_member_id, trip_id);
create index driver_shifts_backup_trip_idx
  on public.driver_shifts (backup_member_id, trip_id);

-- Jedna polityka na operację ogranicza koszt oceny RLS.
drop policy if exists "admins manage trip members" on public.trip_members;
create policy "admins insert trip members" on public.trip_members
  for insert to authenticated
  with check ((select private.is_trip_admin(trip_id)));
create policy "admins update trip members" on public.trip_members
  for update to authenticated
  using ((select private.is_trip_admin(trip_id)))
  with check ((select private.is_trip_admin(trip_id)));
create policy "admins delete trip members" on public.trip_members
  for delete to authenticated
  using ((select private.is_trip_admin(trip_id)));

drop policy if exists "admins manage expenses" on public.expenses;
drop policy if exists "users add own expenses" on public.expenses;
drop policy if exists "users edit own expenses" on public.expenses;
create policy "authorized users insert expenses" on public.expenses
  for insert to authenticated
  with check (
    (select private.is_trip_admin(trip_id))
    or (
      (select private.is_trip_member(trip_id))
      and owner_member_id = (select private.current_trip_member_id(trip_id))
    )
  );
create policy "authorized users update expenses" on public.expenses
  for update to authenticated
  using (
    (select private.is_trip_admin(trip_id))
    or owner_member_id = (select private.current_trip_member_id(trip_id))
  )
  with check (
    (select private.is_trip_admin(trip_id))
    or owner_member_id = (select private.current_trip_member_id(trip_id))
  );
create policy "admins delete expenses" on public.expenses
  for delete to authenticated
  using ((select private.is_trip_admin(trip_id)));

drop policy if exists "expense owners manage participants" on public.expense_participants;
create policy "authorized users insert expense participants" on public.expense_participants
  for insert to authenticated
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
create policy "authorized users update expense participants" on public.expense_participants
  for update to authenticated
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
create policy "authorized users delete expense participants" on public.expense_participants
  for delete to authenticated
  using (
    (select private.is_trip_admin(trip_id))
    or exists (
      select 1 from public.expenses expense
      where expense.id = expense_id
        and expense.trip_id = trip_id
        and expense.owner_member_id = (select private.current_trip_member_id(trip_id))
    )
  );

drop policy if exists "admins manage payments" on public.payments;
create policy "admins insert payments" on public.payments
  for insert to authenticated with check ((select private.is_trip_admin(trip_id)));
create policy "admins update payments" on public.payments
  for update to authenticated
  using ((select private.is_trip_admin(trip_id)))
  with check ((select private.is_trip_admin(trip_id)));
create policy "admins delete payments" on public.payments
  for delete to authenticated using ((select private.is_trip_admin(trip_id)));

drop policy if exists "admins manage tasks" on public.tasks;
create policy "admins insert tasks" on public.tasks
  for insert to authenticated with check ((select private.is_trip_admin(trip_id)));
create policy "admins update tasks" on public.tasks
  for update to authenticated
  using ((select private.is_trip_admin(trip_id)))
  with check ((select private.is_trip_admin(trip_id)));
create policy "admins delete tasks" on public.tasks
  for delete to authenticated using ((select private.is_trip_admin(trip_id)));

drop policy if exists "admins manage task assignees" on public.task_assignees;
create policy "admins insert task assignees" on public.task_assignees
  for insert to authenticated with check ((select private.is_trip_admin(trip_id)));
create policy "admins update task assignees" on public.task_assignees
  for update to authenticated
  using ((select private.is_trip_admin(trip_id)))
  with check ((select private.is_trip_admin(trip_id)));
create policy "admins delete task assignees" on public.task_assignees
  for delete to authenticated using ((select private.is_trip_admin(trip_id)));

drop policy if exists "admins manage task completions" on public.task_completions;
drop policy if exists "users add own task completion" on public.task_completions;
drop policy if exists "users update own task completion" on public.task_completions;
drop policy if exists "users remove own task completion" on public.task_completions;
create policy "authorized users insert task completions" on public.task_completions
  for insert to authenticated
  with check (
    (select private.is_trip_admin(trip_id))
    or member_id = (select private.current_trip_member_id(trip_id))
  );
create policy "authorized users update task completions" on public.task_completions
  for update to authenticated
  using (
    (select private.is_trip_admin(trip_id))
    or member_id = (select private.current_trip_member_id(trip_id))
  )
  with check (
    (select private.is_trip_admin(trip_id))
    or member_id = (select private.current_trip_member_id(trip_id))
  );
create policy "authorized users delete task completions" on public.task_completions
  for delete to authenticated
  using (
    (select private.is_trip_admin(trip_id))
    or member_id = (select private.current_trip_member_id(trip_id))
  );

-- Proste tabele administrowane: rozdziel ALL na insert/update/delete.
do $$
declare
  item record;
begin
  for item in
    select * from (values
      ('trip_plan', 'admins manage trip plan'),
      ('driver_shifts', 'admins manage driver shifts'),
      ('documents', 'admins manage documents'),
      ('emergency_contacts', 'admins manage emergency contacts'),
      ('payment_schedule', 'admins manage payment schedule'),
      ('route_stops', 'admins manage route stops'),
      ('fuel_settings', 'admins manage fuel settings')
    ) as values_table(table_name, old_policy)
  loop
    execute format('drop policy if exists %I on public.%I', item.old_policy, item.table_name);
    execute format(
      'create policy %I on public.%I for insert to authenticated with check ((select private.is_trip_admin(trip_id)))',
      'admins insert ' || item.table_name, item.table_name
    );
    execute format(
      'create policy %I on public.%I for update to authenticated using ((select private.is_trip_admin(trip_id))) with check ((select private.is_trip_admin(trip_id)))',
      'admins update ' || item.table_name, item.table_name
    );
    execute format(
      'create policy %I on public.%I for delete to authenticated using ((select private.is_trip_admin(trip_id)))',
      'admins delete ' || item.table_name, item.table_name
    );
  end loop;
end $$;

commit;
