(() => {
  'use strict';

  const PROJECT_URL = 'https://zegaqlqnvtqzynyoswik.supabase.co';
  const PUBLISHABLE_KEY = 'sb_publishable_e1UcKjRsRORGPF1X4tNprw_dwbbDro7';
  const TRIP_ID = '00000000-0000-0000-0000-000000002027';
  let recoveryMode = location.hash.includes('type=recovery') || new URLSearchParams(location.search).get('type') === 'recovery';
  const client = window.supabase.createClient(PROJECT_URL, PUBLISHABLE_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
  });
  window.tripSupabase = client;

  const gate = document.getElementById('authGate');
  const app = document.getElementById('appView');
  const loginDialog = document.getElementById('adminLoginDialog');
  const loginForm = document.getElementById('adminLoginForm');
  const passwordForm = document.getElementById('newPasswordForm');
  const loginMessage = document.getElementById('adminLoginError');
  const passwordMessage = document.getElementById('passwordMessage');

  function showApp() {
    gate.classList.add('hidden');
    app.classList.remove('auth-hidden');
  }

  function showRecovery() {
    gate.classList.remove('hidden');
    app.classList.add('auth-hidden');
  }

  function setGuestMode() {
    adminMode = false;
    sessionStorage.removeItem(SESSION_KEY);
    renderAll();
    showApp();
  }

  function polishError(error) {
    const text = String(error?.message || error || 'Nie udało się wykonać operacji.');
    if (/invalid login credentials/i.test(text)) return 'Nieprawidłowy e-mail lub hasło.';
    if (/rate limit/i.test(text)) return 'Limit wiadomości Supabase został wykorzystany. Spróbuj ponownie za około godzinę.';
    if (/expired|invalid.*token|otp/i.test(text)) return 'Link wygasł albo został już użyty. Wyślij nowy link do hasła.';
    if (/password.*short|least/i.test(text)) return 'Hasło musi mieć co najmniej 8 znaków.';
    return text;
  }

  async function applyRole(user) {
    try {
      const { data, error } = await client.from('trip_members').select('role').eq('trip_id', TRIP_ID).eq('user_id', user.id).maybeSingle();
      const allowed = !error && data?.role === 'admin';
      adminMode = allowed;
      if (allowed) sessionStorage.setItem(SESSION_KEY, 'admin');
      else sessionStorage.removeItem(SESSION_KEY);
      renderAll();
      return allowed;
    } catch (error) {
      console.warn('Nie udało się odczytać roli administratora.', error);
      setGuestMode();
      return false;
    }
  }

  document.getElementById('adminLoginBtn').addEventListener('click', () => {
    loginMessage.textContent = '';
    loginDialog.showModal();
  });

  loginForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    loginMessage.textContent = 'Logowanie…';
    const email = document.getElementById('adminEmail').value.trim();
    const password = document.getElementById('adminPassword').value;
    const { data, error } = await client.auth.signInWithPassword({ email, password });
    if (error) {
      loginMessage.textContent = polishError(error);
      return;
    }
    const allowed = await applyRole(data.user);
    if (!allowed) {
      await client.auth.signOut();
      loginMessage.textContent = 'To konto nie ma uprawnień administratora.';
      return;
    }
    loginMessage.textContent = '';
    document.getElementById('adminPassword').value = '';
    loginDialog.close();
    navigate('dashboard');
    toast('Zalogowano jako administrator');
  });

  document.getElementById('adminForgotPassword').addEventListener('click', async () => {
    const email = document.getElementById('adminEmail').value.trim();
    if (!email) {
      loginMessage.textContent = 'Najpierw wpisz adres e-mail administratora.';
      return;
    }
    loginMessage.textContent = 'Wysyłanie wiadomości…';
    const { error } = await client.auth.resetPasswordForEmail(email, { redirectTo: `${location.origin}/` });
    loginMessage.textContent = error ? polishError(error) : 'Wysłaliśmy link do ustawienia nowego hasła.';
  });

  passwordForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const password = document.getElementById('newPassword').value;
    const repeat = document.getElementById('newPasswordRepeat').value;
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
    passwordMessage.textContent = 'Hasło zapisane. Otwieranie panelu…';
    await applyRole(data.user);
    setTimeout(showApp, 500);
  });

  client.auth.onAuthStateChange((event, session) => {
    if (event === 'PASSWORD_RECOVERY') {
      recoveryMode = true;
      showRecovery();
      return;
    }
    if (event === 'SIGNED_OUT') setGuestMode();
    if (event === 'SIGNED_IN' && session?.user && !recoveryMode) {
      setTimeout(() => applyRole(session.user), 0);
    }
  });

  showApp();
  window.initTripSync?.();
  client.auth.getSession().then(async ({ data }) => {
    if (recoveryMode) {
      showRecovery();
      return;
    }
    if (data.session?.user) await applyRole(data.session.user);
    else setGuestMode();
  });

  document.getElementById('logoutBtn').onclick = async () => {
    await client.auth.signOut();
    setGuestMode();
    navigate('dashboard');
    toast('Wylogowano administratora');
  };
})();
