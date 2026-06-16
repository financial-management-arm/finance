'use strict';

// ================================================================
// State
// ================================================================
const state = {
  obligations: [],
  payments: {},   // "id__YYYY-MM" -> true/false
  paymentMeta: {},
  income: [],
  loanHistory: [],
  month: todayMonth(),
  tab: 'schedule',
  filter: 'all',
  statusFilter: 'unpaid',
  search: '',
  scheduleSort: 'due-asc',
  loanSort: 'debt-desc',
  incomeSort: 'date-desc',
  reportMonths: 6,
};

let charts = {};

// ================================================================
// Utilities
// ================================================================
function todayMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2,'0')}`;
}

function monthLabel(m) {
  const [y, mo] = m.split('-');
  return new Date(+y, +mo - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

function shiftMonth(m, delta) {
  const [y, mo] = m.split('-').map(Number);
  const d = new Date(y, mo - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2,'0')}`;
}

function amd(n) {
  return Number(n || 0).toLocaleString('hy-AM') + ' ֏';
}

function pkey(id, month) { return `${id}__${month}`; }

function paymentStatus(id, month = state.month) {
  const key = pkey(id, month);
  const meta = state.paymentMeta[key] || {};
  if (meta.status) return String(meta.status).toLowerCase();
  return state.payments[key] ? 'paid' : 'unpaid';
}

function isPaid(id, month = state.month) { return paymentStatus(id, month) === 'paid'; }

function isPaymentResolved(id, month = state.month) {
  return ['paid', 'not_done', 'no_need'].includes(paymentStatus(id, month));
}

function activeObs() {
  return state.obligations.filter(o => o.active === true || String(o.active).toUpperCase() === 'TRUE');
}

function filteredObs() {
  let rows = dueThisMonth();
  if (state.filter !== 'all') rows = rows.filter(o => o.payer === state.filter);
  if (state.statusFilter === 'paid') rows = rows.filter(o => isPaid(o.id));
  if (state.statusFilter === 'unpaid') rows = rows.filter(o => !isPaymentResolved(o.id));
  if (state.search) {
    const needle = state.search.toLocaleLowerCase();
    rows = rows.filter(o =>
      [o.payer, o.bank, o.category, o.contractNumber]
        .some(value => String(value || '').toLocaleLowerCase().includes(needle))
    );
  }
  return rows;
}

function totalAmt(obs) {
  return obs.reduce((s, o) => s + Number(o.amount), 0);
}

function payerClass(p) {
  return p ? 'payer-accent' : '';
}

const PALETTE = ['#2563eb','#db2777','#16a34a','#d97706','#7c3aed','#0891b2','#9a3412','#475569'];

function payers() {
  return [...new Set(activeObs().map(o => String(o.payer || '').trim()).filter(Boolean))];
}

function payerColor(payer) {
  const index = payers().indexOf(payer);
  return PALETTE[(index < 0 ? 0 : index) % PALETTE.length];
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[ch]));
}

function currentMonthDay() {
  return state.month === todayMonth() ? new Date().getDate() : 0;
}

function loanSnapshot(id, month = state.month) {
  return state.loanHistory.find(row =>
    String(row.obligationId) === String(id) && String(row.month) === month
  );
}

function loanBalance(loan, month = state.month) {
  const snapshot = loanSnapshot(loan.id, month);
  const value = snapshot ? snapshot.currentBalance : loan.currentBalance;
  return value === '' || value === null || value === undefined ? null : Number(value);
}

function balanceSourceMonth(loan, month = state.month) {
  const snapshot = loanSnapshot(loan.id, month);
  return String((snapshot && snapshot.balanceSourceMonth) || loan.balanceUpdatedMonth || '');
}

function isLoanRecord(obligation) {
  return String(obligation.category).toLowerCase() === 'loan' ||
    Number(obligation.loanTotal) > 0 || Number(obligation.currentBalance) > 0;
}

function activeLoans() {
  return activeObs().filter(isLoanRecord);
}

function isObligationDueThisMonth(ob, month) {
  month = month || state.month;
  const freq = String(ob.frequency || 'monthly').toLowerCase().trim();
  if (!freq || freq === 'monthly') return true;
  if (freq === 'one_time') {
    const dueMon = String(ob.startDate || '').slice(0, 7);
    return dueMon === month;
  }
  if (freq === 'quarterly') {
    const start = String(ob.startDate || '').slice(0, 7);
    if (!start) return true;
    const [sy, sm] = start.split('-').map(Number);
    const [cy, cm] = month.split('-').map(Number);
    const diff = (cy * 12 + cm) - (sy * 12 + sm);
    return diff >= 0 && diff % 3 === 0;
  }
  return true;
}

function dueThisMonth() {
  return activeObs().filter(o => isObligationDueThisMonth(o));
}

// ================================================================
// API
// ================================================================
async function callApi(params, { retries = 1, timeout = 30000 } = {}) {
  const url = new URL(API_URL);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, String(v)));

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const res = await fetch(url.toString(), { signal: controller.signal });
      const json = await res.json();
      if (json.error) throw new Error(json.error);
      return json;
    } catch (err) {
      clearTimeout(timer);
      if (attempt < retries) {
        await new Promise(r => setTimeout(r, 1500));
        continue;
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}

async function fetchAll() {
  showLoading(true);
  try {
    const data = await callApi({ action: 'all', month: state.month });
    state.obligations = data.obligations || [];
    state.payments = {};
    state.paymentMeta = {};
    (data.payments || []).forEach(p => {
      state.payments[p.key] = (p.paid === true || String(p.paid).toUpperCase() === 'TRUE');
      state.paymentMeta[p.key] = p;
    });
    state.income = data.income || [];
    state.loanHistory = data.loanHistory || [];
    renderPayerFilters();
    render();
  } catch (err) {
    showError('Could not load data: ' + err.message);
  } finally {
    showLoading(false);
  }
}

async function togglePayment(id) {
  const next = isPaid(id) ? 'unpaid' : 'paid';
  return setPaymentStatus(id, next);
}

async function setPaymentStatus(id, status) {
  const key = pkey(id, state.month);
  const previousPaid = !!state.payments[key];
  const previousMeta = state.paymentMeta[key] ? { ...state.paymentMeta[key] } : null;
  const paid = status === 'paid';

  state.payments[key] = paid;
  state.paymentMeta[key] = {
    key, paid, status,
    completedAt: paid ? new Date().toISOString() : '',
    updatedAt: new Date().toISOString()
  };
  patchPaymentEl(id);

  try {
    const result = await callApi({ action: 'setPayment', key, paid, status, month: state.month });
    state.paymentMeta[key] = {
      key, paid,
      status: result.status || status,
      completedAt: result.completedAt || '',
      updatedAt: new Date().toISOString()
    };
    if (status === 'paid') showToast('Payment completed.');
    if (status === 'not_done') showToast('Marked as did not pay.');
    if (status === 'no_need') showToast('Marked no need.');
  } catch (err) {
    state.payments[key] = previousPaid;
    if (previousMeta) state.paymentMeta[key] = previousMeta;
    else delete state.paymentMeta[key];
    patchPaymentEl(id);
    showError('Could not save — will retry automatically.');
  }
}

function patchPaymentEl(id) {
  const el = document.querySelector(`[data-payment-id="${CSS.escape(id)}"]`);
  if (!el) { renderCurrentTab(); return; }

  const paid = isPaid(id);
  const status = paymentStatus(id);

  // Paid / status classes
  el.classList.toggle('is-paid', paid);
  el.className = el.className.replace(/\bis-(?:paid|unpaid|not-done|no-need)\b/g, '').trim();
  el.classList.add(`is-${status.replace('_', '-')}`);

  // Urgency — restore when un-paying, clear when paying
  el.classList.remove('is-overdue', 'is-due-soon');
  if (!paid) {
    const o = activeObs().find(ob => String(ob.id) === String(id));
    if (o) {
      const today = currentMonthDay();
      const dueDay = Number(o.dueDay);
      if (today && dueDay > 0) {
        if (dueDay < today) el.classList.add('is-overdue');
        else if (dueDay <= today + 3) el.classList.add('is-due-soon');
      }
    }
  }

  // Done/Paid button (card view)
  const doneBtn = el.querySelector('.payment-done');
  if (doneBtn) {
    doneBtn.textContent = paid ? 'Paid' : 'Done';
    doneBtn.classList.toggle('button-primary', !paid);
    doneBtn.classList.toggle('button-secondary', paid);
  }

  // Check button (table view)
  const checkBtn = el.querySelector('.check-btn');
  if (checkBtn) {
    checkBtn.classList.toggle('is-checked', paid);
    checkBtn.setAttribute('aria-label', paid ? 'Mark payment unpaid' : 'Mark payment paid');
    checkBtn.title = paid ? 'Mark unpaid' : 'Mark paid';
  }

  // Status badge
  const badge = el.querySelector('.payment-status-badge');
  const newBadge = paymentStatusBadge(status);
  if (badge) badge.outerHTML = newBadge || '';
  else if (newBadge) {
    const anchor = el.querySelector('.payment-card-head, .payment-basic-payer')?.closest('div');
    if (anchor) anchor.insertAdjacentHTML('afterend', newBadge);
  }

  // Footer counts
  const obs = sortPayments(filteredObs());
  const all = activeObs();
  const allResolved = all.filter(o => isPaymentResolved(o.id));
  const visResolved = obs.filter(o => isPaymentResolved(o.id));
  const t = q('sched-total'), c = q('sched-count'), g = q('sched-grand');
  if (t) t.textContent = amd(totalAmt(obs));
  if (c) c.textContent = `${visResolved.length}/${obs.length}`;
  if (g) g.textContent = `Total: ${amd(totalAmt(all))} · ${allResolved.length}/${all.length} resolved`;
}

async function saveBalance(id, balance) {
  try {
    await callApi({ action: 'updateBalance', id, balance, month: state.month });
    const ob = state.obligations.find(o => o.id === id);
    if (ob) {
      ob.currentBalance = balance;
      ob.balanceUpdatedMonth = state.month;
    }
    const snap = state.loanHistory.find(s =>
      String(s.obligationId) === String(id) && String(s.month) === state.month
    );
    if (snap) { snap.currentBalance = balance; snap.balanceSourceMonth = state.month; }
    renderCurrentTab();
    showToast('Balance saved.');
  } catch (err) {
    alert('Save failed: ' + err.message);
  }
}

function openAddObligationModal() {
  const payerList = [...new Set(activeObs().map(o => String(o.payer || '').trim()).filter(Boolean))];
  q('add-ob-payer').setAttribute('list', 'add-ob-payer-list');
  q('add-ob-payer-list').innerHTML = payerList.map(p => `<option value="${escapeHtml(p)}">`).join('');
  q('add-ob-startdate-row').classList.add('hidden');
  q('add-ob-startdate').required = false;
  q('add-ob-modal').classList.remove('hidden');
  q('add-ob-bank').focus();
}

function closeAddObligationModal() {
  q('add-ob-modal').classList.add('hidden');
  q('add-ob-form').reset();
}

function onAddObFreqChange(sel) {
  const needs = sel.value !== 'monthly';
  q('add-ob-startdate-row').classList.toggle('hidden', !needs);
  q('add-ob-startdate').required = needs;
}

async function submitAddObligation(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const v = id => form.elements[id].value;
  const btn = form.querySelector('[type="submit"]');
  btn.disabled = true;
  btn.textContent = 'Adding...';
  try {
    await callApi({
      action: 'addObligation',
      payer: v('payer').trim(),
      bank: v('bank').trim(),
      category: v('category'),
      amount: Number(v('amount')) || 0,
      dueDay: Number(v('dueDay')) || 0,
      startDate: v('startDate') || '',
      frequency: v('frequency')
    });
    await refreshData(false);
    renderCurrentTab();
    closeAddObligationModal();
    showToast('Obligation added.');
  } catch (err) {
    showError('Could not add obligation: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Add Obligation';
  }
}

async function updateLoan(id, changes, sourceButton = null) {
  const button = sourceButton || q('loan-edit-save');
  button.disabled = true;
  button.textContent = 'Saving...';
  try {
    const result = await callApi({ action: 'updateLoan', id, month: state.month, ...changes });
    const loan = state.obligations.find(o => String(o.id) === String(id));
    if (loan) Object.assign(loan, changes, {
      balanceUpdatedMonth: result.balanceUpdatedMonth || loan.balanceUpdatedMonth
    });
    await refreshData(false);
    renderCurrentTab();
    showToast('Loan updated.');
  } catch (err) {
    showError('Could not update loan: ' + err.message);
  } finally {
    button.disabled = false;
    button.textContent = 'Save changes';
  }
}

async function completeLoan(id, button) {
  if (!confirm('Mark this loan complete? It will not roll into the next month.')) return;
  button.disabled = true;
  button.textContent = 'Completing...';
  try {
    await callApi({ action: 'completeLoan', id, month: state.month });
    const loan = state.obligations.find(o => String(o.id) === String(id));
    if (loan) {
      loan.active = false;
      loan.currentBalance = 0;
      loan.completedAt = new Date().toISOString();
    }
    renderCurrentTab();
    showToast('Loan completed. It will not transfer to next month.');
  } catch (err) {
    showError('Could not complete loan: ' + err.message);
    button.disabled = false;
    button.textContent = 'Complete';
  }
}

async function refreshData(showSkeleton = true) {
  if (showSkeleton) showLoading(true);
  try {
    const data = await callApi({ action: 'all', month: state.month });
    state.obligations = data.obligations || [];
    state.payments = {};
    state.paymentMeta = {};
    (data.payments || []).forEach(p => {
      state.payments[p.key] = p.paid === true || String(p.paid).toUpperCase() === 'TRUE';
      state.paymentMeta[p.key] = p;
    });
    state.income = data.income || [];
    state.loanHistory = data.loanHistory || [];
    renderPayerFilters();
    render();
  } finally {
    if (showSkeleton) showLoading(false);
  }
}

async function addIncome(entry) {
  try {
    const res = await callApi({ action: 'addIncome', ...entry });
    state.income.push({ id: res.id, ...entry });
    renderIncome();
  } catch (err) {
    alert('Add failed: ' + err.message);
  }
}

// ================================================================
// UI helpers
// ================================================================
function showLoading(on) {
  document.body.classList.toggle('is-loading', on);
}

function showError(msg) {
  const el = document.getElementById('error-toast');
  el.textContent = msg;
  el.classList.remove('hidden', 'is-success');
  el.classList.add('is-error');
  setTimeout(() => el.classList.add('hidden'), 5000);
}

function showToast(msg) {
  const el = q('error-toast');
  el.textContent = msg;
  el.classList.remove('hidden', 'is-error');
  el.classList.add('is-success');
  setTimeout(() => el.classList.add('hidden'), 2200);
}

function switchTab(tab) {
  state.tab = tab;
  document.querySelectorAll('.sidebar-nav a').forEach(a =>
    a.classList.toggle('active', a.dataset.tab === tab)
  );
  document.querySelectorAll('.page').forEach(p =>
    p.classList.toggle('active', p.id === 'page-' + tab)
  );
  renderCurrentTab();
}

function renderCurrentTab() {
  updateMonthLabels();
  switch (state.tab) {
    case 'dashboard': renderDashboard(); break;
    case 'schedule':  renderSchedule();  break;
    case 'loans':     renderLoans();     break;
    case 'income':    renderIncome();    break;
    case 'reports':   renderReports();   break;
  }
}

function render() { updateMonthLabels(); renderCurrentTab(); }

function updateMonthLabels() {
  document.querySelectorAll('.month-label').forEach(el => {
    el.textContent = monthLabel(state.month);
  });
}

function q(id) { return document.getElementById(id); }

// ================================================================
// Dashboard
// ================================================================
function renderDashboard() {
  const all  = dueThisMonth();
  const paid = all.filter(o => isPaid(o.id));
  const resolved = all.filter(o => isPaymentResolved(o.id));
  const paidAmt  = totalAmt(paid);
  const totalA   = totalAmt(all);
  const unpaid = all.filter(o => !isPaymentResolved(o.id));
  const unresolvedA = totalAmt(unpaid);
  const pct      = totalA ? Math.round(totalAmt(resolved) / totalA * 100) : 0;
  const today = currentMonthDay();
  const overdue = today ? unpaid.filter(o => Number(o.dueDay) > 0 && Number(o.dueDay) < today) : [];
  const dueSoon = today ? unpaid.filter(o => Number(o.dueDay) >= today && Number(o.dueDay) <= today + 3) : [];

  const monthIncome = state.income
    .filter(i => String(i.date).startsWith(state.month))
    .reduce((s, i) => s + Number(i.amount), 0);

  q('stat-total').textContent  = amd(totalA);
  q('stat-unpaid').textContent = amd(unresolvedA);
  q('stat-income').textContent = amd(monthIncome);
  const net = monthIncome - unresolvedA;
  q('stat-net').textContent = amd(net);
  q('stat-net-card').classList.toggle('net-positive', net >= 0);
  q('stat-net-card').classList.toggle('net-negative', net < 0);
  q('stat-sub').textContent = `${paid.length} paid · ${unpaid.length} still open`;
  q('prog-label').textContent = `${pct}%`;
  const circumference = 2 * Math.PI * 49;
  q('progress-ring-value').style.strokeDashoffset = String(circumference * (1 - pct / 100));

  const loans = activeLoans();
  const knownBalances = loans
    .map(loan => loanBalance(loan))
    .filter(balance => balance !== null && Number.isFinite(balance));
  const totalDebt = knownBalances.reduce((sum, balance) => sum + balance, 0);
  const staleLoans = loans.filter(loan => {
    const balance = loanBalance(loan);
    return balance !== null && balanceSourceMonth(loan) !== state.month;
  });
  q('stat-debt').textContent = amd(totalDebt);
  q('debt-freshness').textContent = staleLoans.length
    ? `${staleLoans.length} balances carried forward from a previous month`
    : 'All recorded balances are updated for this month';
  q('debt-freshness').classList.toggle('is-stale', staleLoans.length > 0);

  renderUrgentStrip(overdue, dueSoon);
  renderPayerBars();
}

function renderUrgentStrip(overdue, dueSoon) {
  const urgent = [
    ...overdue.map(o => ({ ...o, urgency: 'overdue' })),
    ...dueSoon.map(o => ({ ...o, urgency: 'soon' }))
  ].sort((a, b) => Number(a.dueDay) - Number(b.dueDay));

  q('urgent-strip').innerHTML = urgent.length ? urgent.map(o => `
    <button class="urgent-card ${o.urgency === 'overdue' ? 'is-overdue' : ''}"
            type="button" data-jump-payment="${escapeHtml(o.id)}">
      <span>
        <span class="urgent-status">${o.urgency === 'overdue' ? `Overdue · day ${o.dueDay}` : `Due soon · day ${o.dueDay}`}</span>
        <span class="urgent-bank">${escapeHtml(o.bank)}</span>
        <span class="urgent-payer">${escapeHtml(o.payer)}</span>
      </span>
      <strong class="urgent-amount">${amd(o.amount)}</strong>
    </button>
  `).join('') : `
    <div class="urgent-empty">
      <span aria-hidden="true">✓</span>
      <strong>${currentMonthDay() ? 'Nothing urgent today' : 'No current-day alerts for this month'}</strong>
    </div>
  `;
}

function renderPayerBars() {
  const all = activeLoans();
  const payerDebt = payers().map(p => ({
    payer: p,
    loans: all.filter(o => o.payer === p)
  })).filter(group => group.loans.length).map(group => ({
    ...group,
    debt: group.loans.reduce((sum, loan) => sum + Number(loanBalance(loan) || 0), 0)
  })).sort((a, b) => b.debt - a.debt);

  const html = payerDebt.map(group => {
    const p = group.payer;
    const obs = group.loans;
    const original = obs.reduce((sum, o) => sum + Number(o.loanTotal || 0), 0);
    const debt = group.debt;
    const pct = original ? Math.round((1 - debt / original) * 100) : 0;
    return `<div class="payer-row" style="--payer-color:${payerColor(p)}">
      <div class="payer-row-head">
        <span class="payer-name" style="color:var(--payer-color)">${escapeHtml(p)}</span>
        <span class="payer-amount">${amd(debt)} remaining · ${pct}% repaid</span>
      </div>
      <div class="payer-track">
        <div class="payer-fill" style="width:${pct}%;background:var(--payer-color)"></div>
      </div>
    </div>`;
  }).join('');
  q('payer-bars').innerHTML = html;
}

function renderDashCategoryChart() {
  const canvas = q('chart-cat');
  if (!canvas) return;
  const all   = activeObs();
  const cats  = ['loan','business','personal'];
  const data  = cats.map(c => totalAmt(all.filter(o => o.category === c)));
  const cols  = ['#2563eb','#d97706','#7c3aed'];
  if (charts.cat) charts.cat.destroy();
  charts.cat = new Chart(canvas, {
    type: 'doughnut',
    data: {
      labels: ['Loans','Business','Personal'],
      datasets: [{ data, backgroundColor: cols, borderWidth: 2, borderColor: '#fff' }]
    },
    options: {
      plugins: {
        legend: { position: 'bottom', labels: { font: { size: 11 } } },
        tooltip: { callbacks: { label: ctx => ' ' + amd(ctx.raw) } }
      },
      responsive: true, maintainAspectRatio: true,
    }
  });
}

// ================================================================
// Schedule
// ================================================================
function renderSchedule() {
  const obs = sortPayments(filteredObs());
  const board = q('payments-board');
  if (board) {
    board.innerHTML = obs.length ? obs.map(paymentCard).join('') : `
      <div class="empty-state payment-empty">
        ${state.statusFilter === 'unpaid' && !state.search
          ? `All payments done for ${monthLabel(state.month)}`
          : 'No payments match these filters.'}
      </div>`;

    const all = dueThisMonth();
    const allResolved = all.filter(o => isPaymentResolved(o.id));
    const visResolved = obs.filter(o => isPaymentResolved(o.id));
    q('sched-total').textContent = amd(totalAmt(obs));
    q('sched-count').textContent = `${visResolved.length}/${obs.length}`;
    q('sched-grand').textContent = `Total: ${amd(totalAmt(all))} · ${allResolved.length}/${all.length} resolved`;
    return;
  }
  const tbody = q('sched-tbody');

  const today = currentMonthDay();
  tbody.innerHTML = obs.length ? obs.map((o, index) => {
    const paid = isPaid(o.id);
    const dueDay = Number(o.dueDay);
    const urgency = !paid && today && dueDay > 0
      ? (dueDay < today ? 'is-overdue' : dueDay <= today + 3 ? 'is-due-soon' : '')
      : '';
    const revealDelay = Math.min(index * 30, 200);
    return `<tr class="payment-row row-reveal ${paid ? 'is-paid' : ''} ${urgency}"
                data-payment-id="${escapeHtml(o.id)}"
                style="--payer-color:${payerColor(o.payer)};animation-delay:${revealDelay}ms">
      <td class="fw7 payment-payer" style="color:var(--payer-color)">${escapeHtml(o.payer)}</td>
      <td>${escapeHtml(o.bank)}</td>
      <td><span class="badge ${escapeHtml(o.category)}">${escapeHtml(o.category)}</span></td>
      <td class="tr amt fw7">${Number(o.amount) > 0 ? amd(o.amount) : '—'}</td>
      <td class="tc muted">${Number(o.dueDay) > 0 ? o.dueDay : '—'}</td>
      <td class="tc">
        <button class="check-btn ${paid ? 'is-checked' : ''}"
                onclick="togglePayment('${escapeHtml(o.id)}')"
                aria-label="${paid ? 'Mark payment unpaid' : 'Mark payment paid'}"
                title="${paid ? 'Mark unpaid' : 'Mark paid'}">
        </button>
        ${paid && state.paymentMeta[pkey(o.id, state.month)]?.completedAt
          ? `<time class="payment-time">${formatTimestamp(state.paymentMeta[pkey(o.id, state.month)].completedAt)}</time>`
          : ''}
      </td>
    </tr>`;
  }).join('') : `<tr><td colspan="6" class="empty-state">
    ${state.statusFilter === 'unpaid' && !state.search
      ? `All payments done for ${monthLabel(state.month)} ✓`
      : 'No payments match these filters.'}
  </td></tr>`;

  const all     = activeObs();
  const allPaid = all.filter(o => isPaid(o.id));
  const visPaid = obs.filter(o => isPaid(o.id));

  q('sched-total').textContent  = amd(totalAmt(obs));
  q('sched-count').textContent  = `${visPaid.length}/${obs.length}`;
  q('sched-grand').textContent  = `Total: ${amd(totalAmt(all))} — ${allPaid.length}/${all.length} paid`;
}

function paymentCard(o, index) {
  return isLoanRecord(o) ? loanPaymentCard(o, index) : standardPaymentCard(o, index);
}

function loanPaymentCard(o, index) {
  const paid = isPaid(o.id);
  const status = paymentStatus(o.id);
  const balRaw = loanBalance(o);
  const balKnown = balRaw !== '' && balRaw !== null && balRaw !== undefined && balRaw !== false;
  const bal = balKnown ? Number(balRaw) : null;
  const total = Number(o.loanTotal) || 0;
  const pctOff = total && bal !== null ? Math.round((1 - bal / total) * 100) : 0;
  const pct = Math.max(0, Math.min(100, pctOff));
  const contracts = contractParts(o.contractNumber);
  const completedAt = state.paymentMeta[pkey(o.id, state.month)]?.completedAt;
  const sourceMonth = balanceSourceMonth(o);
  const staleBalance = balKnown && sourceMonth !== state.month;
  const revealDelay = Math.min((index || 0) * 30, 200);

  return `<article class="payment-loan-card row-reveal ${paid ? 'is-paid' : ''} is-${status.replace('_', '-')} ${staleBalance ? 'is-stale' : ''}"
                  data-payment-id="${escapeHtml(o.id)}"
                  style="--payer-color:${payerColor(o.payer)};animation-delay:${revealDelay}ms">
    <div class="payment-card-head">
      <div class="payment-card-title">
        <h2>${escapeHtml(o.bank || 'Loan')}</h2>
        <div>${escapeHtml(o.payer || '')}</div>
      </div>
      <div class="payment-card-amount">
        <strong>${Number(o.amount) > 0 ? amd(o.amount) : '—'}</strong>
        <span>/month${Number(o.dueDay) > 0 ? ` · due ${Number(o.dueDay)}` : ''}</span>
      </div>
      <div class="payment-card-actions">
        <button class="button button-ghost loan-edit-toggle" type="button"
                onclick="openLoanEditor('${escapeHtml(o.id)}')">Edit</button>
        <button class="button ${paid ? 'button-secondary' : 'button-primary'} payment-done"
                type="button" onclick="togglePayment('${escapeHtml(o.id)}')">${paid ? 'Paid' : 'Done'}</button>
      </div>
    </div>
    ${paymentStatusBadge(status)}
    ${contracts.length ? `
      <div class="payment-contract-row">
        <span class="contract-label">Contract</span>
        ${contracts.map(part => copyChip(part)).join('')}
      </div>` : ''}
    <div class="payment-balance-row">
      <label for="pay-bal-${escapeHtml(o.id)}">Balance ֏</label>
      <input class="payment-balance-input" id="pay-bal-${escapeHtml(o.id)}"
             type="number" min="0" value="${balKnown ? bal : ''}"
             placeholder="Enter current balance">
      <button class="button button-primary payment-save-balance" type="button"
              onclick="savePaymentBalanceFromInput('${escapeHtml(o.id)}')">Save</button>
    </div>
    <div class="payment-progress">
      <div class="payment-progress-bar">
        <div class="payment-progress-fill" style="width:${pct}%"></div>
      </div>
      <div class="payment-progress-labels">
        <span>${balKnown && total ? `${pct}% paid off` : 'Balance not verified'}</span>
        <span>Total: ${total ? amd(total) : '—'}</span>
      </div>
      ${paid && completedAt ? `<time class="payment-card-time">Paid ${formatTimestamp(completedAt)}</time>` : ''}
      ${staleBalance ? `<div class="balance-stale">Approximate balance · last updated ${sourceMonth ? monthLabel(sourceMonth) : 'before this month'}</div>` : ''}
    </div>
    <div class="payment-status-actions">
      <button class="button button-secondary payment-not-done" type="button"
              onclick="setPaymentStatus('${escapeHtml(o.id)}', 'not_done')">Did not done</button>
      <button class="button button-ghost payment-no-need" type="button"
              onclick="setPaymentStatus('${escapeHtml(o.id)}', 'no_need')">No Need</button>
    </div>
  </article>`;
}

function standardPaymentCard(o, index) {
  const paid = isPaid(o.id);
  const status = paymentStatus(o.id);
  const completedAt = state.paymentMeta[pkey(o.id, state.month)]?.completedAt;
  const dueDay = Number(o.dueDay);
  const today = currentMonthDay();
  const urgency = !paid && today && dueDay > 0
    ? (dueDay < today ? 'is-overdue' : dueDay <= today + 3 ? 'is-due-soon' : '')
    : '';
  const revealDelay = Math.min((index || 0) * 30, 200);

  return `<article class="payment-basic-card row-reveal ${paid ? 'is-paid' : ''} is-${status.replace('_', '-')} ${urgency}"
                  data-payment-id="${escapeHtml(o.id)}"
                  style="--payer-color:${payerColor(o.payer)};animation-delay:${revealDelay}ms">
    <div>
      <div class="payment-basic-payer" style="color:var(--payer-color)">${escapeHtml(o.payer)}</div>
      <h2>${escapeHtml(o.bank)}</h2>
      <span class="badge ${escapeHtml(o.category)}">${escapeHtml(o.category)}</span>
      ${paymentStatusBadge(status)}
    </div>
    <div class="payment-basic-meta">
      <strong>${Number(o.amount) > 0 ? amd(o.amount) : '—'}</strong>
      <span>${Number(o.dueDay) > 0 ? `Due day ${o.dueDay}` : 'No due day'}</span>
      ${paid && completedAt ? `<time class="payment-card-time">Paid ${formatTimestamp(completedAt)}</time>` : ''}
    </div>
    <div class="payment-basic-actions">
      <button class="button ${paid ? 'button-secondary' : 'button-primary'} payment-done"
              type="button" onclick="togglePayment('${escapeHtml(o.id)}')">${paid ? 'Paid' : 'Done'}</button>
      <button class="button button-secondary payment-not-done" type="button"
              onclick="setPaymentStatus('${escapeHtml(o.id)}', 'not_done')">Did not done</button>
      <button class="button button-ghost payment-no-need" type="button"
              onclick="setPaymentStatus('${escapeHtml(o.id)}', 'no_need')">No Need</button>
    </div>
  </article>`;
}

function paymentStatusBadge(status) {
  const labels = {
    paid: 'Done',
    not_done: 'Did not done',
    no_need: 'No Need'
  };
  return labels[status]
    ? `<span class="payment-status-badge status-${status.replace('_', '-')}">${labels[status]}</span>`
    : '';
}

function sortPayments(rows) {
  const sorted = [...rows];
  const text = value => String(value || '').localeCompare;
  const sorters = {
    'due-asc': (a, b) => Number(a.dueDay || 99) - Number(b.dueDay || 99),
    'amount-desc': (a, b) => Number(b.amount) - Number(a.amount),
    'amount-asc': (a, b) => Number(a.amount) - Number(b.amount),
    'payer-asc': (a, b) => String(a.payer || '').localeCompare(String(b.payer || '')),
    'bank-asc': (a, b) => String(a.bank || '').localeCompare(String(b.bank || ''))
  };
  return sorted.sort(sorters[state.scheduleSort] || sorters['due-asc']);
}

function formatTimestamp(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('en-US', {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
  });
}

function jumpToPayment(id) {
  state.filter = 'all';
  state.search = '';
  state.statusFilter = 'unpaid';
  q('schedule-search').value = '';
  q('show-completed').checked = false;
  switchTab('schedule');
  requestAnimationFrame(() => {
    const row = document.querySelector(`[data-payment-id="${id}"]`);
    if (row) {
      row.scrollIntoView({ behavior: 'smooth', block: 'center' });
      row.classList.add('is-completing');
      setTimeout(() => row.classList.remove('is-completing'), 700);
    }
  });
}

// ================================================================
// Loans
// ================================================================
function renderLoans() {
  const loans = sortLoans(activeLoans());
  const nonLoans = activeObs().filter(o => !isLoanRecord(o));
  const totalDebt = loans.reduce((sum, loan) => sum + Number(loanBalance(loan) || 0), 0);

  const loansSection = loans.length ? `
    <div class="obligations-section-header">
      <span>Loans &amp; Balances</span>
      <strong>${amd(totalDebt)} total debt</strong>
    </div>
    <div class="loans-grid">${loans.map(loanCard).join('')}</div>
  ` : '';

  const nonLoansSection = nonLoans.length ? `
    <div class="obligations-section-header">
      <span>Other Obligations</span>
      <span>${nonLoans.length} item${nonLoans.length !== 1 ? 's' : ''}</span>
    </div>
    <div class="loans-grid">${nonLoans.map(nonLoanCard).join('')}</div>
  ` : '';

  q('loans-container').innerHTML = `
    <div class="loan-list-summary">
      <span>${loans.length} loan${loans.length !== 1 ? 's' : ''} · ${nonLoans.length} other obligation${nonLoans.length !== 1 ? 's' : ''}</span>
      <strong>${amd(totalDebt)} total debt</strong>
    </div>
    ${loansSection}
    ${nonLoansSection}
  `;
}

function sortLoans(rows) {
  const freshness = loan => balanceSourceMonth(loan) === state.month ? 1 : 0;
  const sorters = {
    'debt-desc': (a, b) => Number(loanBalance(b) || 0) - Number(loanBalance(a) || 0),
    'debt-asc': (a, b) => Number(loanBalance(a) || 0) - Number(loanBalance(b) || 0),
    'payer-asc': (a, b) => String(a.payer || '').localeCompare(String(b.payer || '')),
    'bank-asc': (a, b) => String(a.bank || '').localeCompare(String(b.bank || '')),
    'due-asc': (a, b) => Number(a.dueDay || 99) - Number(b.dueDay || 99),
    'freshness': (a, b) => freshness(a) - freshness(b)
  };
  return [...rows].sort(sorters[state.loanSort] || sorters['debt-desc']);
}

function loanCard(o) {
  const balRaw     = loanBalance(o);
  const balKnown   = balRaw !== '' && balRaw !== null && balRaw !== undefined && balRaw !== false;
  const bal        = balKnown ? Number(balRaw) : null;
  const tot        = Number(o.loanTotal) || 0;
  const pctOff     = (tot && bal !== null) ? Math.round((1 - bal / tot) * 100) : 0;
  const hasPayment = Number(o.amount) > 0;
  const contracts  = contractParts(o.contractNumber);
  const paidOff = balKnown && bal === 0;
  const arcLength = 157;
  const arcOffset = arcLength * (1 - Math.max(0, Math.min(100, pctOff)) / 100);
  const bankColor = bankColorFor(o.bank);
  const sourceMonth = balanceSourceMonth(o);
  const staleBalance = balKnown && sourceMonth !== state.month;

  return `<article class="loan-card ${!balKnown ? 'is-unverified' : ''} ${paidOff ? 'is-paid-off' : ''}"
                   style="--bank-color:${bankColor}">
    <div class="loan-card-top">
      <div class="loan-identity">
        <div class="bank-avatar">${escapeHtml(String(o.bank || '?').trim().charAt(0).toUpperCase())}</div>
        <div>
          <div class="loan-bank">${escapeHtml(o.bank)}</div>
          <div class="loan-meta">${escapeHtml(o.payer)}${o.startDate ? ` · Started ${fmtStartDate(o.startDate)}` : ''}</div>
        </div>
      </div>
      <div class="loan-card-actions">
        ${paidOff ? '<span class="paid-off-badge">Paid off</span>' : ''}
        <button class="button button-secondary loan-complete" type="button"
                onclick="completeLoan('${escapeHtml(o.id)}', this)">Complete</button>
        <button class="button button-ghost loan-edit-toggle" type="button"
                onclick="toggleInlineLoanEdit('${escapeHtml(o.id)}')">Edit</button>
      </div>
    </div>
    <div class="loan-financials">
      <div class="loan-arc-wrap">
        <svg class="loan-arc" viewBox="0 0 120 68" aria-hidden="true">
          <path class="loan-arc-track" d="M10 60 A50 50 0 0 1 110 60"></path>
          <path class="loan-arc-value" d="M10 60 A50 50 0 0 1 110 60"
                style="stroke-dashoffset:${arcOffset}"></path>
        </svg>
        <div class="loan-arc-copy"><strong>${balKnown && tot ? pctOff + '%' : '—'}</strong><span>paid</span></div>
      </div>
      <div class="loan-balance-copy">
        <div class="loan-balance-line">
          ${balKnown
            ? `<strong>${amd(bal)}</strong>${tot ? ` of ${amd(tot)} remaining` : ' owed'}`
            : '<strong>Balance unverified</strong>'}
        </div>
        <div class="loan-monthly-line">
          ${hasPayment ? `${amd(o.amount)} monthly · due day ${Number(o.dueDay) || '—'}` : 'No monthly payment recorded'}
        </div>
        ${staleBalance
          ? `<div class="balance-stale">Approximate balance · last updated ${sourceMonth ? monthLabel(sourceMonth) : 'before this month'}</div>`
          : '<div class="balance-current">Balance updated for this month</div>'}
      </div>
    </div>
    ${contracts.length ? `
      <div class="contract-row">
        <span class="contract-label">Contract</span>
        ${contracts.map(part => `
          <button class="copy-chip" type="button" onclick="copyContract('${escapeHtml(part)}', this)"
                  title="Copy ${escapeHtml(part)}">${escapeHtml(part)} <span>Copy</span></button>
        `).join('')}
      </div>` : ''}
    <form class="inline-loan-edit hidden" id="inline-edit-${escapeHtml(o.id)}"
          onsubmit="submitInlineLoanEdit(event, '${escapeHtml(o.id)}')">
      <label>Bank / Payee<input name="bank" value="${escapeHtml(o.bank)}" required></label>
      <label>Monthly payment<input name="amount" type="number" min="0" value="${Number(o.amount) || 0}" required></label>
      <label>Due day<input name="dueDay" type="number" min="0" max="31" value="${Number(o.dueDay) || 0}" required></label>
      <label>Category<select name="category"><option value="loan"${o.category==='loan'?' selected':''}>Loan</option><option value="business"${o.category==='business'?' selected':''}>Business</option><option value="personal"${o.category==='personal'?' selected':''}>Personal</option></select></label>
      <label>Frequency${freqSelect(o.frequency || 'monthly')}</label>
      <label>Current balance<input name="currentBalance" type="number" min="0" value="${balKnown ? bal : ''}"></label>
      <label>Original total<input name="loanTotal" type="number" min="0" value="${tot || ''}"></label>
      <label class="start-month-field">Start month<input name="startDate" type="month" value="${inputMonth(o.startDate)}"></label>
      <label class="inline-edit-wide">Contract number<input name="contractNumber" value="${escapeHtml(o.contractNumber || '')}"></label>
      <div class="inline-edit-actions">
        <button class="button button-ghost" type="button" onclick="toggleInlineLoanEdit('${escapeHtml(o.id)}')">Cancel</button>
        <button class="button button-primary" type="submit">Save changes</button>
      </div>
    </form>
  </article>`;
}

function copyChip(part) {
  const encoded = encodeURIComponent(part);
  return `<button class="copy-chip" type="button"
          onclick="copyContract(decodeURIComponent('${encoded}'), this)"
          title="Copy ${escapeHtml(part)}">${escapeHtml(part)} <span>Copy</span></button>`;
}

function freqLabel(freq) {
  return { monthly: '', quarterly: 'Every 3 mo.', one_time: 'One time' }[freq] || '';
}

function nonLoanCard(o) {
  const bankColor = bankColorFor(o.bank);
  const cat = String(o.category || 'other');
  const catDisplay = cat.charAt(0).toUpperCase() + cat.slice(1);
  const freq = o.frequency || 'monthly';
  const badge = freqLabel(freq) ? `<span class="freq-badge freq-${freq}">${freqLabel(freq)}</span>` : '';
  return `<article class="obligation-card" style="--bank-color:${bankColor}">
    <div class="loan-card-top">
      <div class="loan-identity">
        <div class="bank-avatar">${escapeHtml(String(o.bank || '?').trim().charAt(0).toUpperCase())}</div>
        <div>
          <div class="loan-bank">${escapeHtml(o.bank)}</div>
          <div class="loan-meta">${escapeHtml(o.payer)} · ${escapeHtml(catDisplay)}</div>
        </div>
      </div>
      <div class="loan-card-actions">
        <button class="button button-ghost loan-edit-toggle" type="button"
                onclick="toggleInlineLoanEdit('${escapeHtml(o.id)}')">Edit</button>
      </div>
    </div>
    <div class="obligation-details">
      <span class="ob-amount">${Number(o.amount) > 0 ? amd(Number(o.amount)) : '—'}</span>
      ${Number(o.dueDay) > 0 ? `<span class="ob-due">due day ${Number(o.dueDay)}</span>` : ''}
      ${badge}
    </div>
    <form class="inline-loan-edit hidden" id="inline-edit-${escapeHtml(o.id)}"
          onsubmit="submitInlineObligationEdit(event, '${escapeHtml(o.id)}')">
      <label>Bank / Payee<input name="bank" value="${escapeHtml(o.bank)}" required></label>
      <label>Monthly payment<input name="amount" type="number" min="0" value="${Number(o.amount) || 0}" required></label>
      <label>Due day<input name="dueDay" type="number" min="0" max="31" value="${Number(o.dueDay) || 0}" required></label>
      <label>Category<select name="category"><option value="business"${o.category==='business'?' selected':''}>Business</option><option value="personal"${o.category==='personal'?' selected':''}>Personal</option><option value="loan"${o.category==='loan'?' selected':''}>Loan</option></select></label>
      <label>Frequency${freqSelect(o.frequency || 'monthly')}</label>
      <label class="start-month-field${(o.frequency || 'monthly') === 'monthly' ? ' hidden' : ''}">Start month<input name="startDate" type="month" value="${inputMonth(o.startDate)}"></label>
      <div class="inline-edit-actions">
        <button class="button button-ghost" type="button"
                onclick="toggleInlineLoanEdit('${escapeHtml(o.id)}')">Cancel</button>
        <button class="button button-primary" type="submit">Save changes</button>
      </div>
    </form>
  </article>`;
}

function bankColorFor(name) {
  const text = String(name || '');
  let hash = 0;
  for (let i = 0; i < text.length; i++) hash = ((hash << 5) - hash) + text.charCodeAt(i);
  return PALETTE[Math.abs(hash) % PALETTE.length];
}

function freqSelect(currentFreq) {
  const opts = [['monthly','Every month'],['quarterly','Every 3 months'],['one_time','One time only']];
  return `<select name="frequency" onchange="toggleStartDateField(this)">${
    opts.map(([v, l]) => `<option value="${v}"${currentFreq === v ? ' selected' : ''}>${l}</option>`).join('')
  }</select>`;
}

function toggleStartDateField(sel) {
  const startField = sel.closest('form').querySelector('.start-month-field');
  if (!startField) return;
  const needs = sel.value !== 'monthly';
  startField.classList.toggle('hidden', !needs);
  const inp = startField.querySelector('input');
  if (inp) inp.required = needs;
}

function toggleInlineLoanEdit(id) {
  const panel = q('inline-edit-' + id);
  if (!panel) return;
  panel.classList.toggle('hidden');
  if (!panel.classList.contains('hidden')) panel.querySelector('input')?.focus();
}

function submitInlineLoanEdit(event, id) {
  event.preventDefault();
  const form = event.currentTarget;
  const value = name => form.elements[name].value;
  const optionalNumber = name => value(name) === '' ? '' : Number(value(name));
  updateLoan(id, {
    bank: value('bank').trim(),
    amount: Number(value('amount')),
    dueDay: Number(value('dueDay')),
    category: value('category'),
    frequency: value('frequency'),
    currentBalance: optionalNumber('currentBalance'),
    loanTotal: optionalNumber('loanTotal'),
    startDate: value('startDate'),
    contractNumber: value('contractNumber').trim()
  }, form.querySelector('[type="submit"]'));
}

function submitInlineObligationEdit(event, id) {
  event.preventDefault();
  const form = event.currentTarget;
  const value = name => form.elements[name].value;
  updateLoan(id, {
    bank: value('bank').trim(),
    amount: Number(value('amount')),
    dueDay: Number(value('dueDay')),
    category: value('category'),
    frequency: value('frequency'),
    startDate: value('startDate') || '',
    currentBalance: '',
    loanTotal: '',
    contractNumber: ''
  }, form.querySelector('[type="submit"]'));
}

function contractParts(value) {
  return String(value || '').trim().split(/\s+/).filter(Boolean);
}

async function copyContract(value, button) {
  try {
    await navigator.clipboard.writeText(value);
    if ('vibrate' in navigator) navigator.vibrate(10);
    const label = button.querySelector('span');
    label.textContent = 'Copied';
    setTimeout(() => { label.textContent = 'Copy'; }, 1200);
  } catch {
    showError('Copy failed. Please copy the contract number manually.');
  }
}

function fmtStartDate(d) {
  if (!d) return '';
  const date = new Date(d);
  if (Number.isNaN(date.getTime())) return String(d);
  return date.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
}

function inputMonth(value) {
  if (!value) return '';
  const match = String(value).match(/^(\d{4})-(\d{2})/);
  if (match) return `${match[1]}-${match[2]}`;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function openLoanEditor(id) {
  const loan = state.obligations.find(o => String(o.id) === String(id));
  if (!loan) return;
  q('edit-id').value = loan.id;
  q('edit-bank').value = loan.bank || '';
  q('edit-amount').value = Number(loan.amount) || 0;
  q('edit-due-day').value = Number(loan.dueDay) || 0;
  q('edit-balance').value = loan.currentBalance === '' ? '' : Number(loan.currentBalance);
  q('edit-total').value = loan.loanTotal === '' ? '' : Number(loan.loanTotal);
  q('edit-start-date').value = inputMonth(loan.startDate);
  q('edit-contract').value = loan.contractNumber || '';
  q('loan-edit-title').textContent = `Edit ${loan.bank || 'loan'}`;
  q('loan-edit-modal').classList.remove('hidden');
  q('edit-bank').focus();
}

function closeLoanEditor() {
  q('loan-edit-modal').classList.add('hidden');
}

function submitLoanEdit(event) {
  event.preventDefault();
  const optionalNumber = id => q(id).value === '' ? '' : Number(q(id).value);
  updateLoan(q('edit-id').value, {
    bank: q('edit-bank').value.trim(),
    amount: Number(q('edit-amount').value),
    dueDay: Number(q('edit-due-day').value),
    currentBalance: optionalNumber('edit-balance'),
    loanTotal: optionalNumber('edit-total'),
    startDate: q('edit-start-date').value,
    contractNumber: q('edit-contract').value.trim()
  });
}

function saveBalFromInput(id) {
  const val = Number(document.getElementById('bal-' + id).value);
  if (!isNaN(val) && val >= 0) saveBalance(id, val);
}

function savePaymentBalanceFromInput(id) {
  const input = document.getElementById('pay-bal-' + id);
  const val = Number(input?.value);
  if (!isNaN(val) && val >= 0) saveBalance(id, val);
}

// ================================================================
// Income
// ================================================================
function renderIncome() {
  const monthRows = state.income.filter(i => String(i.date).startsWith(state.month));
  const tot       = monthRows.reduce((s, i) => s + Number(i.amount), 0);

  q('income-month-total').textContent = amd(tot);

  const streamLabel = { car_rental: 'Car Rental', legal: 'Legal', real_estate: 'Real Estate', other: 'Other' };

  const incomeSorters = {
    'date-desc': (a, b) => String(b.date).localeCompare(String(a.date)),
    'date-asc': (a, b) => String(a.date).localeCompare(String(b.date)),
    'amount-desc': (a, b) => Number(b.amount) - Number(a.amount),
    'amount-asc': (a, b) => Number(a.amount) - Number(b.amount),
    'source-asc': (a, b) => String(a.stream || '').localeCompare(String(b.stream || ''))
  };
  const sorted = [...state.income].sort(incomeSorters[state.incomeSort] || incomeSorters['date-desc']);
  q('income-tbody').innerHTML = sorted.map(i => `<tr>
    <td>${escapeHtml(String(i.date).slice(0, 10))}</td>
    <td>${escapeHtml(streamLabel[i.stream] || i.stream)}</td>
    <td class="tr fw7">${amd(i.amount)}</td>
    <td class="muted">${escapeHtml(i.note || '')}</td>
  </tr>`).join('');
}

function submitIncome() {
  const date   = q('f-date').value;
  const amount = q('f-amount').value;
  const stream = q('f-stream').value;
  const note   = q('f-note').value.trim();
  if (!date || !amount) return alert('Date and amount are required.');
  addIncome({ date, amount: Number(amount), stream, note });
  q('f-amount').value = '';
  q('f-note').value   = '';
}

// ================================================================
// Reports
// ================================================================
function renderReports() {
  renderCategoryChart();
  renderMonthlyChart();
}

function renderCategoryChart() {
  const canvas = q('chart-cat2');
  if (!canvas) return;
  const all  = activeObs();
  const cats = ['loan','business','personal'];
  const data = cats.map(c => totalAmt(all.filter(o => o.category === c)));
  if (charts.cat2) charts.cat2.destroy();
  charts.cat2 = new Chart(canvas, {
    type: 'doughnut',
    data: {
      labels: ['Loans','Business','Personal'],
      datasets: [{ data, backgroundColor: ['#2563eb','#d97706','#7c3aed'], borderWidth: 2, borderColor: '#fff' }]
    },
    options: {
      plugins: { legend: { position: 'bottom' }, tooltip: { callbacks: { label: ctx => ' ' + amd(ctx.raw) } } },
      responsive: true,
    }
  });
}

function renderMonthlyChart() {
  const canvas = q('chart-monthly');
  if (!canvas) return;

  const months = [];
  let m = state.month;
  for (let i = 0; i < state.reportMonths; i++) { months.unshift(m); m = shiftMonth(m, -1); }

  const all   = activeObs();
  const total = totalAmt(all);

  const paidData = months.map(mo =>
    totalAmt(all.filter(o => state.payments[pkey(o.id, mo)]))
  );
  const debtData = months.map(mo => {
    const snapshots = state.loanHistory.filter(row => String(row.month) === mo && !row.completed);
    if (snapshots.length) {
      return snapshots.reduce((sum, row) => sum + Number(row.currentBalance || 0), 0);
    }
    return mo === state.month
      ? activeLoans().reduce((sum, loan) => sum + Number(loanBalance(loan, mo) || 0), 0)
      : 0;
  });

  const labels = months.map(mo => {
    const [y, month] = mo.split('-');
    return new Date(+y, +month - 1, 1).toLocaleDateString('en-US', { month: 'short' });
  });

  if (charts.monthly) charts.monthly.destroy();
  charts.monthly = new Chart(canvas, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        { label: 'Paid', data: paidData, backgroundColor: '#16a34a', borderRadius: 4 },
        {
          label: 'Total debt', data: debtData,
          type: 'line', borderColor: '#4f7cff', backgroundColor: 'transparent',
          borderDash: [5,4], pointRadius: 0, borderWidth: 1.5,
        }
      ]
    },
    options: {
      plugins: { legend: { display: true } },
      scales: { y: { ticks: { callback: v => (v/1000000).toFixed(1) + 'M ֏' } } },
      responsive: true,
    }
  });
}

// ================================================================
// Boot
// ================================================================
document.addEventListener('DOMContentLoaded', () => {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');

  // Tab nav
  document.querySelectorAll('.sidebar-nav a').forEach(a => {
    a.addEventListener('click', e => { e.preventDefault(); switchTab(a.dataset.tab); });
  });

  q('urgent-strip').addEventListener('click', event => {
    const card = event.target.closest('[data-jump-payment]');
    if (card) jumpToPayment(card.dataset.jumpPayment);
  });
  q('view-all-payments').addEventListener('click', () => switchTab('schedule'));

  // Month nav (all pages share the same class)
  document.addEventListener('click', e => {
    const previous = e.target.closest('.btn-prev');
    const next = e.target.closest('.btn-next');
    const today = e.target.closest('.btn-today');
    if (previous) changeMonth(shiftMonth(state.month, -1));
    if (next) changeMonth(shiftMonth(state.month, 1));
    if (today) changeMonth(todayMonth());
  });

  // Filter pills
  q('payer-filters').addEventListener('click', event => {
    const pill = event.target.closest('.pill');
    if (!pill) return;
    state.filter = pill.dataset.filter;
    q('payer-filters').querySelectorAll('.pill').forEach(p => p.classList.toggle('active', p === pill));
    renderSchedule();
  });

  q('show-completed').addEventListener('change', event => {
    state.statusFilter = event.target.checked ? 'all' : 'unpaid';
    renderSchedule();
  });

  q('schedule-search').addEventListener('input', event => {
    state.search = event.target.value.trim();
    renderSchedule();
  });

  q('schedule-sort').addEventListener('change', event => {
    state.scheduleSort = event.target.value;
    renderSchedule();
  });

  q('loan-sort').addEventListener('change', event => {
    state.loanSort = event.target.value;
    renderLoans();
  });

  q('income-sort').addEventListener('change', event => {
    state.incomeSort = event.target.value;
    renderIncome();
  });

  q('report-period').addEventListener('change', event => {
    state.reportMonths = Number(event.target.value);
    renderReports();
  });

  // Income submit
  q('btn-add-income').addEventListener('click', submitIncome);
  q('f-date').value = new Date().toISOString().slice(0,10);

  q('loan-edit-form').addEventListener('submit', submitLoanEdit);
  q('loan-edit-close').addEventListener('click', closeLoanEditor);
  q('loan-edit-cancel').addEventListener('click', closeLoanEditor);
  q('loan-edit-modal').addEventListener('click', event => {
    if (event.target === q('loan-edit-modal')) closeLoanEditor();
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') closeLoanEditor();
  });

  // Load data
  if (!API_URL || API_URL.includes('YOUR_')) {
    showError('Open config.js and paste your Apps Script URL into API_URL.');
    showLoading(false);
    // Show placeholder data so the UI is visible
    state.obligations = [];
    state.payments = {};
    state.income = [];
    render();
  } else {
    fetchAll();
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (document.body.classList.contains('is-loading')) return;
    if (!q('loan-edit-modal').classList.contains('hidden')) return;
    refreshData(false).catch(() => {});
  });
});

function changeMonth(month) {
  if (state.month === month) return;
  state.month = month;
  refreshData(true).catch(err => showError('Could not load month: ' + err.message));
}

function renderPayerFilters() {
  const container = q('payer-filters');
  container.innerHTML = [
    '<button class="pill active" data-filter="all">All payers</button>',
    ...payers().map(p =>
      `<button class="pill" data-filter="${escapeHtml(p)}">${escapeHtml(p)}</button>`
    )
  ].join('');
}
