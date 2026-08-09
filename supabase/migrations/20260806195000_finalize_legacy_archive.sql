-- Finalizacja archiwum: private nie jest wystawione przez Data API,
-- a anon/authenticated nie mają do niego uprawnień.

begin;

revoke all on schema private from public, anon, authenticated;

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
    if to_regclass(format('private.%I', table_name)) is not null then
      execute format('revoke all on table private.%I from public, anon, authenticated', table_name);
      execute format('alter table private.%I disable row level security', table_name);
    end if;
  end loop;
end $$;

commit;
