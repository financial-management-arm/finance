'use strict';

// ================================================================
// State
// ================================================================
const state = {
  obligations: [],
  payments: {},   // "id__YYYY-MM" -> true/false
  income: [],
  month: todayMonth(),
  tab: 'schedule',
  filter: 'all',
  statusFilter: 'unpaid',
  search: '',
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

function isPaid(id) { return !!state.payments[pkey(id, state.month)]; }

function activeObs() {
  return state.obligations.filter(o => o.active === true || String(o.active).toUpperCase() === 'TRUE');
}

function filteredObs() {
  let rows = activeObs();
  if (state.filter !== 'all') rows = rows.filter(o => o.payer === state.filter);
  if (state.statusFilter === 'paid') rows = rows.filter(o => isPaid(o.id));
  if (state.statusFilter === 'unpaid') rows = rows.filter(o => !isPaid(o.id));
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

// ================================================================
// API
// ================================================================
async function callApi(params) {
  const url = new URL(API_URL);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, String(v)));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(url.toString(), { signal: controller.signal });
    const json = await res.json();
    if (json.error) throw new Error(json.error);
    return json;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchAll() {
  showLoading(true);
  try {
    const data = await callApi({ action: 'all' });
    state.obligations = data.obligations || [];
    state.payments = {};
    (data.payments || []).forEach(p => {
      state.payments[p.key] = (p.paid === true || String(p.paid).toUpperCase() === 'TRUE');
    });
    state.income = data.income || [];
    renderPayerFilters();
    render();
  } catch (err) {
    showError('Could not load data: ' + err.message);
  } finally {
    showLoading(false);
  }
}

async function togglePayment(id) {
  const key = pkey(id, state.month);
  const was = !!state.payments[key];
  state.payments[key] = !was;
  renderCurrentTab();
  try {
    await callApi({ action: 'setPayment', key, paid: !was });
  } catch {
    state.payments[key] = was;
    renderCurrentTab();
  }
}

async function saveBalance(id, balance) {
  try {
    await callApi({ action: 'updateBalance', id, balance });
    const ob = state.obligations.find(o => o.id === id);
    if (ob) ob.currentBalance = balance;
    renderLoans();
  } catch (err) {
    alert('Save failed: ' + err.message);
  }
}

async function updateLoan(id, changes) {
  const button = q('loan-edit-save');
  button.disabled = true;
  button.textContent = 'Saving...';
  try {
    await callApi({ action: 'updateLoan', id, ...changes });
    const loan = state.obligations.find(o => String(o.id) === String(id));
    if (loan) Object.assign(loan, changes);
    closeLoanEditor();
    renderLoans();
    showToast('Loan updated.');
  } catch (err) {
    showError('Could not update loan: ' + err.message);
  } finally {
    button.disabled = false;
    button.textContent = 'Save changes';
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
  document.getElementById('loading').classList.toggle('hidden', !on);
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
  const all  = activeObs();
  const paid = all.filter(o => isPaid(o.id));
  const paidAmt  = totalAmt(paid);
  const totalA   = totalAmt(all);
  const unpaidA  = totalA - paidAmt;
  const pct      = totalA ? Math.round(paidAmt / totalA * 100) : 0;
  const today = currentMonthDay();
  const unpaid = all.filter(o => !isPaid(o.id));
  const overdue = today ? unpaid.filter(o => Number(o.dueDay) > 0 && Number(o.dueDay) < today) : [];
  const dueSoon = today ? unpaid.filter(o => Number(o.dueDay) >= today && Number(o.dueDay) <= today + 7) : [];

  const monthIncome = state.income
    .filter(i => String(i.date).startsWith(state.month))
    .reduce((s, i) => s + Number(i.amount), 0);

  q('stat-total').textContent  = amd(totalA);
  q('stat-paid').textContent   = amd(paidAmt);
  q('stat-unpaid').textContent = amd(unpaidA);
  q('stat-income').textContent = monthIncome ? amd(monthIncome) : '—';
  const net = monthIncome - totalA;
  q('stat-net').textContent = amd(net);
  q('stat-net-card').classList.toggle('net-positive', net >= 0);
  q('stat-net-card').classList.toggle('net-negative', net < 0);
  q('stat-attention').textContent = today ? String(overdue.length + dueSoon.length) : '—';
  q('stat-attention-sub').textContent = today
    ? `${overdue.length} overdue · ${dueSoon.length} due in 7 days`
    : 'Open the current month for due dates';
  q('stat-sub').textContent    = `${paid.length} of ${all.length} paid`;
  q('prog-fill').style.width   = pct + '%';
  q('prog-label').textContent  = `${pct}% complete`;
  q('prog-paid').textContent   = amd(paidAmt) + ' paid';
  q('prog-left').textContent   = amd(unpaidA) + ' remaining';

  renderPayerBars();
  renderDashCategoryChart();
}

function renderPayerBars() {
  const all = activeObs();
  const html = payers().map(p => {
    const obs  = all.filter(o => o.payer === p);
    if (!obs.length) return '';
    const tot  = totalAmt(obs);
    const paid = totalAmt(obs.filter(o => isPaid(o.id)));
    const pct  = tot ? Math.round(paid / tot * 100) : 0;
    return `<div style="margin-bottom:10px">
      <div style="display:flex;justify-content:space-between;margin-bottom:3px">
        <span class="fw7" style="color:${payerColor(p)}">${escapeHtml(p)}</span>
        <span class="muted" style="font-size:11px">${amd(paid)} / ${amd(tot)}</span>
      </div>
      <div class="progress-bar">
        <div class="progress-fill" style="width:${pct}%;background:${payerColor(p)}"></div>
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
  const obs = filteredObs().sort((a, b) => Number(a.dueDay) - Number(b.dueDay));
  const tbody = q('sched-tbody');

  tbody.innerHTML = obs.length ? obs.map(o => {
    const paid = isPaid(o.id);
    return `<tr class="${paid ? 'is-paid' : ''}">
      <td class="fw7" style="color:${payerColor(o.payer)}">${escapeHtml(o.payer)}</td>
      <td>${escapeHtml(o.bank)}</td>
      <td><span class="badge ${escapeHtml(o.category)}">${escapeHtml(o.category)}</span></td>
      <td class="tr amt fw7">${Number(o.amount) > 0 ? amd(o.amount) : '—'}</td>
      <td class="tc muted">${Number(o.dueDay) > 0 ? o.dueDay : '—'}</td>
      <td class="tc">
        <button class="check-btn ${paid ? 'is-checked' : ''}"
                onclick="togglePayment('${escapeHtml(o.id)}')"
                title="${paid ? 'Mark unpaid' : 'Mark paid'}">
          ${paid ? '↶ Undo' : '✓ Done'}
        </button>
      </td>
    </tr>`;
  }).join('') : '<tr><td colspan="6" class="empty-state">No payments match these filters.</td></tr>';

  const all     = activeObs();
  const allPaid = all.filter(o => isPaid(o.id));
  const visPaid = obs.filter(o => isPaid(o.id));

  q('sched-total').textContent  = amd(totalAmt(obs));
  q('sched-count').textContent  = `${visPaid.length}/${obs.length}`;
  q('sched-grand').textContent  = `Total: ${amd(totalAmt(all))} — ${allPaid.length}/${all.length} paid`;
}

// ================================================================
// Loans
// ================================================================
function renderLoans() {
  const loans = activeObs().filter(o =>
    o.category === 'loan' || Number(o.loanTotal) > 0 || Number(o.currentBalance) > 0
  );

  const html = payers().map(p => {
    const pLoans = loans.filter(o => o.payer === p);
    if (!pLoans.length) return '';
    return `<div class="loans-section">
      <div class="loans-section-title" style="color:${payerColor(p)}">${escapeHtml(p)}</div>
      <div class="loans-grid">${pLoans.map(loanCard).join('')}</div>
    </div>`;
  }).join('');

  q('loans-container').innerHTML = html;
}

function loanCard(o) {
  const balRaw     = o.currentBalance;
  const balKnown   = balRaw !== '' && balRaw !== null && balRaw !== undefined && balRaw !== false;
  const bal        = balKnown ? Number(balRaw) : null;
  const tot        = Number(o.loanTotal) || 0;
  const pctOff     = (tot && bal !== null) ? Math.round((1 - bal / tot) * 100) : 0;
  const hasPayment = Number(o.amount) > 0;
  const contracts  = contractParts(o.contractNumber);

  return `<div class="loan-card">
    <div class="loan-card-top">
      <div>
        <div class="loan-bank">${escapeHtml(o.bank)}</div>
        <div class="loan-meta">${escapeHtml(o.payer)}</div>
        ${o.startDate ? `<div style="font-size:10px;color:var(--muted);margin-top:2px">Started ${fmtStartDate(o.startDate)}</div>` : ''}
      </div>
      <div class="loan-card-actions">
        <div style="text-align:right">
          ${hasPayment
            ? `<div class="loan-monthly">${amd(o.amount)}</div><div class="loan-mo-label">/month</div>`
            : `<div class="loan-mo-label" style="margin-top:6px;color:var(--muted)">credit / no payment</div>`}
        </div>
        <button class="btn-edit" type="button" onclick="openLoanEditor('${escapeHtml(o.id)}')">Edit</button>
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
    ${(tot || balKnown) ? `
    <div class="balance-row">
      <label>${tot ? 'Balance ֏' : 'Amount owed ֏'}</label>
      <input class="balance-input" type="number" id="bal-${o.id}"
             value="${bal !== null ? bal : ''}" min="0"
             placeholder="${balKnown ? '' : 'not yet verified'}">
      <button class="btn-save" onclick="saveBalFromInput('${o.id}')">Save</button>
    </div>
    ${!balKnown ? `<div style="font-size:10px;color:var(--warning);margin-bottom:6px">⚠ Balance not yet verified</div>` : ''}
    ${balKnown && tot ? `
    <div class="loan-progress">
      <div class="loan-progress-bar">
        <div class="loan-progress-fill" style="width:${pctOff}%"></div>
      </div>
      <div class="loan-progress-labels">
        <span>${pctOff}% paid off</span>
        <span>Total: ${amd(tot)}</span>
      </div>
    </div>` : ''}` : ''}
  </div>`;
}

function contractParts(value) {
  return String(value || '').trim().split(/\s+/).filter(Boolean);
}

async function copyContract(value, button) {
  try {
    await navigator.clipboard.writeText(value);
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

// ================================================================
// Income
// ================================================================
function renderIncome() {
  const monthRows = state.income.filter(i => String(i.date).startsWith(state.month));
  const tot       = monthRows.reduce((s, i) => s + Number(i.amount), 0);

  q('income-month-total').textContent = amd(tot);

  const streamLabel = { car_rental: 'Car Rental', legal: 'Legal', real_estate: 'Real Estate', other: 'Other' };

  const sorted = [...state.income].sort((a, b) => String(b.date).localeCompare(String(a.date)));
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
  for (let i = 0; i < 6; i++) { months.unshift(m); m = shiftMonth(m, -1); }

  const all   = activeObs();
  const total = totalAmt(all);

  const paidData = months.map(mo =>
    totalAmt(all.filter(o => state.payments[pkey(o.id, mo)]))
  );

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
          label: 'Total obligations', data: months.map(() => total),
          type: 'line', borderColor: '#94a3b8', backgroundColor: 'transparent',
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

  // Month nav (all pages share the same class)
  document.addEventListener('click', e => {
    if (e.target.classList.contains('btn-prev'))  { state.month = shiftMonth(state.month, -1); render(); }
    if (e.target.classList.contains('btn-next'))  { state.month = shiftMonth(state.month,  1); render(); }
    if (e.target.classList.contains('btn-today')) { state.month = todayMonth(); render(); }
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
});

function renderPayerFilters() {
  const container = q('payer-filters');
  container.innerHTML = [
    '<button class="pill active" data-filter="all">All payers</button>',
    ...payers().map(p =>
      `<button class="pill" data-filter="${escapeHtml(p)}">${escapeHtml(p)}</button>`
    )
  ].join('');
}
