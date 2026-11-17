-- KROK RĘCZNY: uruchom dopiero po utworzeniu/zaproszeniu użytkowników
-- w Supabase Dashboard -> Authentication -> Users.
--
-- Zamień sześć wartości WPISZ_EMAIL_... na prawdziwe adresy e-mail.
-- Skrypt nie tworzy kont Auth i w obecnej postaci nie zmieni żadnego rekordu.

begin;

with participant_emails(legacy_key, email) as (
  values
    ('u1', 'WPISZ_EMAIL_DOMINIKI'),
    ('u2', 'WPISZ_EMAIL_AGNIESZKI'),
    ('kamil', 'WPISZ_EMAIL_KAMILA'),
    ('u4', 'WPISZ_EMAIL_KAROLINY'),
    ('u5', 'WPISZ_EMAIL_DAMIANA'),
    ('u6', 'WPISZ_EMAIL_KRZYSIA')
), resolved as (
  select
    participant_emails.legacy_key,
    auth.users.id as auth_user_id
  from participant_emails
  join auth.users
    on lower(auth.users.email) = lower(participant_emails.email)
  where participant_emails.email not like 'WPISZ_EMAIL_%'
)
update public.trip_members as member
set
  auth_user_id = resolved.auth_user_id,
  status = 'active',
  updated_at = now()
from resolved
where member.trip_id = '00000000-0000-0000-0000-000000002027'
  and member.legacy_key = resolved.legacy_key
  and member.role = 'user'
  and member.status = 'pending'
  and member.auth_user_id is null;

commit;

-- Wynik powinien pokazać 7 rekordów ze statusem active i linked = true.
select
  legacy_key,
  display_name,
  role,
  status,
  auth_user_id is not null as linked
from public.trip_members
where trip_id = '00000000-0000-0000-0000-000000002027'
order by sort_order;
