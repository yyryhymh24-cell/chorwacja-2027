(() => {
  'use strict';

  const PROJECT_URL = 'https://zegaqlqnvtqzynyoswik.supabase.co';
  const PUBLISHABLE_KEY = 'sb_publishable_e1UcKjRsRORGPF1X4tNprw_dwbbDro7';

  const client = window.supabase.createClient(PROJECT_URL, PUBLISHABLE_KEY, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true
    }
  });

  window.tripSupabase = client;

  const gate = document.getElementById('authGate');
  const app = document.getElementById('appView');
  const loading = document.getElementById('authLoading');
  const loginForm = document.getElementById('magicLoginForm');
  const loginMessage = document.getElementById('loginMessage');
  const sendButton = document.getElementById('sendMagicLinkBtn');
  const denied = document.getElementById('accessDenied');
  const deniedMessage = document.getElementById('accessDeniedMessage');
  let bootingFor = null;

  function showOnly(element) {
    [loading, loginForm, denied].forEach(item => item.classList.toggle('hidden', item !== element));
    gate.classList.remove('hidden');
    app.classList.add('auth-hidden');
  }

  function showApp() {
    gate.classList.add('hidden');
    app.classList.remove('auth-hidden');
  }

  function polishError(error) {
    const message = String(error?.message || error || 'Nie udało się wykonać operacji.');
    if (/rate limit|email rate/i.test(message)) {
      return 'Limit wiadomości został chwilowo wykorzystany. Odczekaj kilka minut i spróbuj ponownie.';
    }
    if (/user not found|invalid login|signup.*disabled/i.test(message)) {
      return 'Ten adres nie ma konta uczestnika. Poproś administratora o zaproszenie.';
    }
    if (/network|fetch/i.test(message)) {
      return 'Brak połączenia z Supabase. Sprawdź internet i spróbuj ponownie.';
    }
    return message;
  }

  async function openForSession(session) {
    if (!session?.user) {
      bootingFor = null;
      showOnly(loginForm);
      return;
    }
    if (bootingFor === session.user.id) return;
    bootingFor = session.user.id;
    showOnly(loading);
    try {
      await window.startTripApp(session.user);
      showApp();
    } catch (error) {
      console.error('Nie udało się otworzyć panelu.', error);
      if (error?.code === 'NOT_MEMBER') {
        deniedMessage.textContent = 'Konto jest poprawne, ale nie zostało jeszcze przypisane do wyjazdu. Administrator musi połączyć je z uczestnikiem.';
        showOnly(denied);
      } else {
        loginMessage.classList.remove('success');
        loginMessage.textContent = polishError(error);
        showOnly(loginForm);
      }
      bootingFor = null;
    }
  }

  loginForm.addEventListener('submit', async event => {
    event.preventDefault();
    const email = document.getElementById('loginEmail').value.trim();
    loginMessage.classList.remove('success');
    loginMessage.textContent = 'Wysyłanie bezpiecznego linku…';
    sendButton.disabled = true;

    const redirectUrl = location.protocol === 'file:'
      ? 'https://chorwacja-2027.vercel.app/'
      : `${location.origin}${location.pathname}`;
    const { error } = await client.auth.signInWithOtp({
      email,
      options: {
        shouldCreateUser: false,
        emailRedirectTo: redirectUrl
      }
    });

    sendButton.disabled = false;
    if (error) {
      loginMessage.textContent = polishError(error);
      return;
    }

    loginMessage.classList.add('success');
    loginMessage.textContent = 'Link wysłany. Otwórz wiadomość na tym urządzeniu; sesja zostanie zapamiętana.';
  });

  async function signOut() {
    await window.stopTripApp?.();
    await client.auth.signOut();
    bootingFor = null;
    showOnly(loginForm);
  }

  document.getElementById('accessSignOut').addEventListener('click', signOut);
  document.getElementById('logoutBtn').addEventListener('click', signOut);

  client.auth.onAuthStateChange((event, session) => {
    if (event === 'SIGNED_OUT') {
      bootingFor = null;
      showOnly(loginForm);
      return;
    }
    if ((event === 'SIGNED_IN' || event === 'INITIAL_SESSION') && session?.user) {
      setTimeout(() => openForSession(session), 0);
    }
  });

  client.auth.getSession().then(({ data, error }) => {
    if (error) {
      loginMessage.textContent = polishError(error);
      showOnly(loginForm);
      return;
    }
    openForSession(data.session);
  });
})();
