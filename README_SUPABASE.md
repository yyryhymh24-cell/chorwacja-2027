# Chorwacja 2027 — uruchomienie bezpiecznego logowania

Panel korzysta teraz z Supabase Auth, tabel relacyjnych i reguł RLS. Nie używa lokalnych PIN-ów ani wyboru osoby z listy.

## Co jest już gotowe

- aktualny `trip_state.data` ma kopię lokalną i kopię w prywatnej tabeli bazy;
- dane wyjazdu zostały przeniesione do osobnych tabel;
- Bartosz jest połączony z istniejącym kontem Auth i ma rolę `admin`;
- sześciu pozostałych uczestników istnieje w `trip_members` ze statusem `pending`;
- anonimowy dostęp do starego `trip_state` jest zablokowany;
- stary `trip_state` oraz archiwalne tabele nie zostały usunięte.

## 1. Ustaw adres strony dla wiadomości logowania

W Supabase otwórz **Authentication → URL Configuration** i ustaw:

- **Site URL:** `https://chorwacja-2027.vercel.app`
- **Redirect URLs:** dodaj `https://chorwacja-2027.vercel.app/**`

## 2. Utwórz konta sześciu uczestników

W **Authentication → Users** wybierz **Invite user** i zaproś uczestników, którzy jeszcze nie mają konta: użyj ich potwierdzonych adresów. W aktualnym składzie Kamil zastąpił Michała. Dopóki nie znasz adresu Kamila, pozostaw jego wpis jako oczekujący — nie podawaj adresu zastępczego.

Nie dodawaj użytkowników ręcznie poleceniem SQL do `auth.users`. Supabase powinien utworzyć ich przez panel Auth i wysłać wiadomość z linkiem.

## 3. Połącz konta z uczestnikami

Otwórz plik `supabase/manual/02_link_participants.sql`, wpisz sześć adresów e-mail zamiast wartości `WPISZ_EMAIL_...`, wklej całość do Supabase SQL Editor i uruchom.

Końcowy wynik ma pokazać siedem osób ze statusem `active` i wartością `linked = true`.

## 4. Logowanie

Użytkownik wpisuje e-mail na stronie i klika **Wyślij link do logowania**. Sesja jest zapamiętywana w przeglądarce. Konto, które nie jest połączone z aktywnym uczestnikiem, nie otrzyma dostępu do panelu.

Jeśli Supabase pokazuje limit wysyłki wiadomości, odczekaj do odnowienia limitu albo skonfiguruj własny SMTP w **Authentication → Email**. Nie klikaj wielokrotnie wysyłania linku.

## Test uprawnień

1. Zaloguj się jako Bartosz. Powinieneś widzieć ustawienia, edycję wszystkich danych, wpłat i członków.
2. Zaloguj się w prywatnym oknie jako zwykły uczestnik. Powinien widzieć dane wyjazdu, dodać i edytować własny wydatek oraz zaznaczyć własne wykonanie zadania.
3. Jako zwykły uczestnik spróbuj edytować cudzy wydatek, cudzą wpłatę lub dane wyjazdu. Interfejs nie powinien na to pozwolić, a baza dodatkowo odrzuci taką operację.
4. Wyloguj się i otwórz stronę ponownie. Dane panelu nie powinny być widoczne bez zalogowania.

## Wycofanie zmian

Nie usuwaj `public.trip_state` ani `private.trip_state_backups`, dopóki wszyscy uczestnicy nie zalogują się i nie potwierdzicie poprawności danych. Kopia lokalna znajduje się osobno w katalogu `backups` i celowo nie została dołączona do ZIP-a przeznaczonego do publikacji. Nie umieszczaj jej w publicznym repozytorium ani na hostingu.
