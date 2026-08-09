-- Archiwalne tabele legacy_v1_* są zachowane wyłącznie do odtworzenia danych.
-- Nie są częścią Data API i nie potrzebują dawnych polityk RLS.

begin;

revoke all on schema private from public, anon, authenticated;

do $$
declare
  item record;
begin
  for item in
    select schemaname, tablename, policyname
    from pg_policies
    where schemaname = 'private'
      and tablename like 'legacy_v1_%'
  loop
    execute format(
      'drop policy if exists %I on %I.%I',
      item.policyname,
      item.schemaname,
      item.tablename
    );
  end loop;
end $$;

commit;
