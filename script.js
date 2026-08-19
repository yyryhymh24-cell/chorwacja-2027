const TRIP_ID = '00000000-0000-0000-0000-000000002027';
const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];

const emptyData = () => ({
  trip: { name: '', destination: '', start: '', end: '', people: 7, budget: 0, description: '' },
  users: [],
  payments: {},
  expenses: [],
  tasks: [],
  plan: [],
  fuel: { distance: 3900, consumption: 9.5, price: 6.45 },
  route: [],
  paymentSchedule: [],
  driverShifts: [],
  documents: [],
  emergencyContacts: [],
  attractions: []
});

let data = emptyData();
let currentUser = null;
let authUser = null;
let adminMode = false;
let confirmAction = null;
let remoteChannel = null;
let remoteReloadTimer = null;
let fuelSaveTimer = null;
let appStarted = false;

function money(value) {
  return new Intl.NumberFormat('pl-PL', {
    style: 'currency', currency: 'PLN', maximumFractionDigits: 0
  }).format(Number(value) || 0);
}

function fmtDate(value) {
  if (!value) return '—';
  return new Intl.DateTimeFormat('pl-PL', { day: 'numeric', month: 'short' })
    .format(new Date(`${value.slice(0, 10)}T12:00:00`));
}

function initials(name = '') {
  return name.split(' ').filter(Boolean).map(part => part[0]).join('').slice(0, 2).toUpperCase();
}

function escapeHtml(value = '') {
  return String(value).replace(/[&<>'"]/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  })[char]);
}

function safeHttpUrl(value = '') {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
  } catch {
    return '';
  }
}

function localDateTime(value) {
  if (!value) return '';
  const date = new Date(value);
  const shifted = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return shifted.toISOString().slice(0, 16);
}

function userName(memberId) {
  return data.users.find(user => user.id === memberId)?.name || 'Nieznany';
}

function isAdmin() {
  return adminMode;
}

function toast(message) {
  const element = $('#toast');
  element.textContent = message;
  element.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => element.classList.remove('show'), 2800);
}

function friendlyDbError(error) {
  const message = String(error?.message || error || 'Nieznany błąd synchronizacji.');
  if (/row-level security|permission denied|42501/i.test(message)) {
    return 'Nie masz uprawnień do tej zmiany.';
  }
  if (/network|fetch|load failed/i.test(message)) {
    return 'Brak połączenia z bazą. Zmiana nie została zapisana.';
  }
  if (/duplicate key|23505/i.test(message)) {
    return 'Taki wpis już istnieje.';
  }
  return message;
}

function setSyncState(state, detail = '') {
  const panel = $('#syncPanel');
  if (!panel) return;
  const labels = {
    loading: 'Pobieranie danych…',
    saving: 'Zapisywanie…',
    online: 'Dane zsynchronizowane',
    error: 'Brak synchronizacji'
  };
  panel.dataset.state = state;
  $('#syncLabel').textContent = labels[state] || labels.loading;
  $('#syncDetail').textContent = detail || (state === 'online'
    ? 'Wspólna baza Supabase'
    : state === 'error' ? 'Kliknij „Ponów”' : 'Proszę czekać');
  $('#retrySync').classList.toggle('hidden', state !== 'error');
  document.body.dataset.sync = state;
}

function assertResult(result) {
  if (result.error) throw result.error;
  return result.data;
}

async function runWrite(successMessage, operation) {
  setSyncState('saving', 'Wysyłanie zmiany do wspólnej bazy');
  try {
    await operation();
    await loadNormalizedData({ quiet: true });
    setSyncState('online');
    if (successMessage) toast(successMessage);
    return true;
  } catch (error) {
    console.error('Nie udało się zapisać zmiany.', error);
    const message = friendlyDbError(error);
    setSyncState('error', message);
    toast(message);
    return false;
  }
}

async function loadNormalizedData({ quiet = false } = {}) {
  const client = window.tripSupabase;
  if (!client || !authUser) throw new Error('Brak aktywnej sesji Supabase.');
  if (!quiet) setSyncState('loading', 'Pobieranie aktualnych danych wyjazdu');

  const membership = assertResult(await client
    .from('trip_members')
    .select('*')
    .eq('trip_id', TRIP_ID)
    .eq('auth_user_id', authUser.id)
    .eq('status', 'active')
    .maybeSingle());

  if (!membership) {
    const error = new Error('Konto nie jest przypisane do wyjazdu.');
    error.code = 'NOT_MEMBER';
    throw error;
  }

  const [
    tripResult, membersResult, expensesResult, expenseParticipantsResult,
    paymentsResult, tasksResult, assigneesResult, completionsResult,
    planResult, shiftsResult, documentsResult, contactsResult,
    scheduleResult, routeResult, fuelResult, attractionsResult, attractionLikesResult
  ] = await Promise.all([
    client.from('trips').select('*').eq('id', TRIP_ID).single(),
    client.from('trip_members').select('*').eq('trip_id', TRIP_ID).order('sort_order'),
    client.from('expenses').select('*').eq('trip_id', TRIP_ID).order('expense_date', { ascending: false }),
    client.from('expense_participants').select('*').eq('trip_id', TRIP_ID),
    client.from('payments').select('*').eq('trip_id', TRIP_ID),
    client.from('tasks').select('*').eq('trip_id', TRIP_ID).order('sort_order'),
    client.from('task_assignees').select('*').eq('trip_id', TRIP_ID),
    client.from('task_completions').select('*').eq('trip_id', TRIP_ID),
    client.from('trip_plan').select('*').eq('trip_id', TRIP_ID).order('day_number').order('sort_order'),
    client.from('driver_shifts').select('*').eq('trip_id', TRIP_ID).order('start_at'),
    client.from('documents').select('*').eq('trip_id', TRIP_ID).order('created_at'),
    client.from('emergency_contacts').select('*').eq('trip_id', TRIP_ID).order('created_at'),
    client.from('payment_schedule').select('*').eq('trip_id', TRIP_ID).order('due_date'),
    client.from('route_stops').select('*').eq('trip_id', TRIP_ID).order('position'),
    client.from('fuel_settings').select('*').eq('trip_id', TRIP_ID).maybeSingle(),
    client.from('attractions').select('*').eq('trip_id', TRIP_ID),
    client.from('attraction_likes').select('*').eq('trip_id', TRIP_ID)
  ]);

  const trip = assertResult(tripResult);
  const members = assertResult(membersResult);
  const expenses = assertResult(expensesResult);
  const expenseParticipants = assertResult(expenseParticipantsResult);
  const payments = assertResult(paymentsResult);
  const tasks = assertResult(tasksResult);
  const assignees = assertResult(assigneesResult);
  const completions = assertResult(completionsResult);
  const plan = assertResult(planResult);
  const shifts = assertResult(shiftsResult);
  const documents = assertResult(documentsResult);
  const contacts = assertResult(contactsResult);
  const schedule = assertResult(scheduleResult);
  const route = assertResult(routeResult);
  const fuel = assertResult(fuelResult);
  const attractions = assertResult(attractionsResult);
  const attractionLikes = assertResult(attractionLikesResult);

  const mappedUsers = members.map(member => ({
    id: member.id,
    legacyKey: member.legacy_key,
    name: member.display_name,
    role: member.role,
    status: member.status
  }));

  currentUser = mappedUsers.find(member => member.id === membership.id);
  if (!currentUser) {
    const error = new Error('Nie znaleziono profilu uczestnika.');
    error.code = 'NOT_MEMBER';
    throw error;
  }
  currentUser.email = authUser.email || '';
  adminMode = currentUser.role === 'admin';

  const paymentMap = Object.fromEntries(payments.map(payment => [payment.member_id, Number(payment.amount)]));

  data = {
    trip: {
      name: trip.name,
      destination: trip.destination,
      start: trip.start_date,
      end: trip.end_date,
      people: Number(trip.participant_limit),
      budget: Number(trip.budget),
      description: trip.description || ''
    },
    users: mappedUsers,
    payments: paymentMap,
    expenses: expenses.map(expense => ({
      id: expense.id,
      name: expense.name,
      category: expense.category,
      amount: Number(expense.amount),
      status: expense.status,
      date: expense.expense_date,
      owner: expense.owner_member_id,
      note: expense.note || '',
      hasDeposit: expense.has_deposit,
      depositAmount: Number(expense.deposit_amount),
      participants: expenseParticipants
        .filter(item => item.expense_id === expense.id)
        .map(item => item.member_id)
    })),
    tasks: tasks.map(task => {
      const taskAssignees = assignees.filter(item => item.task_id === task.id).map(item => item.member_id);
      return {
        id: task.id,
        title: task.title,
        category: task.category,
        assignees: taskAssignees.length === members.length ? ['all'] : taskAssignees,
        deadline: task.deadline || '',
        comment: task.comment || '',
        doneBy: completions.filter(item => item.task_id === task.id).map(item => item.member_id)
      };
    }),
    plan: plan.map(item => ({
      id: item.id,
      day: Number(item.day_number),
      date: item.plan_date,
      title: item.title,
      description: item.description || ''
    })),
    fuel: fuel ? {
      distance: Number(fuel.distance_km),
      consumption: Number(fuel.consumption_l_per_100km),
      price: Number(fuel.price_pln_per_l)
    } : { distance: 3900, consumption: 9.5, price: 6.45 },
    route: route.map(item => ({
      id: item.id,
      city: item.city,
      country: item.country,
      note: item.note || '',
      km: Number(item.distance_from_start_km),
      lat: Number(item.latitude),
      lng: Number(item.longitude)
    })),
    paymentSchedule: schedule.map(item => ({
      id: item.id,
      title: item.title,
      amount: Number(item.amount_per_person),
      due: item.due_date,
      note: item.note || ''
    })),
    driverShifts: shifts.map(item => ({
      id: item.id,
      leg: item.leg,
      driver: item.driver_member_id,
      backup: item.backup_member_id,
      start: localDateTime(item.start_at),
      end: localDateTime(item.end_at),
      note: item.note || ''
    })),
    documents: documents.map(item => ({
      id: item.id,
      title: item.title,
      type: item.document_type,
      url: item.url,
      note: item.note || ''
    })),
    emergencyContacts: contacts.map(item => ({
      id: item.id,
      name: item.name,
      phone: item.phone || '',
      category: item.category,
      note: item.note || ''
    })),
    attractions: attractions.map(item => ({
      id: item.id,
      name: item.name,
      description: item.description || '',
      location: item.location,
      url: item.url || '',
      date: item.planned_date || '',
      price: Number(item.price),
      owner: item.created_by_member_id,
      expenseId: item.expense_id,
      createdAt: item.created_at,
      likes: attractionLikes
        .filter(like => like.attraction_id === item.id)
        .map(like => like.member_id)
    }))
  };

  renderAll();
  if (!quiet) setSyncState('online');
}

function subscribeToRealtime() {
  if (remoteChannel) window.tripSupabase.removeChannel(remoteChannel);
  const tables = [
    'trips', 'trip_members', 'expenses', 'expense_participants', 'payments',
    'tasks', 'task_assignees', 'task_completions', 'trip_plan', 'driver_shifts',
    'documents', 'emergency_contacts', 'payment_schedule', 'route_stops', 'fuel_settings',
    'attractions', 'attraction_likes'
  ];
  let channel = window.tripSupabase.channel(`trip-${TRIP_ID}`);
  tables.forEach(table => {
    const filter = table === 'trips' ? `id=eq.${TRIP_ID}` : `trip_id=eq.${TRIP_ID}`;
    channel = channel.on('postgres_changes', { event: '*', schema: 'public', table, filter }, () => {
      clearTimeout(remoteReloadTimer);
      remoteReloadTimer = setTimeout(async () => {
        try {
          await loadNormalizedData({ quiet: true });
          setSyncState('online', 'Odebrano zmianę z innego urządzenia');
        } catch (error) {
          console.error('Nie udało się pobrać zdalnej zmiany.', error);
          setSyncState('error', friendlyDbError(error));
        }
      }, 250);
    });
  });
  remoteChannel = channel.subscribe(status => {
    if (status === 'SUBSCRIBED') setSyncState('online');
    if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
      setSyncState('error', 'Połączenie na żywo zostało przerwane');
    }
  });
}

async function startTripApp(user) {
  authUser = user;
  await loadNormalizedData();
  subscribeToRealtime();
  appStarted = true;
  navigate('dashboard');
}

async function stopTripApp() {
  clearTimeout(remoteReloadTimer);
  clearTimeout(fuelSaveTimer);
  if (remoteChannel && window.tripSupabase) await window.tripSupabase.removeChannel(remoteChannel);
  remoteChannel = null;
  appStarted = false;
  authUser = null;
  currentUser = null;
  adminMode = false;
  data = emptyData();
}

window.startTripApp = startTripApp;
window.stopTripApp = stopTripApp;

function totals() {
  const paid = data.expenses.filter(expense => expense.status === 'paid')
    .reduce((sum, expense) => sum + Number(expense.amount), 0);
  const planned = data.expenses.reduce((sum, expense) => sum + Number(expense.amount), 0);
  const collected = Object.values(data.payments).reduce((sum, value) => sum + Number(value), 0);
  return { paid, planned, collected };
}

function taskTargets(task) {
  return task.assignees?.includes('all') ? data.users.map(user => user.id) : (task.assignees || []);
}

function relevantTasks() {
  return data.tasks.filter(task => isAdmin() || taskTargets(task).includes(currentUser.id));
}

function taskDone(task) {
  return task.doneBy.includes(currentUser.id);
}

function renderAll() {
  if (!currentUser) return;
  document.body.classList.toggle('is-admin', isAdmin());
  $$('.admin-only').forEach(element => element.classList.toggle('hidden', !isAdmin()));
  $$('.guest-only').forEach(element => element.classList.add('hidden'));
  $('#userName').textContent = currentUser.name;
  $('#welcomeName').textContent = currentUser.name.split(' ')[0];
  $('#userRole').textContent = isAdmin() ? 'Administrator' : 'Uczestnik';
  $('#rolePill').textContent = isAdmin() ? 'TRYB ADMINA' : 'TRYB UŻYTKOWNIKA';
  $('#userAvatar').textContent = initials(currentUser.name);
  $('#topTripName').textContent = data.trip.name;
  $('#topDates').textContent = `${fmtDate(data.trip.start)} – ${fmtDate(data.trip.end)} ${new Date(`${data.trip.end}T12:00:00`).getFullYear()}`;
  $('#accountSummary').innerHTML = `<strong>${escapeHtml(currentUser.name)}</strong><small>${escapeHtml(currentUser.email || '')}</small>`;
  renderDashboard();
  renderExpenses();
  renderPayments();
  renderChecklist();
  renderAttractions();
  renderDrivers();
  renderResources();
  renderPlan();
  renderRoute();
  renderSettings();
}

function renderDashboard() {
  const summary = totals();
  const perPerson = data.trip.budget / data.trip.people;
  const percent = Math.min(100, Math.round(summary.paid / data.trip.budget * 100) || 0);
  const tasks = relevantTasks();
  const completed = tasks.filter(taskDone).length;
  const ready = tasks.length ? Math.round(completed / tasks.length * 100) : 0;
  $('#statBudget').textContent = money(data.trip.budget);
  $('#statPerPerson').textContent = `${money(perPerson)} / osobę`;
  $('#statSpent').textContent = money(summary.paid);
  $('#statRemaining').textContent = `zostało ${money(data.trip.budget - summary.paid)}`;
  $('#statPaid').textContent = money(summary.collected);
  $('#statPaidProgress').textContent = `${Math.round(summary.collected / data.trip.budget * 100) || 0}% celu`;
  $('#statReady').textContent = `${ready}%`;
  $('#statTasks').textContent = `${completed} z ${tasks.length} zadań`;
  $('#donutPercent').textContent = `${percent}%`;
  $('#budgetDonut').style.setProperty('--percent', `${percent * 3.6}deg`);
  $('#budgetDonut').style.setProperty('--percent-width', `${percent}%`);
  $('#legendSpent').textContent = money(summary.paid);
  $('#legendPlanned').textContent = money(Math.max(0, summary.planned - summary.paid));
  $('#legendFree').textContent = money(Math.max(0, data.trip.budget - summary.planned));
  const days = Math.ceil((new Date(`${data.trip.start}T12:00:00`) - new Date()) / 86400000);
  $('#daysLeft').textContent = Math.max(0, days);
  $('#dashboardPlan').innerHTML = [...data.plan].sort((a, b) => a.day - b.day).slice(0, 3).map(item => `
    <div class="mini-plan"><div class="day-badge">D${item.day}</div><div><strong>${escapeHtml(item.title)}</strong><span>${fmtDate(item.date)} · ${escapeHtml(item.description.slice(0, 62))}${item.description.length > 62 ? '…' : ''}</span></div></div>
  `).join('');
  $('#dashboardPayments').innerHTML = data.users.slice(0, 4).map(user => {
    const value = Number(data.payments[user.id] || 0);
    const progress = Math.min(100, Math.round(value / perPerson * 100) || 0);
    return `<div class="payment-row"><span class="avatar">${initials(user.name)}</span><div class="payment-meta"><div><strong>${escapeHtml(user.name)}</strong><span>${money(value)}</span></div><div class="progress"><i style="width:${progress}%"></i></div></div><strong>${progress}%</strong></div>`;
  }).join('');
  $('#dashboardTasks').innerHTML = tasks.slice(0, 4).map(task => `
    <label class="preview-task"><input type="checkbox" data-task-toggle="${task.id}" ${taskDone(task) ? 'checked' : ''}><span>${escapeHtml(task.title)}</span></label>
  `).join('') || '<p class="muted">Brak zadań.</p>';
}

function renderExpenses() {
  const query = ($('#expenseSearch')?.value || '').toLowerCase();
  const filter = $('#expenseFilter')?.value || 'all';
  const summary = totals();
  $('#expenseBudget').textContent = money(data.trip.budget);
  $('#expensePlanned').textContent = money(summary.planned);
  $('#expensePaid').textContent = money(summary.paid);
  const rows = data.expenses.filter(expense =>
    (filter === 'all' || expense.status === filter) && expense.name.toLowerCase().includes(query));
  $('#expenseEmpty').classList.toggle('hidden', rows.length > 0);
  $('#expenseTable').innerHTML = [...rows].sort((a, b) => b.date.localeCompare(a.date)).map(expense => {
    const own = expense.owner === currentUser.id;
    const canEdit = isAdmin() || own;
    const count = expense.participants?.length || data.users.length;
    const share = Number(expense.amount) / count;
    const deposit = Number(expense.depositAmount) || 0;
    return `<tr><td><strong>${escapeHtml(expense.name)}</strong><br><small class="muted">${fmtDate(expense.date)}</small></td><td><span class="category">${escapeHtml(expense.category)}</span></td><td><strong>${money(expense.amount)}</strong>${expense.hasDeposit && deposit > 0 ? `<span class="expense-deposit">Kaucja · ${money(deposit)}</span>` : ''}<span class="expense-split">${count} ${count === 1 ? 'osoba' : count < 5 ? 'osoby' : 'osób'} · ${money(share)} / os.</span></td><td><span class="status ${expense.status}">${expense.status === 'paid' ? 'Zapłacone' : 'Planowane'}</span></td><td>${escapeHtml(userName(expense.owner))}</td><td><div class="row-actions">${canEdit ? `<button data-edit-expense="${expense.id}" title="Edytuj">✎</button>` : ''}${isAdmin() ? `<button data-delete-expense="${expense.id}" title="Usuń">×</button>` : ''}</div></td></tr>`;
  }).join('');
}

function renderAttractions() {
  const sort = $('#attractionSort')?.value || 'likes';
  const participants = Math.max(1, data.users.length);
  const items = [...data.attractions].sort((a, b) => {
    if (sort === 'newest') return b.createdAt.localeCompare(a.createdAt);
    if (sort === 'cheapest') return a.price - b.price || b.likes.length - a.likes.length;
    if (sort === 'expensive') return b.price - a.price || b.likes.length - a.likes.length;
    return b.likes.length - a.likes.length || b.createdAt.localeCompare(a.createdAt);
  });

  $('#attractionsEmpty').classList.toggle('hidden', items.length > 0);
  $('#attractionsGrid').innerHTML = items.map(item => {
    const own = item.owner === currentUser.id;
    const canManage = isAdmin() || own;
    const liked = item.likes.includes(currentUser.id);
    const likerNames = item.likes.map(userName).join(', ');
    const link = safeHttpUrl(item.url);
    return `<article class="card attraction-card">
      ${canManage ? `<div class="card-tools"><button data-edit-attraction="${item.id}" title="Edytuj">✎</button><button data-delete-attraction="${item.id}" title="Usuń">×</button></div>` : ''}
      <div class="attraction-meta"><span class="attraction-chip">Dodał(a): ${escapeHtml(userName(item.owner))}</span>${item.date ? `<span class="attraction-chip">${fmtDate(item.date)}</span>` : ''}</div>
      <h2>${escapeHtml(item.name)}</h2>
      <div class="attraction-location">⌖ ${escapeHtml(item.location)}</div>
      <p class="attraction-description">${escapeHtml(item.description || 'Brak dodatkowego opisu.')}</p>
      ${link ? `<a class="attraction-link" href="${escapeHtml(link)}" target="_blank" rel="noopener">Otwórz link ↗</a>` : ''}
      <div class="attraction-price">${money(item.price)} razem <span>· ${money(item.price / participants)}/os.</span></div>
      <div class="attraction-footer"><button class="attraction-like ${liked ? 'active' : ''}" data-toggle-attraction-like="${item.id}">${liked ? '♥' : '♡'} ${item.likes.length}</button><p class="attraction-likers">${likerNames ? escapeHtml(likerNames) : 'Nikt jeszcze nie polubił'}</p></div>
    </article>`;
  }).join('');
}

function renderPayments() {
  const target = data.trip.budget / data.trip.people;
  $('#paymentTarget').textContent = money(target);
  $('#paymentScheduleGrid').innerHTML = [...data.paymentSchedule].sort((a, b) => a.due.localeCompare(b.due)).map(item => {
    const overdue = new Date(`${item.due}T23:59:00`) < new Date();
    return `<article class="card schedule-card ${overdue ? 'overdue' : ''}">${isAdmin() ? `<div class="card-tools"><button data-edit-payment-schedule="${item.id}" title="Edytuj">✎</button><button data-delete-payment-schedule="${item.id}" title="Usuń">×</button></div>` : ''}<span class="date-chip">do ${fmtDate(item.due)}</span><h3>${escapeHtml(item.title)}</h3><strong>${money(item.amount)} / os.</strong><p>${escapeHtml(item.note || '')}</p></article>`;
  }).join('');
  $('#paymentsGrid').innerHTML = data.users.map(user => {
    const value = Number(data.payments[user.id] || 0);
    const percent = Math.min(100, Math.round(value / target * 100) || 0);
    return `<article class="person-card"><div class="person-head"><span class="avatar">${initials(user.name)}</span><div><strong>${escapeHtml(user.name)}</strong><small>${user.role === 'admin' ? 'Administrator' : user.status === 'pending' ? 'Oczekuje na konto' : 'Uczestnik'}</small></div></div><div class="person-money"><strong>${money(value)}</strong><span>z ${money(target)}</span></div><div class="progress"><i style="width:${percent}%"></i></div><small class="muted">${percent}% celu · zostało ${money(Math.max(0, target - value))}</small>${isAdmin() ? `<div class="payment-editor"><input type="number" min="0" step="1" value="${value}" aria-label="Wpłata ${escapeHtml(user.name)}"><button class="btn secondary" data-save-payment="${user.id}">Zapisz</button></div>` : ''}</article>`;
  }).join('');
}

function assigneeLabel(task) {
  const targets = taskTargets(task);
  return task.assignees?.includes('all') ? 'Wszyscy' : targets.map(userName).join(', ');
}

function renderChecklist() {
  const tasks = relevantTasks();
  const completed = tasks.filter(taskDone).length;
  const percent = tasks.length ? Math.round(completed / tasks.length * 100) : 0;
  $('#checklistHelp').textContent = isAdmin()
    ? 'Przypisuj wiele osób, dodawaj terminy i kontroluj postęp grupy.'
    : 'Możesz oznaczać wyłącznie zadania przypisane Tobie.';
  $('#checklistPercent').textContent = `${percent}%`;
  $('#checklistProgress').style.width = `${percent}%`;
  $('#checklistCount').textContent = `${completed} z ${tasks.length} Twoich zadań`;
  const groups = [...new Set(tasks.map(task => task.category))];
  $('#checklistGroups').innerHTML = groups.map(group => `<section class="check-group"><h2>${escapeHtml(group)}</h2>${tasks.filter(task => task.category === group).map(task => {
    const targets = taskTargets(task);
    const doneCount = targets.filter(memberId => task.doneBy.includes(memberId)).length;
    return `<div class="check-item ${taskDone(task) ? 'done-for-me' : ''}"><input type="checkbox" data-task-toggle="${task.id}" ${taskDone(task) ? 'checked' : ''} aria-label="Oznacz zadanie"><span>${escapeHtml(task.title)}</span>${isAdmin() ? `<button data-edit-task="${task.id}" title="Edytuj">✎</button>` : ''}<div class="task-meta"><span class="person-chip">${escapeHtml(assigneeLabel(task))}</span>${task.deadline ? `<span class="task-deadline">do ${fmtDate(task.deadline)}</span>` : ''}<span class="task-progress">${doneCount} z ${targets.length} osób wykonało</span>${isAdmin() ? `<button data-delete-task="${task.id}" title="Usuń">×</button>` : ''}</div>${task.comment ? `<div class="task-comment">${escapeHtml(task.comment)}</div>` : ''}</div>`;
  }).join('')}</section>`).join('') || '<div class="card empty">Brak zadań do pokazania.</div>';
}

function renderDrivers() {
  $('#driverShiftGrid').innerHTML = [...data.driverShifts].sort((a, b) => a.start.localeCompare(b.start)).map(shift => `
    <article class="card driver-card">${isAdmin() ? `<div class="card-tools"><button data-edit-driver="${shift.id}" title="Edytuj">✎</button><button data-delete-driver="${shift.id}" title="Usuń">×</button></div>` : ''}<span class="date-chip">${fmtDate(shift.start.slice(0, 10))}</span><h3>${escapeHtml(shift.leg)}</h3><div class="driver-people"><span class="person-chip">Kierowca: ${escapeHtml(userName(shift.driver))}</span><span class="person-chip backup">Zapasowy: ${escapeHtml(userName(shift.backup))}</span></div><div class="driver-time"><span>${new Date(shift.start).toLocaleString('pl-PL', { hour: '2-digit', minute: '2-digit' })} – ${new Date(shift.end).toLocaleString('pl-PL', { hour: '2-digit', minute: '2-digit' })}</span><strong>${Math.max(0, (new Date(shift.end) - new Date(shift.start)) / 3600000).toFixed(1).replace('.', ',')} godz.</strong></div><p>${escapeHtml(shift.note || '')}</p></article>
  `).join('');
}

function renderResources() {
  $('#documentsGrid').innerHTML = data.documents.map(document => `
    <article class="card resource-card">${isAdmin() ? `<div class="card-tools"><button data-edit-document="${document.id}" title="Edytuj">✎</button><button data-delete-document="${document.id}" title="Usuń">×</button></div>` : ''}<span class="date-chip">${escapeHtml(document.type)}</span><h3>${escapeHtml(document.title)}</h3><p>${escapeHtml(document.note || '')}</p><a href="${escapeHtml(document.url)}" target="_blank" rel="noopener">Otwórz dokument ↗</a></article>
  `).join('');
  $('#emergencyGrid').innerHTML = data.emergencyContacts.map(contact => `
    <article class="card resource-card">${isAdmin() ? `<div class="card-tools"><button data-edit-emergency="${contact.id}" title="Edytuj">✎</button><button data-delete-emergency="${contact.id}" title="Usuń">×</button></div>` : ''}<span class="date-chip">${escapeHtml(contact.category)}</span><h3>${escapeHtml(contact.name)}</h3>${contact.phone ? `<a class="contact-phone" href="tel:${escapeHtml(contact.phone.replace(/\s/g, ''))}">${escapeHtml(contact.phone)}</a>` : '<p>Numer do uzupełnienia przez administratora.</p>'}<p>${escapeHtml(contact.note || '')}</p></article>
  `).join('');
}

function renderPlan() {
  $('#planTimeline').innerHTML = [...data.plan].sort((a, b) => a.day - b.day).map(item => `
    <article class="plan-entry"><div class="plan-number"><div>DZIEŃ<strong>${item.day}</strong></div></div><div class="plan-content"><header><div><small class="muted">${fmtDate(item.date)}</small><h2>${escapeHtml(item.title)}</h2></div>${isAdmin() ? `<div class="row-actions"><button data-edit-plan="${item.id}">✎</button><button data-delete-plan="${item.id}">×</button></div>` : ''}</header><p>${escapeHtml(item.description)}</p></div></article>
  `).join('');
}

function routeMapLink() {
  const stops = data.route.map(stop => encodeURIComponent(`${stop.city}, ${stop.country}`));
  return `https://www.google.com/maps/dir/${stops.join('/')}`;
}

function stopMapLink(stop) {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${stop.city}, ${stop.country}`)}`;
}

const FUEL_COUNTRY_CODES = { Polska: 'PL', Czechy: 'CZ', Austria: 'AT', Słowenia: 'SI', Chorwacja: 'HR', Węgry: 'HU' };
let liveFuelPrices = null;
let fuelCurrencyRates = null;
let fuelPricesLoading = false;
let selectedFuelStopIndex = 0;
let routeMapInstance = null;
let routeMapMarkers = [];

function fuelMarkerIcon(index) {
  return L.divIcon({
    className: '',
    html: `<div class="route-map-marker ${data.route[index]?.city === 'Makarska' ? 'destination' : ''} ${index === selectedFuelStopIndex ? 'selected' : ''}">${index + 1}</div>`,
    iconSize: [30, 30], iconAnchor: [15, 15]
  });
}

function fuelPriceInPln(stop) {
  const code = FUEL_COUNTRY_CODES[stop.country];
  const country = liveFuelPrices?.[code];
  const type = $('#fuelType')?.value || 'diesel';
  const raw = country?.prices?.[type];
  const currency = country?.currency || 'EUR';
  const plnRate = fuelCurrencyRates?.PLN;
  const currencyRate = fuelCurrencyRates?.[currency] || 1;
  if (!raw || !plnRate) return null;
  return raw / currencyRate * plnRate;
}

function applySelectedFuelPrice() {
  const stop = data.route[selectedFuelStopIndex] || data.route[0];
  if (!stop) return;
  const price = fuelPriceInPln(stop);
  $('#fuelSelectedLocation').textContent = stop.country;
  $('#fuelSelectedStop').value = stop.city;
  $$('#fuelCountryButtons button').forEach(button => button.classList.toggle('active', button.dataset.country === stop.country));
  routeMapMarkers.forEach((marker, index) => marker.setIcon(fuelMarkerIcon(index)));
  if (price) {
    $('#fuelPrice').value = price.toFixed(2);
    calculateFuel();
    const country = liveFuelPrices[FUEL_COUNTRY_CODES[stop.country]];
    const updated = country?.fetched_at || '';
    $('#fuelPriceMeta').innerHTML = `Średnia krajowa: <strong>${price.toFixed(2).replace('.', ',')} zł/l</strong> · aktualizacja ${updated ? new Date(updated).toLocaleDateString('pl-PL') : 'cotygodniowa'} · <a href="https://openvan.camp/" target="_blank" rel="noopener">OpenVan.camp</a> (CC BY 4.0)`;
  }
}

function selectFuelStop(index) {
  selectedFuelStopIndex = Math.max(0, Math.min(data.route.length - 1, Number(index) || 0));
  applySelectedFuelPrice();
}

function renderFuelCountryButtons() {
  const unique = [];
  data.route.forEach((stop, index) => {
    if (!unique.some(item => item.country === stop.country)) unique.push({ country: stop.country, index });
  });
  $('#fuelCountryButtons').innerHTML = unique.map(item => `<button type="button" data-country="${escapeHtml(item.country)}" data-stop-index="${item.index}">${escapeHtml(item.country)}</button>`).join('');
  $$('#fuelCountryButtons button').forEach(button => {
    button.onclick = () => selectFuelStop(button.dataset.stopIndex);
  });
}

async function loadFuelPrices(force = false) {
  if (fuelPricesLoading || (liveFuelPrices && !force)) {
    applySelectedFuelPrice();
    return;
  }
  fuelPricesLoading = true;
  $('#fuelPriceMeta').textContent = 'Pobieranie aktualnych cen paliwa…';
  try {
    const [pricesResponse, ratesResponse] = await Promise.all([
      fetch('https://openvan.camp/api/fuel/prices?source=chorwacja-2027.vercel.app'),
      fetch('https://openvan.camp/api/currency/rates')
    ]);
    if (!pricesResponse.ok || !ratesResponse.ok) throw new Error('Nie udało się pobrać cen');
    const pricesJson = await pricesResponse.json();
    const ratesJson = await ratesResponse.json();
    liveFuelPrices = pricesJson.data;
    fuelCurrencyRates = ratesJson.rates;
    applySelectedFuelPrice();
  } catch (error) {
    console.warn('Aktualne ceny paliwa są niedostępne.', error);
    $('#fuelPriceMeta').textContent = 'Nie udało się pobrać aktualnych cen. Możesz wpisać cenę ręcznie.';
  } finally {
    fuelPricesLoading = false;
  }
}

function renderRoute() {
  $('#googleRouteLink').href = routeMapLink();
  $('#routeStops').innerHTML = data.route.map((stop, index) => `<div class="route-stop"><span class="stop-dot">${index + 1}</span><div><h3>${escapeHtml(stop.city)} <small class="muted">· ${escapeHtml(stop.country)}</small></h3><p>${escapeHtml(stop.note)} · ${stop.km.toLocaleString('pl-PL')} km od startu</p></div><a href="${stopMapLink(stop)}" target="_blank" rel="noopener">Pokaż na mapie ↗</a></div>`).join('');
  $('#fuelDistance').value = data.fuel.distance;
  $('#fuelConsumption').value = data.fuel.consumption;
  $('#fuelPrice').value = data.fuel.price;
  renderFuelCountryButtons();
  calculateFuel();
  loadFuelPrices();
}

function renderInteractiveMap() {
  const container = $('#routeMap');
  if (!container) return;
  if (!window.L) {
    container.innerHTML = '<div class="map-fallback">Nie udało się załadować mapy. Sprawdź połączenie lub otwórz trasę w Google Maps.</div>';
    return;
  }
  if (routeMapInstance) {
    routeMapInstance.invalidateSize();
    return;
  }
  if (!data.route.length) return;
  container.innerHTML = '';
  routeMapInstance = L.map('routeMap', { scrollWheelZoom: false }).setView([49, 17], 5);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '&copy; OpenStreetMap contributors'
  }).addTo(routeMapInstance);
  const points = data.route.map(stop => [stop.lat, stop.lng]);
  routeMapMarkers = data.route.map((stop, index) => L.marker([stop.lat, stop.lng], { icon: fuelMarkerIcon(index) })
    .addTo(routeMapInstance)
    .bindPopup(`<div class="map-popup"><h3>${escapeHtml(stop.city)}, ${escapeHtml(stop.country)}</h3><p>${escapeHtml(stop.note)} · ${stop.km.toLocaleString('pl-PL')} km od startu</p></div>`)
    .on('click', () => selectFuelStop(index)));
  routeMapInstance.on('click', event => {
    let nearest = 0;
    let best = Infinity;
    data.route.forEach((stop, index) => {
      const distance = event.latlng.distanceTo(L.latLng(stop.lat, stop.lng));
      if (distance < best) { best = distance; nearest = index; }
    });
    selectFuelStop(nearest);
    routeMapMarkers[nearest].openPopup();
  });
  L.polyline(points, { color: '#147c6f', weight: 5, opacity: .82, dashArray: '10 8' }).addTo(routeMapInstance);
  routeMapInstance.fitBounds(points, { padding: [35, 35] });
}

function calculateFuel() {
  const distance = Math.max(0, Number($('#fuelDistance').value) || 0);
  const consumption = Math.max(0, Number($('#fuelConsumption').value) || 0);
  const price = Math.max(0, Number($('#fuelPrice').value) || 0);
  const liters = distance * consumption / 100;
  const total = liters * price;
  $('#routeDistanceStat').textContent = `${distance.toLocaleString('pl-PL')} km`;
  $('#fuelLiters').textContent = `${liters.toFixed(1).replace('.', ',')} l`;
  $('#fuelTotal').textContent = money(total);
  $('#fuelPerPerson').textContent = money(total / data.trip.people);
  return { distance, consumption, price, total };
}

function renderSettings() {
  if (!isAdmin()) return;
  $('#tripName').value = data.trip.name;
  $('#tripDestination').value = data.trip.destination;
  $('#tripStart').value = data.trip.start;
  $('#tripEnd').value = data.trip.end;
  $('#tripPeople').value = data.trip.people;
  $('#tripBudget').value = data.trip.budget;
  $('#tripDescription').value = data.trip.description;
}

function navigate(name) {
  if (!appStarted && !currentUser) return;
  if (name === 'settings' && !isAdmin()) name = 'dashboard';
  const viewNames = {
    dashboard: 'Chorwacja 2027',
    expenses: 'Wydatki',
    payments: 'Wpłaty',
    checklist: 'Checklista',
    attractions: 'Atrakcje',
    drivers: 'Grafik kierowców',
    resources: 'Dokumenty i SOS',
    plan: 'Plan podróży',
    route: 'Trasa i paliwo',
    links: 'Przydatne linki',
    settings: 'Dane wyjazdu'
  };
  document.body.dataset.currentView = name;
  $('#menuBtn').textContent = name === 'dashboard' ? 'C' : '‹';
  $('#menuBtn').setAttribute('aria-label', name === 'dashboard' ? 'Chorwacja 2027' : 'Wróć do pulpitu');
  $('#mobileViewTitle strong').textContent = viewNames[name] || 'Chorwacja 2027';
  $('#mobileViewTitle span').textContent = name === 'dashboard' ? '15–24 czerwca' : '';
  $$('.view').forEach(view => view.classList.toggle('active', view.id === `view-${name}`));
  $$('[data-view]').forEach(button => button.classList.toggle('active', button.dataset.view === name));
  $('#sidebar').classList.remove('open');
  if (name === 'route') requestAnimationFrame(() => setTimeout(renderInteractiveMap, 0));
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function updateAttractionPricePreview() {
  const price = Math.max(0, Number($('#attractionPrice').value) || 0);
  const participants = Math.max(1, data.users.length);
  $('#attractionPricePreview').textContent = `${money(price)} razem · ${money(price / participants)}/os. dla ${participants} osób`;
}

function openAttraction(item = null) {
  $('#attractionForm').reset();
  $('#attractionId').value = item?.id || '';
  $('#attractionDialogTitle').textContent = item ? 'Edytuj atrakcję' : 'Dodaj atrakcję';
  $('#attractionName').value = item?.name || '';
  $('#attractionLocation').value = item?.location || '';
  $('#attractionPrice').value = item?.price ?? '';
  $('#attractionDate').value = item?.date || '';
  $('#attractionUrl').value = item?.url || '';
  $('#attractionDescription').value = item?.description || '';
  updateAttractionPricePreview();
  $('#attractionDialog').showModal();
}

function selectedExpenseParticipants() {
  return $$('#expenseParticipants input:checked').map(input => input.value);
}

function updateSplitPreview() {
  const count = selectedExpenseParticipants().length;
  const amount = Number($('#expenseAmount').value) || 0;
  $('#splitPreview').textContent = count
    ? `${money(amount)} ÷ ${count} = ${money(amount / count)} na osobę`
    : 'Wybierz co najmniej jedną osobę.';
}

function toggleDepositField() {
  const enabled = $('#expenseHasDeposit').checked;
  $('#depositAmountWrap').classList.toggle('hidden', !enabled);
  $('#expenseDepositAmount').required = enabled;
  if (!enabled) $('#expenseDepositAmount').value = '';
}

function openExpense(expense = null) {
  $('#expenseForm').reset();
  $('#expenseId').value = expense?.id || '';
  $('#expenseDialogTitle').textContent = expense ? 'Edytuj wydatek' : 'Dodaj wydatek';
  $('#expenseName').value = expense?.name || '';
  $('#expenseAmount').value = expense?.amount || '';
  $('#expenseCategory').value = expense?.category || 'Transport';
  $('#expenseStatus').value = expense?.status || 'planned';
  $('#expenseDate').value = expense?.date || new Date().toISOString().slice(0, 10);
  $('#expenseNote').value = expense?.note || '';
  $('#expenseHasDeposit').checked = Boolean(expense?.hasDeposit);
  $('#expenseDepositAmount').value = expense?.depositAmount || '';
  toggleDepositField();
  const selected = expense?.participants || data.users.map(user => user.id);
  $('#expenseParticipants').innerHTML = data.users.map(user => `<label><input type="checkbox" value="${user.id}" ${selected.includes(user.id) ? 'checked' : ''}><span>${escapeHtml(user.name)}</span></label>`).join('');
  updateSplitPreview();
  $('#expenseDialog').showModal();
}

function selectedTaskAssignees() {
  return $$('#taskAssignees input:checked').map(input => input.value);
}

function openTask(task = null) {
  $('#taskForm').reset();
  $('#taskId').value = task?.id || '';
  $('#taskDialogTitle').textContent = task ? 'Edytuj zadanie' : 'Dodaj zadanie';
  $('#taskTitle').value = task?.title || '';
  const category = task?.category || '📄 Dokumenty i finanse';
  const select = $('#taskCategory');
  if (![...select.options].some(option => option.value === category)) select.add(new Option(category, category));
  select.value = category;
  $('#taskDeadline').value = task?.deadline || '';
  $('#taskComment').value = task?.comment || '';
  const selected = task?.assignees?.includes('all') ? data.users.map(user => user.id) : (task?.assignees || []);
  $('#taskAssignees').innerHTML = data.users.map(user => `<label><input type="checkbox" value="${user.id}" ${selected.includes(user.id) ? 'checked' : ''}><span>${escapeHtml(user.name)}</span></label>`).join('');
  $('#taskDialog').showModal();
}

function openPaymentSchedule(item = null) {
  $('#paymentScheduleForm').reset();
  $('#paymentScheduleId').value = item?.id || '';
  $('#paymentScheduleTitle').textContent = item ? 'Edytuj termin wpłaty' : 'Dodaj termin wpłaty';
  $('#paymentScheduleName').value = item?.title || '';
  $('#paymentScheduleAmount').value = item?.amount || '';
  $('#paymentScheduleDue').value = item?.due || '';
  $('#paymentScheduleNote').value = item?.note || '';
  $('#paymentScheduleDialog').showModal();
}

function fillUserSelect(select, value) {
  select.innerHTML = data.users.map(user => `<option value="${user.id}">${escapeHtml(user.name)}</option>`).join('');
  select.value = value || data.users[0]?.id || '';
}

function openDriverShift(item = null) {
  $('#driverShiftForm').reset();
  $('#driverShiftId').value = item?.id || '';
  $('#driverShiftTitle').textContent = item ? 'Edytuj zmianę' : 'Dodaj zmianę kierowcy';
  $('#driverShiftLeg').value = item?.leg || '';
  fillUserSelect($('#driverShiftDriver'), item?.driver || currentUser.id);
  fillUserSelect($('#driverShiftBackup'), item?.backup || data.users.find(user => user.id !== currentUser.id)?.id);
  $('#driverShiftStart').value = item?.start || `${data.trip.start}T18:00`;
  $('#driverShiftEnd').value = item?.end || `${data.trip.start}T21:00`;
  $('#driverShiftNote').value = item?.note || '';
  $('#driverShiftDialog').showModal();
}

function openDocument(item = null) {
  $('#documentForm').reset();
  $('#documentId').value = item?.id || '';
  $('#documentDialogTitle').textContent = item ? 'Edytuj link' : 'Dodaj link';
  $('#documentTitle').value = item?.title || '';
  $('#documentType').value = item?.type || '';
  $('#documentUrl').value = item?.url || '';
  $('#documentNote').value = item?.note || '';
  $('#documentDialog').showModal();
}

function openEmergency(item = null) {
  $('#emergencyForm').reset();
  $('#emergencyId').value = item?.id || '';
  $('#emergencyDialogTitle').textContent = item ? 'Edytuj kontakt' : 'Dodaj kontakt';
  $('#emergencyName').value = item?.name || '';
  $('#emergencyPhone').value = item?.phone || '';
  $('#emergencyCategory').value = item?.category || '';
  $('#emergencyNote').value = item?.note || '';
  $('#emergencyDialog').showModal();
}

function askConfirm(title, text, action) {
  $('#confirmTitle').textContent = title;
  $('#confirmText').textContent = text;
  confirmAction = action;
  $('#confirmDialog').showModal();
}

async function syncExpenseParticipants(expenseId, desiredIds, previousIds = []) {
  const client = window.tripSupabase;
  const previous = new Set(previousIds);
  const desired = new Set(desiredIds);
  const additions = desiredIds.filter(memberId => !previous.has(memberId));
  const removals = previousIds.filter(memberId => !desired.has(memberId));
  if (additions.length) {
    assertResult(await client.from('expense_participants').upsert(additions.map(memberId => ({
      expense_id: expenseId, trip_id: TRIP_ID, member_id: memberId
    })), { onConflict: 'expense_id,member_id' }));
  }
  for (const memberId of removals) {
    assertResult(await client.from('expense_participants').delete()
      .eq('expense_id', expenseId).eq('member_id', memberId));
  }
}

async function saveExpenseRecord(item, previous = null) {
  const client = window.tripSupabase;
  const payload = {
    trip_id: TRIP_ID,
    name: item.name,
    amount: item.amount,
    category: item.category,
    status: item.status,
    expense_date: item.date,
    note: item.note,
    has_deposit: item.hasDeposit,
    deposit_amount: item.depositAmount
  };
  let expenseId = item.id;
  if (expenseId) {
    assertResult(await client.from('expenses').update(payload).eq('id', expenseId).select('id').single());
  } else {
    const inserted = assertResult(await client.from('expenses').insert({
      ...payload, owner_member_id: currentUser.id
    }).select('id').single());
    expenseId = inserted.id;
  }
  await syncExpenseParticipants(expenseId, item.participants, previous?.participants || []);
  return expenseId;
}

async function syncTaskAssignees(taskId, desiredIds, previousIds = []) {
  const client = window.tripSupabase;
  const previous = new Set(previousIds);
  const desired = new Set(desiredIds);
  const additions = desiredIds.filter(memberId => !previous.has(memberId));
  const removals = previousIds.filter(memberId => !desired.has(memberId));
  if (additions.length) {
    assertResult(await client.from('task_assignees').upsert(additions.map(memberId => ({
      task_id: taskId, trip_id: TRIP_ID, member_id: memberId
    })), { onConflict: 'task_id,member_id' }));
  }
  for (const memberId of removals) {
    assertResult(await client.from('task_assignees').delete()
      .eq('task_id', taskId).eq('member_id', memberId));
  }
}

$('#mainNav').addEventListener('click', event => {
  const button = event.target.closest('[data-view]');
  if (button) navigate(button.dataset.view);
});

$('.mobile-nav').addEventListener('click', event => {
  const button = event.target.closest('[data-view]');
  if (button) navigate(button.dataset.view);
});

document.addEventListener('click', async event => {
  const goto = event.target.closest('[data-goto]');
  if (goto) navigate(goto.dataset.goto);

  const toggle = event.target.closest('[data-task-toggle]');
  if (toggle) {
    const task = data.tasks.find(item => item.id === toggle.dataset.taskToggle);
    if (!task || !taskTargets(task).includes(currentUser.id)) return;
    const checked = toggle.checked;
    await runWrite(checked ? 'Zadanie oznaczone jako wykonane' : 'Cofnięto wykonanie zadania', async () => {
      if (checked) {
        assertResult(await window.tripSupabase.from('task_completions').upsert({
          task_id: task.id, trip_id: TRIP_ID, member_id: currentUser.id
        }, { onConflict: 'task_id,member_id' }));
      } else {
        assertResult(await window.tripSupabase.from('task_completions').delete()
          .eq('task_id', task.id).eq('member_id', currentUser.id));
      }
    });
  }

  const attractionLike = event.target.closest('[data-toggle-attraction-like]');
  if (attractionLike) {
    const attraction = data.attractions.find(item => item.id === attractionLike.dataset.toggleAttractionLike);
    if (!attraction) return;
    const liked = attraction.likes.includes(currentUser.id);
    await runWrite(liked ? 'Cofnięto polubienie' : 'Atrakcja polubiona', async () => {
      if (liked) {
        assertResult(await window.tripSupabase.from('attraction_likes').delete()
          .eq('attraction_id', attraction.id)
          .eq('member_id', currentUser.id));
      } else {
        assertResult(await window.tripSupabase.from('attraction_likes').insert({
          attraction_id: attraction.id,
          trip_id: TRIP_ID,
          member_id: currentUser.id
        }));
      }
    });
  }

  const editAttraction = event.target.closest('[data-edit-attraction]');
  if (editAttraction) {
    const attraction = data.attractions.find(item => item.id === editAttraction.dataset.editAttraction);
    if (attraction && (isAdmin() || attraction.owner === currentUser.id)) openAttraction(attraction);
  }

  const deleteAttraction = event.target.closest('[data-delete-attraction]');
  if (deleteAttraction) {
    const attraction = data.attractions.find(item => item.id === deleteAttraction.dataset.deleteAttraction);
    if (attraction && (isAdmin() || attraction.owner === currentUser.id)) {
      askConfirm('Usunąć atrakcję?', 'Atrakcja, polubienia i powiązany wydatek zostaną usunięte.', () => runWrite('Atrakcja i wydatek zostały usunięte', async () => {
        assertResult(await window.tripSupabase.from('attractions').delete()
          .eq('id', attraction.id)
          .eq('trip_id', TRIP_ID));
      }));
    }
  }

  const editExpense = event.target.closest('[data-edit-expense]');
  if (editExpense) {
    const expense = data.expenses.find(item => item.id === editExpense.dataset.editExpense);
    if (expense && (isAdmin() || expense.owner === currentUser.id)) openExpense(expense);
  }

  const deleteExpense = event.target.closest('[data-delete-expense]');
  if (deleteExpense && isAdmin()) askConfirm('Usunąć wydatek?', 'Ta pozycja zniknie z budżetu.', () => runWrite('Wydatek usunięty', async () => {
    assertResult(await window.tripSupabase.from('expenses').delete().eq('id', deleteExpense.dataset.deleteExpense).select('id').single());
  }));

  const deleteTask = event.target.closest('[data-delete-task]');
  if (deleteTask && isAdmin()) askConfirm('Usunąć zadanie?', 'Zadanie zostanie usunięte z checklisty.', () => runWrite('Zadanie usunięte', async () => {
    assertResult(await window.tripSupabase.from('tasks').delete().eq('id', deleteTask.dataset.deleteTask).select('id').single());
  }));

  const savePayment = event.target.closest('[data-save-payment]');
  if (savePayment && isAdmin()) {
    const input = savePayment.parentElement.querySelector('input');
    await runWrite('Wpłata zaktualizowana', async () => {
      assertResult(await window.tripSupabase.from('payments').upsert({
        trip_id: TRIP_ID,
        member_id: savePayment.dataset.savePayment,
        amount: Math.max(0, Number(input.value))
      }, { onConflict: 'trip_id,member_id' }));
    });
  }

  const editPlan = event.target.closest('[data-edit-plan]');
  if (editPlan && isAdmin()) {
    const item = data.plan.find(plan => plan.id === editPlan.dataset.editPlan);
    $('#planForm').reset();
    $('#planId').value = item.id;
    $('#planDialogTitle').textContent = 'Edytuj punkt planu';
    $('#planDay').value = item.day;
    $('#planDate').value = item.date;
    $('#planTitle').value = item.title;
    $('#planDescription').value = item.description;
    $('#planDialog').showModal();
  }

  const deletePlan = event.target.closest('[data-delete-plan]');
  if (deletePlan && isAdmin()) askConfirm('Usunąć punkt planu?', 'Ten dzień zniknie z harmonogramu.', () => runWrite('Punkt planu usunięty', async () => {
    assertResult(await window.tripSupabase.from('trip_plan').delete().eq('id', deletePlan.dataset.deletePlan).select('id').single());
  }));
});

document.addEventListener('click', event => {
  if (!isAdmin()) return;
  const editTask = event.target.closest('[data-edit-task]');
  if (editTask) openTask(data.tasks.find(task => task.id === editTask.dataset.editTask));
  const editSchedule = event.target.closest('[data-edit-payment-schedule]');
  if (editSchedule) openPaymentSchedule(data.paymentSchedule.find(item => item.id === editSchedule.dataset.editPaymentSchedule));
  const deleteSchedule = event.target.closest('[data-delete-payment-schedule]');
  if (deleteSchedule) askConfirm('Usunąć termin wpłaty?', 'Termin zniknie z harmonogramu.', () => runWrite('Termin usunięty', async () => {
    assertResult(await window.tripSupabase.from('payment_schedule').delete().eq('id', deleteSchedule.dataset.deletePaymentSchedule).select('id').single());
  }));
  const editDriver = event.target.closest('[data-edit-driver]');
  if (editDriver) openDriverShift(data.driverShifts.find(item => item.id === editDriver.dataset.editDriver));
  const deleteDriver = event.target.closest('[data-delete-driver]');
  if (deleteDriver) askConfirm('Usunąć zmianę kierowcy?', 'Odcinek zniknie z grafiku.', () => runWrite('Zmiana usunięta', async () => {
    assertResult(await window.tripSupabase.from('driver_shifts').delete().eq('id', deleteDriver.dataset.deleteDriver).select('id').single());
  }));
  const editDocument = event.target.closest('[data-edit-document]');
  if (editDocument) openDocument(data.documents.find(item => item.id === editDocument.dataset.editDocument));
  const deleteDocument = event.target.closest('[data-delete-document]');
  if (deleteDocument) askConfirm('Usunąć dokument?', 'Link zostanie usunięty dla całej grupy.', () => runWrite('Dokument usunięty', async () => {
    assertResult(await window.tripSupabase.from('documents').delete().eq('id', deleteDocument.dataset.deleteDocument).select('id').single());
  }));
  const editEmergency = event.target.closest('[data-edit-emergency]');
  if (editEmergency) openEmergency(data.emergencyContacts.find(item => item.id === editEmergency.dataset.editEmergency));
  const deleteEmergency = event.target.closest('[data-delete-emergency]');
  if (deleteEmergency) askConfirm('Usunąć kontakt?', 'Kontakt zniknie dla całej grupy.', () => runWrite('Kontakt usunięty', async () => {
    assertResult(await window.tripSupabase.from('emergency_contacts').delete().eq('id', deleteEmergency.dataset.deleteEmergency).select('id').single());
  }));
});

$('#addAttractionBtn').onclick = () => openAttraction();
$('#attractionSort').onchange = renderAttractions;
$('#attractionPrice').oninput = updateAttractionPricePreview;

$('#attractionForm').addEventListener('submit', async event => {
  event.preventDefault();
  const attractionId = $('#attractionId').value;
  const previous = data.attractions.find(item => item.id === attractionId);
  if (previous && !isAdmin() && previous.owner !== currentUser.id) return;

  const payload = {
    trip_id: TRIP_ID,
    name: $('#attractionName').value.trim(),
    description: $('#attractionDescription').value.trim(),
    location: $('#attractionLocation').value.trim(),
    url: $('#attractionUrl').value.trim() || null,
    planned_date: $('#attractionDate').value || null,
    price: Math.max(0, Number($('#attractionPrice').value) || 0)
  };

  const saved = await runWrite(attractionId ? 'Atrakcja i wydatek zostały zaktualizowane' : 'Atrakcja i wydatek zostały dodane', async () => {
    const query = attractionId
      ? window.tripSupabase.from('attractions').update(payload).eq('id', attractionId).select('id').single()
      : window.tripSupabase.from('attractions').insert({
        ...payload,
        created_by_member_id: currentUser.id
      }).select('id').single();
    assertResult(await query);
  });
  if (saved) $('#attractionDialog').close();
});

$('#addExpenseBtn').onclick = () => openExpense();
$('#expenseSearch').oninput = renderExpenses;
$('#expenseFilter').onchange = renderExpenses;

$('#expenseForm').addEventListener('submit', async event => {
  event.preventDefault();
  const expenseId = $('#expenseId').value;
  const previous = data.expenses.find(item => item.id === expenseId);
  const participants = selectedExpenseParticipants();
  const hasDeposit = $('#expenseHasDeposit').checked;
  if (previous && !isAdmin() && previous.owner !== currentUser.id) return;
  if (!participants.length) { updateSplitPreview(); return; }
  const item = {
    id: expenseId || null,
    name: $('#expenseName').value.trim(),
    amount: Number($('#expenseAmount').value),
    category: $('#expenseCategory').value,
    status: $('#expenseStatus').value,
    date: $('#expenseDate').value,
    note: $('#expenseNote').value.trim(),
    participants,
    hasDeposit,
    depositAmount: hasDeposit ? Number($('#expenseDepositAmount').value) : 0
  };
  const saved = await runWrite(expenseId ? 'Wydatek zaktualizowany' : 'Wydatek dodany', () => saveExpenseRecord(item, previous));
  if (saved) $('#expenseDialog').close();
});

$('#expenseParticipants').addEventListener('change', updateSplitPreview);
$('#expenseAmount').addEventListener('input', updateSplitPreview);
$('#selectAllParticipants').onclick = () => { $$('#expenseParticipants input').forEach(input => { input.checked = true; }); updateSplitPreview(); };
$('#clearParticipants').onclick = () => { $$('#expenseParticipants input').forEach(input => { input.checked = false; }); updateSplitPreview(); };
$('#expenseHasDeposit').addEventListener('change', toggleDepositField);

$('#addTaskBtn').onclick = () => openTask();
$('#taskSelectAll').onclick = () => $$('#taskAssignees input').forEach(input => { input.checked = true; });
$('#taskSelectMe').onclick = () => $$('#taskAssignees input').forEach(input => { input.checked = input.value === currentUser.id; });
$('#taskClearAssignees').onclick = () => $$('#taskAssignees input').forEach(input => { input.checked = false; });

$('#taskForm').addEventListener('submit', async event => {
  event.preventDefault();
  if (!isAdmin()) return;
  const taskId = $('#taskId').value;
  const previous = data.tasks.find(item => item.id === taskId);
  const selected = selectedTaskAssignees();
  if (!selected.length) { toast('Wybierz co najmniej jedną osobę'); return; }
  const previousTargets = previous ? taskTargets(previous) : [];
  const saved = await runWrite(taskId ? 'Zadanie zaktualizowane' : 'Zadanie dodane', async () => {
    const payload = {
      trip_id: TRIP_ID,
      title: $('#taskTitle').value.trim(),
      category: $('#taskCategory').value,
      deadline: $('#taskDeadline').value || null,
      comment: $('#taskComment').value.trim()
    };
    let id = taskId;
    if (id) {
      assertResult(await window.tripSupabase.from('tasks').update(payload).eq('id', id).select('id').single());
    } else {
      id = assertResult(await window.tripSupabase.from('tasks').insert(payload).select('id').single()).id;
    }
    await syncTaskAssignees(id, selected, previousTargets);
  });
  if (saved) $('#taskDialog').close();
});

$('#addPaymentScheduleBtn').onclick = () => openPaymentSchedule();
$('#paymentScheduleForm').addEventListener('submit', async event => {
  event.preventDefault();
  if (!isAdmin()) return;
  const itemId = $('#paymentScheduleId').value;
  const payload = {
    trip_id: TRIP_ID,
    title: $('#paymentScheduleName').value.trim(),
    amount_per_person: Number($('#paymentScheduleAmount').value),
    due_date: $('#paymentScheduleDue').value,
    note: $('#paymentScheduleNote').value.trim()
  };
  const saved = await runWrite('Harmonogram wpłat zapisany', async () => {
    const query = itemId
      ? window.tripSupabase.from('payment_schedule').update(payload).eq('id', itemId).select('id').single()
      : window.tripSupabase.from('payment_schedule').insert(payload).select('id').single();
    assertResult(await query);
  });
  if (saved) $('#paymentScheduleDialog').close();
});

$('#addDriverShiftBtn').onclick = () => openDriverShift();
$('#driverShiftForm').addEventListener('submit', async event => {
  event.preventDefault();
  if (!isAdmin()) return;
  const itemId = $('#driverShiftId').value;
  const start = $('#driverShiftStart').value;
  const end = $('#driverShiftEnd').value;
  if (new Date(end) <= new Date(start)) { toast('Koniec zmiany musi być po jej rozpoczęciu'); return; }
  const payload = {
    trip_id: TRIP_ID,
    leg: $('#driverShiftLeg').value.trim(),
    driver_member_id: $('#driverShiftDriver').value,
    backup_member_id: $('#driverShiftBackup').value,
    start_at: new Date(start).toISOString(),
    end_at: new Date(end).toISOString(),
    note: $('#driverShiftNote').value.trim()
  };
  const saved = await runWrite('Grafik kierowców zapisany', async () => {
    const query = itemId
      ? window.tripSupabase.from('driver_shifts').update(payload).eq('id', itemId).select('id').single()
      : window.tripSupabase.from('driver_shifts').insert(payload).select('id').single();
    assertResult(await query);
  });
  if (saved) $('#driverShiftDialog').close();
});

$('#addDocumentBtn').onclick = () => openDocument();
$('#documentForm').addEventListener('submit', async event => {
  event.preventDefault();
  if (!isAdmin()) return;
  const itemId = $('#documentId').value;
  const payload = {
    trip_id: TRIP_ID,
    title: $('#documentTitle').value.trim(),
    document_type: $('#documentType').value.trim(),
    url: $('#documentUrl').value.trim(),
    note: $('#documentNote').value.trim()
  };
  const saved = await runWrite('Dokument zapisany', async () => {
    const query = itemId
      ? window.tripSupabase.from('documents').update(payload).eq('id', itemId).select('id').single()
      : window.tripSupabase.from('documents').insert(payload).select('id').single();
    assertResult(await query);
  });
  if (saved) $('#documentDialog').close();
});

$('#addEmergencyBtn').onclick = () => openEmergency();
$('#emergencyForm').addEventListener('submit', async event => {
  event.preventDefault();
  if (!isAdmin()) return;
  const itemId = $('#emergencyId').value;
  const payload = {
    trip_id: TRIP_ID,
    name: $('#emergencyName').value.trim(),
    phone: $('#emergencyPhone').value.trim(),
    category: $('#emergencyCategory').value.trim(),
    note: $('#emergencyNote').value.trim()
  };
  const saved = await runWrite('Kontakt zapisany', async () => {
    const query = itemId
      ? window.tripSupabase.from('emergency_contacts').update(payload).eq('id', itemId).select('id').single()
      : window.tripSupabase.from('emergency_contacts').insert(payload).select('id').single();
    assertResult(await query);
  });
  if (saved) $('#emergencyDialog').close();
});

$('#addPlanBtn').onclick = () => {
  if (!isAdmin()) return;
  $('#planForm').reset();
  $('#planId').value = '';
  $('#planDialogTitle').textContent = 'Dodaj punkt planu';
  $('#planDate').value = data.trip.start;
  $('#planDialog').showModal();
};

$('#planForm').addEventListener('submit', async event => {
  event.preventDefault();
  if (!isAdmin()) return;
  const itemId = $('#planId').value;
  const payload = {
    trip_id: TRIP_ID,
    day_number: Number($('#planDay').value),
    plan_date: $('#planDate').value,
    title: $('#planTitle').value.trim(),
    description: $('#planDescription').value.trim()
  };
  const saved = await runWrite('Plan zaktualizowany', async () => {
    const query = itemId
      ? window.tripSupabase.from('trip_plan').update(payload).eq('id', itemId).select('id').single()
      : window.tripSupabase.from('trip_plan').insert(payload).select('id').single();
    assertResult(await query);
  });
  if (saved) $('#planDialog').close();
});

$('#tripForm').addEventListener('submit', async event => {
  event.preventDefault();
  if (!isAdmin()) return;
  await runWrite('Dane wyjazdu zapisane', async () => {
    assertResult(await window.tripSupabase.from('trips').update({
      name: $('#tripName').value.trim(),
      destination: $('#tripDestination').value.trim(),
      start_date: $('#tripStart').value,
      end_date: $('#tripEnd').value,
      participant_limit: Number($('#tripPeople').value),
      budget: Number($('#tripBudget').value),
      description: $('#tripDescription').value.trim()
    }).eq('id', TRIP_ID).select('id').single());
  });
});

$('#fuelForm').addEventListener('input', () => {
  const result = calculateFuel();
  if (!isAdmin()) return;
  clearTimeout(fuelSaveTimer);
  fuelSaveTimer = setTimeout(() => runWrite('', async () => {
    assertResult(await window.tripSupabase.from('fuel_settings').upsert({
      trip_id: TRIP_ID,
      distance_km: result.distance,
      consumption_l_per_100km: result.consumption,
      price_pln_per_l: result.price
    }, { onConflict: 'trip_id' }));
  }), 700);
});

$('#fuelType').addEventListener('change', applySelectedFuelPrice);
$('#refreshFuelPrices').onclick = () => loadFuelPrices(true);
$('#saveFuelExpense').onclick = async () => {
  if (!isAdmin()) return;
  const result = calculateFuel();
  const previous = data.expenses.find(expense => expense.name.toLowerCase().includes('paliwo'));
  const item = {
    id: previous?.id || null,
    name: 'Paliwo — cała trasa',
    category: 'Transport',
    amount: Math.round(result.total),
    status: previous?.status || 'planned',
    date: previous?.date || data.trip.start,
    note: `${result.distance} km, ${result.consumption} l/100 km, ${result.price} zł/l`,
    hasDeposit: false,
    depositAmount: 0,
    participants: data.users.map(user => user.id)
  };
  await runWrite('Wydatek paliwowy zaktualizowany', () => saveExpenseRecord(item, previous));
};

$$('.close-dialog').forEach(button => { button.onclick = () => button.closest('dialog').close(); });
$('#confirmCancel').onclick = () => $('#confirmDialog').close();
$('#confirmOk').onclick = async () => {
  const action = confirmAction;
  confirmAction = null;
  $('#confirmDialog').close();
  if (action) await action();
};
$('#userBtn').onclick = event => { event.stopPropagation(); $('#userDropdown').classList.toggle('hidden'); };
document.addEventListener('click', () => $('#userDropdown').classList.add('hidden'));
$('#menuBtn').onclick = () => {
  if (window.matchMedia('(max-width: 800px)').matches) {
    if (document.body.dataset.currentView !== 'dashboard') navigate('dashboard');
    return;
  }
  $('#sidebar').classList.toggle('open');
};
$('#mobileMoreBtn').onclick = () => $('#sidebar').classList.add('open');
$('#sidebarScrim').onclick = () => $('#sidebar').classList.remove('open');
$('#retrySync').onclick = async () => {
  try {
    await loadNormalizedData();
    setSyncState('online');
  } catch (error) {
    setSyncState('error', friendlyDbError(error));
  }
};

setSyncState('loading', 'Oczekiwanie na bezpieczne logowanie');
