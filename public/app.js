const authCard = document.getElementById('authCard');
const appContent = document.getElementById('appContent');
const authMessage = document.getElementById('authMessage');
const welcomeText = document.getElementById('welcomeText');
const appHeaderActions = document.getElementById('appHeaderActions');
const logoutBtn = document.getElementById('logoutBtn');
const loginForm = document.getElementById('loginForm');
const registerForm = document.getElementById('registerForm');
const subscriptionForm = document.getElementById('subscriptionForm');
const subscriptionList = document.getElementById('subscriptionList');
const templateOutput = document.getElementById('templateOutput');
const searchInput = document.getElementById('searchInput');
const statusFilter = document.getElementById('statusFilter');
const runReminderBtn = document.getElementById('runReminderBtn');
const cardTemplate = document.getElementById('subscriptionCardTemplate');

const statCount = document.getElementById('statCount');
const statMonthly = document.getElementById('statMonthly');
const statYearly = document.getElementById('statYearly');
const statCritical = document.getElementById('statCritical');

const TOKEN_KEY = 'abostop_token_v2';
let token = localStorage.getItem(TOKEN_KEY) || '';
let currentUser = null;
let subscriptions = [];

function euro(value) {
  return new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(value || 0);
}

function showMessage(message, isError = false) {
  authMessage.textContent = message;
  authMessage.classList.toggle('error', isError);
}

async function api(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(path, { ...options, headers });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Fehler');
  return data;
}

function setLoggedInState(isLoggedIn) {
  authCard.classList.toggle('hidden', isLoggedIn);
  appContent.classList.toggle('hidden', !isLoggedIn);
  appHeaderActions.classList.toggle('hidden', !isLoggedIn);
}

function monthlyEquivalent(item) {
  switch (item.billing_cycle) {
    case 'jährlich': return Number(item.price || 0) / 12;
    case 'vierteljährlich': return Number(item.price || 0) / 3;
    default: return Number(item.price || 0);
  }
}

function renderStats() {
  const monthly = subscriptions.reduce((sum, item) => sum + monthlyEquivalent(item), 0);
  statCount.textContent = subscriptions.length;
  statMonthly.textContent = euro(monthly);
  statYearly.textContent = euro(monthly * 12);
  statCritical.textContent = subscriptions.filter((item) => item.status === 'kritisch').length;
}

function renderSubscriptions() {
  const search = searchInput.value.trim().toLowerCase();
  const filter = statusFilter.value;
  const filtered = subscriptions.filter((item) => {
    const matchesSearch = item.name.toLowerCase().includes(search);
    const matchesStatus = filter === 'alle' ? true : item.status === filter;
    return matchesSearch && matchesStatus;
  });

  subscriptionList.innerHTML = '';
  if (!filtered.length) {
    subscriptionList.innerHTML = '<div class="empty-state">Noch keine passenden Abos vorhanden.</div>';
    renderStats();
    return;
  }

  filtered.forEach((item) => {
    const node = cardTemplate.content.firstElementChild.cloneNode(true);
    node.querySelector('.sub-name').textContent = item.name;
    const badge = node.querySelector('.badge');
    badge.textContent = item.status;
    badge.classList.add(item.status);
    node.querySelector('.meta').textContent = `${item.category} · ${euro(item.price)} ${item.billing_cycle} · Verlängerung ${item.renewal_date}`;
    node.querySelector('.deadline').textContent = `Erinnerung: ${item.reminderDate} · Kündigungsfrist ${item.notice_days} Tage`;
    node.querySelector('[data-action="template"]').addEventListener('click', async () => {
      const data = await api(`/api/subscriptions/${item.id}/template`);
      templateOutput.value = data.template;
    });
    node.querySelector('[data-action="delete"]').addEventListener('click', async () => {
      await api(`/api/subscriptions/${item.id}`, { method: 'DELETE' });
      await loadSubscriptions();
    });
    subscriptionList.appendChild(node);
  });

  renderStats();
}

async function loadSubscriptions() {
  const data = await api('/api/subscriptions');
  subscriptions = data.items;
  renderSubscriptions();
}

async function bootstrap() {
  if (!token) {
    setLoggedInState(false);
    return;
  }

  try {
    const data = await api('/api/auth/me');
    currentUser = data.user;
    welcomeText.textContent = `Hallo ${currentUser.name}`;
    setLoggedInState(true);
    await loadSubscriptions();
  } catch (error) {
    localStorage.removeItem(TOKEN_KEY);
    token = '';
    setLoggedInState(false);
  }
}

document.querySelectorAll('.tab').forEach((button) => {
  button.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((btn) => btn.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach((panel) => panel.classList.remove('active'));
    button.classList.add('active');
    document.getElementById(`${button.dataset.tab}Form`).classList.add('active');
    showMessage('');
  });
});

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const formData = Object.fromEntries(new FormData(loginForm).entries());
  try {
    const data = await api('/api/auth/login', { method: 'POST', body: JSON.stringify(formData) });
    token = data.token;
    localStorage.setItem(TOKEN_KEY, token);
    showMessage('Login erfolgreich.');
    loginForm.reset();
    await bootstrap();
  } catch (error) {
    showMessage(error.message, true);
  }
});

registerForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const formData = Object.fromEntries(new FormData(registerForm).entries());
  try {
    const data = await api('/api/auth/register', { method: 'POST', body: JSON.stringify(formData) });
    token = data.token;
    localStorage.setItem(TOKEN_KEY, token);
    showMessage('Registrierung erfolgreich.');
    registerForm.reset();
    await bootstrap();
  } catch (error) {
    showMessage(error.message, true);
  }
});

subscriptionForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const formData = Object.fromEntries(new FormData(subscriptionForm).entries());
  try {
    await api('/api/subscriptions', { method: 'POST', body: JSON.stringify(formData) });
    subscriptionForm.reset();
    subscriptionForm.notice_days.value = 14;
    await loadSubscriptions();
  } catch (error) {
    alert(error.message);
  }
});

logoutBtn.addEventListener('click', () => {
  token = '';
  currentUser = null;
  subscriptions = [];
  localStorage.removeItem(TOKEN_KEY);
  templateOutput.value = '';
  setLoggedInState(false);
});

searchInput.addEventListener('input', renderSubscriptions);
statusFilter.addEventListener('change', renderSubscriptions);
runReminderBtn.addEventListener('click', async () => {
  try {
    const data = await api('/api/reminders/run-now', { method: 'POST' });
    alert(data.message);
  } catch (error) {
    alert(error.message);
  }
});

bootstrap();
