(() => {
  'use strict';

  const PROJECT_URL = 'https://zegaqlqnvtqzynyoswik.supabase.co';
  const PUBLISHABLE_KEY = 'sb_publishable_e1UcKjRsRORGPF1X4tNprw_dwbbDro7';
  const TRIP_ID = '00000000-0000-0000-0000-000000002027';
  const client = window.supabase.createClient(PROJECT_URL, PUBLISHABLE_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
  });

  const gate = document.getElementById('authGate');
  const app = document.getElementById('appView');
  const loading = document.getElementById('authLoading');
  const loginForm = document.getElementById('loginForm');
  const passwordForm = document.getElementById('newPasswordForm');
  const loginMessage = document.getElementById('loginMessage');
  const passwordMessage = document.getElementById('passwordMessage');
  let recoveryMode = location.hash.includes('type=recovery') || new URLSearchParams(location.search).get('type') === 'recovery';

  function showOnly(element) {
    loading.classList.add('hidden');
    loginForm.classList.toggle('hidden', element !== loginForm);
    passwordForm.classList.toggle('hidden', element !== passwordForm);
    gate.classList.remove('hidden');
    app.classList.add('auth-hidden');
  }

  function showApp() {
    gate.classList.add('hidden');
    app.classList.remove('auth-hidden');
  }

  function polishError(error) {
    const text = String(error?.message || error || 'Nie udało się wykonać operacji.');
    if (/invalid login credentials/i.test(text)) return 'Nieprawidłowy e-mail lub hasło.';
    if (/expired|invalid.*token|otp/i.test(text)) return 'Link wygasł albo został już użyty. Wyślij nowy link do hasła.';
    if (/password.*short|least/i.test(text)) return 'Hasło musi mieć co najmniej 8 znaków.';
    return text;
  }

  async function applyRole(user) {
    try {
      const { data, error } = await client.from('trip_members').select('role').eq('trip_id', TRIP_ID).eq('user_id', user.id).maybeSingle();
      if (!error && data?.role === 'admin') {
        adminMode = true;
        sessionStorage.setItem(SESSION_KEY, 'admin');
      } else {
        adminMode = false;
        sessionStorage.removeItem(SESSION_KEY);
      }
      renderAll();
    } catch (error) {
      console.warn('Nie udało się odczytać roli użytkownika.', error);
    }
  }

  loginForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    loginMessage.textContent = 'Logowanie…';
    const email = document.getElementById('loginEmail').value.trim();
    const password = document.getElementById('loginPassword').value;
    const { data, error } = await client.auth.signInWithPassword({ email, password });
    if (error) {
      loginMessage.textContent = polishError(error);
      return;
    }
    loginMessage.textContent = '';
    await applyRole(data.user);
    showApp();
  });

  document.getElementById('forgotPassword').addEventListener('click', async () => {
    const email = document.getElementById('loginEmail').value.trim();
    if (!email) {
      loginMessage.textContent = 'Najpierw wpisz swój adres e-mail.';
      return;
    }
    loginMessage.textContent = 'Wysyłanie wiadomości…';
    const { error } = await client.auth.resetPasswordForEmail(email, { redirectTo: `${location.origin}/` });
    loginMessage.classList.toggle('success', !error);
    loginMessage.textContent = error ? polishError(error) : 'Wysłaliśmy nowy link do ustawienia hasła.';
  });

  passwordForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const password = document.getElementById('newPassword').value;
    const repeat = document.getElementById('newPasswordRepeat').value;
    passwordMessage.classList.remove('success');
    if (password.length < 8) {
      passwordMessage.textContent = 'Hasło musi mieć co najmniej 8 znaków.';
      return;
    }
    if (password !== repeat) {
      passwordMessage.textContent = 'Podane hasła nie są takie same.';
      return;
    }
    passwordMessage.textContent = 'Zapisywanie hasła…';
    const { data, error } = await client.auth.updateUser({ password });
    if (error) {
      passwordMessage.textContent = polishError(error);
      return;
    }
    recoveryMode = false;
    history.replaceState({}, document.title, location.pathname);
    passwordMessage.classList.add('success');
    passwordMessage.textContent = 'Hasło zapisane. Otwieranie panelu…';
    await applyRole(data.user);
    setTimeout(showApp, 500);
  });

  client.auth.onAuthStateChange(async (event, session) => {
    if (event === 'PASSWORD_RECOVERY') {
      recoveryMode = true;
      showOnly(passwordForm);
      return;
    }
    if (recoveryMode) {
      showOnly(passwordForm);
      return;
    }
    if (session?.user) {
      await applyRole(session.user);
      showApp();
    } else {
      showOnly(loginForm);
    }
  });

  client.auth.getSession().then(async ({ data, error }) => {
    if (error) {
      loginMessage.textContent = polishError(error);
      showOnly(loginForm);
      return;
    }
    if (recoveryMode) {
      showOnly(passwordForm);
    } else if (data.session?.user) {
      await applyRole(data.session.user);
      showApp();
    } else {
      showOnly(loginForm);
    }
  });

  document.getElementById('logoutBtn').onclick = async () => {
    await client.auth.signOut();
    adminMode = false;
    sessionStorage.removeItem(SESSION_KEY);
    showOnly(loginForm);
  };
})();
