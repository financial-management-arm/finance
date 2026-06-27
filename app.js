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
  utilities: [],
  month: todayMonth(),
  tab: 'schedule',
  filter: 'all',
  statusFilter: 'unpaid',
  search: '',
  scheduleSort: 'due-asc',
  loanSort: 'debt-desc',
  incomeSort: 'date-desc',
  cashEntries: [],
  offerFilter: 'all',
  offerSort: 'amount-desc',
  incomeSubTab: 'income',
  reportData: null,
  reportWindow: 6,
  reportLoading: false,
  reportError: false,
  reportPayer: 'all',
  reportCfSort: 'month-asc',
  reportDebtSort: 'month-asc',
  reportLoanSort: 'payoff-asc',
  reportHealthSort: 'month-asc',
};

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
function isPartial(id, month = state.month) { return paymentStatus(id, month) === 'partial'; }

function getPaidAmount(id, month = state.month) {
  const meta = state.paymentMeta[pkey(id, month)];
  return (meta && meta.paidAmount !== '' && meta.paidAmount !== undefined)
    ? Number(meta.paidAmount) : null;
}

function isPaymentResolved(id, month = state.month) {
  return ['paid', 'partial', 'not_done', 'no_need'].includes(paymentStatus(id, month));
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

function personalUtilsAsObs() {
  return activeUtils().filter(isUtilPersonal).map(u => {
    const rawAbonent = String(u.abonentNumber || '').replace(/:$/, '').trim();
    return {
      id: u.id,
      payer: String(u.payer || '').trim(),
      bank: String(u.name || '').trim(),
      provider: String(u.provider || '').trim(),
      abonentNumber: rawAbonent,
      category: 'utility',
      amount: isUtilFixed(u) ? (Number(u.amount) || 0) : 0,
      dueDay: Number(u.dueDay) || 0,
      frequency: 'monthly',
      contractNumber: ''
    };
  });
}

function payers() {
  const all = [...activeObs(), ...personalUtilsAsObs()];
  return [...new Set(all.map(o => String(o.payer || '').trim()).filter(Boolean))];
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

const CASH_CATEGORIES = { cash: 'Cash', aparik: 'Ապառիկ', credit_line: 'Credit Line' };

function isCreditLine(o) {
  return String(o.category || '').toLowerCase().includes('credit') &&
    (Number(o.currentBalance) || 0) === 0;
}

function isLoanRecord(obligation) {
  if (isCreditLine(obligation)) return false;
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
  const obs = activeObs().filter(o => isObligationDueThisMonth(o));
  return [...obs, ...personalUtilsAsObs()];
}

// ================================================================
// API
// ================================================================
async function callApi(params, { retries = 1, timeout = 30000 } = {}) {
  const url = new URL(API_URL);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, String(v)));
  url.searchParams.set('_t', Date.now());

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const res = await fetch(url.toString(), { cache: 'no-store', signal: controller.signal });
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
    state.utilities = data.utilities || [];
    state.cashEntries = data.cashEntries || [];
    renderPayerFilters();
    render();
  } catch (err) {
    showError('Could not load data: ' + err.message);
  } finally {
    showLoading(false);
  }
}

async function togglePayment(id) {
  const status = paymentStatus(id);
  if (status === 'paid' || status === 'partial') return setPaymentStatus(id, 'unpaid');
  openPaymentPanel(id);
}

async function setPaymentStatus(id, status) {
  return setPaymentWithAmount(id, status, null);
}

async function setPaymentWithAmount(id, status, paidAmt) {
  const key = pkey(id, state.month);
  const previousPaid = !!state.payments[key];
  const previousMeta = state.paymentMeta[key] ? { ...state.paymentMeta[key] } : null;
  const paid = status === 'paid';
  const resolved = paid || status === 'partial';

  state.payments[key] = paid;
  state.paymentMeta[key] = {
    key, paid, status,
    paidAmount: paidAmt !== null ? paidAmt : '',
    completedAt: resolved ? new Date().toISOString() : '',
    updatedAt: new Date().toISOString()
  };
  patchPaymentEl(id);

  try {
    const result = await callApi({
      action: 'setPayment', key, paid, status, month: state.month,
      paidAmount: paidAmt !== null ? paidAmt : ''
    });
    state.paymentMeta[key] = {
      key, paid,
      status: result.status || status,
      paidAmount: result.paidAmount !== undefined ? result.paidAmount : (paidAmt ?? ''),
      completedAt: result.completedAt || '',
      updatedAt: new Date().toISOString()
    };
    const toasts = {
      paid: 'Payment completed.',
      partial: `Partial payment of ${amd(paidAmt)} recorded.`,
      not_done: 'Marked as did not pay.',
      no_need: 'Marked no need.'
    };
    if (toasts[status]) showToast(toasts[status]);
  } catch (err) {
    state.payments[key] = previousPaid;
    if (previousMeta) state.paymentMeta[key] = previousMeta;
    else delete state.paymentMeta[key];
    patchPaymentEl(id);
    showError('Could not save — will retry automatically.');
  }
}

function openPaymentPanel(id) {
  document.querySelectorAll('.pay-panel:not(.hidden)').forEach(p => p.classList.add('hidden'));
  const panel = document.getElementById('pay-panel-' + id);
  if (!panel) return;
  const ob = state.obligations.find(o => String(o.id) === String(id))
           || personalUtilsAsObs().find(u => String(u.id) === String(id));
  const input = panel.querySelector('.pay-amount-input');
  if (input && ob) {
    const existing = getPaidAmount(id);
    input.value = existing !== null ? existing : (Number(ob.amount) || '');
  }
  panel.classList.remove('hidden');
  updatePayPanelHint(id);
  setTimeout(() => input?.select(), 50);
}

function closePaymentPanel(id) {
  const panel = document.getElementById('pay-panel-' + id);
  if (panel) panel.classList.add('hidden');
}

function updatePayPanelHint(id) {
  const ob = state.obligations.find(o => String(o.id) === String(id))
           || personalUtilsAsObs().find(u => String(u.id) === String(id));
  const panel = document.getElementById('pay-panel-' + id);
  const input = panel?.querySelector('.pay-amount-input');
  const hint = panel?.querySelector('.pay-panel-hint');
  if (!ob || !input || !hint) return;
  const amount = Number(input.value);
  const scheduled = Number(ob.amount) || 0;
  if (!input.value.trim() || amount === 0) {
    hint.className = 'pay-panel-hint hint-muted';
    hint.textContent = 'Enter 0 to mark as not paid';
  } else if (scheduled === 0) {
    hint.className = 'pay-panel-hint hint-success';
    hint.textContent = 'Payment recorded ✓';
  } else if (amount >= scheduled) {
    const over = amount - scheduled;
    hint.className = 'pay-panel-hint hint-success';
    hint.textContent = over > 0 ? `Full payment (+${amd(over)} extra)` : 'Full payment ✓';
  } else {
    const remaining = scheduled - amount;
    hint.className = 'pay-panel-hint hint-partial';
    hint.textContent = `Partial · ${amd(remaining)} still outstanding`;
  }
}

async function confirmPaymentAmount(id) {
  const ob = state.obligations.find(o => String(o.id) === String(id))
           || personalUtilsAsObs().find(u => String(u.id) === String(id));
  if (!ob) return;
  const panel = document.getElementById('pay-panel-' + id);
  const input = panel?.querySelector('.pay-amount-input');
  const amount = Number(input?.value ?? '');
  const scheduled = Number(ob.amount) || 0;
  const status = amount === 0 ? 'not_done'
    : (scheduled > 0 && amount < scheduled) ? 'partial'
    : 'paid';
  closePaymentPanel(id);
  await setPaymentWithAmount(id, status, amount);
}

function buildPartialInfo(id, ob) {
  const amt = getPaidAmount(id);
  if (amt === null || !isPartial(id)) return '';
  const scheduled = Number(ob?.amount) || 0;
  const remaining = scheduled > 0 ? Math.max(0, scheduled - amt) : 0;
  const pct = scheduled > 0 ? Math.round((amt / scheduled) * 100) : 0;
  return `<div class="partial-info">
    <div class="partial-bar"><div class="partial-bar-fill" style="width:${pct}%"></div></div>
    <div class="partial-label">${amd(amt)} paid · ${remaining > 0 ? amd(remaining) + ' remaining' : 'fully covered'}</div>
  </div>`;
}

function patchPaymentEl(id) {
  const el = document.querySelector(`[data-payment-id="${CSS.escape(id)}"]`);
  if (!el) { renderCurrentTab(); return; }

  const paid = isPaid(id);
  const status = paymentStatus(id);

  // Paid / status classes
  el.classList.toggle('is-paid', paid);
  el.className = el.className.replace(/\bis-(?:paid|unpaid|not-done|no-need|partial)\b/g, '').trim();
  el.classList.add(`is-${status.replace('_', '-')}`);

  // Urgency — restore when un-paying, clear when paying
  el.classList.remove('is-overdue', 'is-due-soon');
  if (!paid) {
    const o = dueThisMonth().find(ob => String(ob.id) === String(id));
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
    const resolved = paid || status === 'partial';
    doneBtn.textContent = paid ? 'Paid' : status === 'partial' ? 'Partial' : 'Record payment';
    doneBtn.classList.toggle('button-primary', !resolved);
    doneBtn.classList.toggle('button-secondary', resolved);
    doneBtn.setAttribute('onclick', resolved
      ? `setPaymentStatus('${id}', 'unpaid')`
      : `openPaymentPanel('${id}')`);
  }

  // Partial info
  const ob = state.obligations.find(o => String(o.id) === String(id))
           || personalUtilsAsObs().find(u => String(u.id) === String(id));
  const existingPartial = el.querySelector('.partial-info');
  const newPartialHtml = buildPartialInfo(id, ob);
  if (existingPartial) existingPartial.outerHTML = newPartialHtml || '<div class="partial-info" style="display:none"></div>';
  else if (newPartialHtml) {
    const anchor = el.querySelector('.payment-basic-actions, .payment-status-actions');
    if (anchor) anchor.insertAdjacentHTML('beforebegin', newPartialHtml);
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
  const all = dueThisMonth();
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
    state.utilities = data.utilities || [];
    state.cashEntries = data.cashEntries || [];
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
    case 'dashboard':  renderDashboard();  break;
    case 'schedule':   renderSchedule();   break;
    case 'loans':      renderLoans();      break;
    case 'income':     renderIncome();     break;
    case 'utilities':  renderUtilities();  break;
    case 'reports':    renderReports();    break;
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

  const all        = dueThisMonth();
  const allResolved2 = all.filter(o => isPaymentResolved(o.id));
  const visResolved2 = obs.filter(o => isPaymentResolved(o.id));

  q('sched-total').textContent  = amd(totalAmt(obs));
  q('sched-count').textContent  = `${visResolved2.length}/${obs.length}`;
  q('sched-grand').textContent  = `Total: ${amd(totalAmt(all))} · ${allResolved2.length}/${all.length} resolved`;
}

function paymentCard(o, index) {
  if (o.category === 'utility') return utilityPaymentCard(o, index);
  return isLoanRecord(o) ? loanPaymentCard(o, index) : standardPaymentCard(o, index);
}

function utilityPaymentCard(o, index) {
  const paid = isPaid(o.id);
  const partial = isPartial(o.id);
  const status = paymentStatus(o.id);
  const resolved = paid || partial;
  const completedAt = state.paymentMeta[pkey(o.id, state.month)]?.completedAt;
  const dueDay = Number(o.dueDay);
  const today = currentMonthDay();
  const urgency = !resolved && today && dueDay > 0
    ? (dueDay < today ? 'is-overdue' : dueDay <= today + 3 ? 'is-due-soon' : '')
    : '';
  const revealDelay = Math.min((index || 0) * 30, 200);
  const showAbonent = o.abonentNumber && o.abonentNumber.toLowerCase() !== 'transfer';

  return `<article class="util-pay-card row-reveal ${paid ? 'is-paid' : ''} is-${status.replace('_','-')} ${urgency}"
                  data-payment-id="${escapeHtml(o.id)}"
                  style="--payer-color:${payerColor(o.payer)};animation-delay:${revealDelay}ms">
    <div class="util-pay-body">
      <div class="util-pay-info">
        <div class="payment-basic-payer" style="color:var(--payer-color)">${escapeHtml(o.payer)}</div>
        <div class="util-pay-name">${escapeHtml(o.bank)}
          <span class="badge utility" style="vertical-align:middle">utility</span>
          ${paymentStatusBadge(status)}
        </div>
        <div class="util-pay-sub">
          ${o.provider ? `<span>${escapeHtml(o.provider)}</span>` : ''}
          ${showAbonent ? `<code class="abonent-code" style="font-size:11px">${escapeHtml(o.abonentNumber)}</code>
            <button class="util-copy-btn" type="button" style="min-height:22px;height:22px;font-size:11px;padding:0 6px"
                    onclick="copyAbonent('${escapeHtml(o.abonentNumber)}', this)">Copy</button>` : ''}
          ${resolved && completedAt ? `<time class="payment-card-time">${paid ? 'Paid' : 'Recorded'} ${formatTimestamp(completedAt)}</time>` : ''}
        </div>
      </div>
      <div class="util-pay-actions">
        ${Number(o.amount) > 0 ? `<strong class="util-pay-amount">${amd(o.amount)}</strong>` : ''}
        ${dueDay > 0 ? `<span class="util-pay-due">Day ${dueDay}</span>` : ''}
        <button class="button ${resolved ? 'button-secondary' : 'button-primary'} payment-done util-pay-btn"
                type="button"
                onclick="${resolved ? `setPaymentStatus('${escapeHtml(o.id)}', 'unpaid')` : `openPaymentPanel('${escapeHtml(o.id)}')`}">
          ${paid ? 'Paid ✓' : partial ? 'Partial' : 'Record'}
        </button>
      </div>
    </div>
    ${buildPartialInfo(o.id, o)}
    <div class="pay-panel hidden" id="pay-panel-${escapeHtml(o.id)}">
      <label class="pay-panel-label">Amount paid ֏</label>
      <div class="pay-panel-row">
        <input class="pay-amount-input" type="number" min="0" step="1000"
               placeholder="${Number(o.amount) || 0}"
               oninput="updatePayPanelHint('${escapeHtml(o.id)}')"
               onkeydown="if(event.key==='Enter'){event.preventDefault();confirmPaymentAmount('${escapeHtml(o.id)}');}">
        <button class="button button-primary" type="button"
                onclick="confirmPaymentAmount('${escapeHtml(o.id)}')">Confirm</button>
        <button class="button button-ghost" type="button"
                onclick="closePaymentPanel('${escapeHtml(o.id)}')">Cancel</button>
      </div>
      <div class="pay-panel-hint"></div>
    </div>
  </article>`;
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
        <button class="button ${(paid || status === 'partial') ? 'button-secondary' : 'button-primary'} payment-done"
                type="button"
                onclick="${(paid || status === 'partial') ? `setPaymentStatus('${escapeHtml(o.id)}', 'unpaid')` : `openPaymentPanel('${escapeHtml(o.id)}')`}">
          ${paid ? 'Paid ✓' : status === 'partial' ? 'Partial' : 'Record payment'}
        </button>
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
    ${buildPartialInfo(o.id, o)}
    <div class="payment-status-actions">
      <button class="button button-secondary payment-not-done" type="button"
              onclick="setPaymentStatus('${escapeHtml(o.id)}', 'not_done')">Did not pay</button>
      <button class="button button-ghost payment-no-need" type="button"
              onclick="setPaymentStatus('${escapeHtml(o.id)}', 'no_need')">No need</button>
    </div>
    <div class="pay-panel hidden" id="pay-panel-${escapeHtml(o.id)}">
      <label class="pay-panel-label">Amount paid ֏</label>
      <div class="pay-panel-row">
        <input class="pay-amount-input" type="number" min="0" step="1000"
               placeholder="${Number(o.amount) || 0}"
               oninput="updatePayPanelHint('${escapeHtml(o.id)}')"
               onkeydown="if(event.key==='Enter'){event.preventDefault();confirmPaymentAmount('${escapeHtml(o.id)}');}">
        <button class="button button-primary" type="button"
                onclick="confirmPaymentAmount('${escapeHtml(o.id)}')">Confirm</button>
        <button class="button button-ghost" type="button"
                onclick="closePaymentPanel('${escapeHtml(o.id)}')">Cancel</button>
      </div>
      <div class="pay-panel-hint"></div>
    </div>
  </article>`;
}

function standardPaymentCard(o, index) {
  const paid = isPaid(o.id);
  const partial = isPartial(o.id);
  const status = paymentStatus(o.id);
  const resolved = paid || partial;
  const completedAt = state.paymentMeta[pkey(o.id, state.month)]?.completedAt;
  const dueDay = Number(o.dueDay);
  const today = currentMonthDay();
  const urgency = !resolved && today && dueDay > 0
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
      ${resolved && completedAt ? `<time class="payment-card-time">${paid ? 'Paid' : 'Recorded'} ${formatTimestamp(completedAt)}</time>` : ''}
    </div>
    ${buildPartialInfo(o.id, o)}
    <div class="payment-basic-actions">
      <button class="button ${resolved ? 'button-secondary' : 'button-primary'} payment-done"
              type="button"
              onclick="${resolved ? `setPaymentStatus('${escapeHtml(o.id)}', 'unpaid')` : `openPaymentPanel('${escapeHtml(o.id)}')`}">
        ${paid ? 'Paid ✓' : partial ? 'Partial' : 'Record payment'}
      </button>
      <button class="button button-secondary payment-not-done" type="button"
              onclick="setPaymentStatus('${escapeHtml(o.id)}', 'not_done')">Did not pay</button>
      <button class="button button-ghost payment-no-need" type="button"
              onclick="setPaymentStatus('${escapeHtml(o.id)}', 'no_need')">No need</button>
    </div>
    <div class="pay-panel hidden" id="pay-panel-${escapeHtml(o.id)}">
      <label class="pay-panel-label">Amount paid ֏</label>
      <div class="pay-panel-row">
        <input class="pay-amount-input" type="number" min="0" step="1000"
               placeholder="${Number(o.amount) || 0}"
               oninput="updatePayPanelHint('${escapeHtml(o.id)}')"
               onkeydown="if(event.key==='Enter'){event.preventDefault();confirmPaymentAmount('${escapeHtml(o.id)}');}">
        <button class="button button-primary" type="button"
                onclick="confirmPaymentAmount('${escapeHtml(o.id)}')">Confirm</button>
        <button class="button button-ghost" type="button"
                onclick="closePaymentPanel('${escapeHtml(o.id)}')">Cancel</button>
      </div>
      <div class="pay-panel-hint"></div>
    </div>
  </article>`;
}

function paymentStatusBadge(status) {
  const labels = { paid: 'Done', partial: 'Partial', not_done: 'Did not pay', no_need: 'No need' };
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
        <button class="button btn-delete-ghost" type="button"
                onclick="confirmDeleteObligation('${escapeHtml(o.id)}')">Delete</button>
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
        <button class="button btn-delete-ghost" type="button"
                onclick="confirmDeleteObligation('${escapeHtml(o.id)}')">Delete</button>
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
function setIncomeSubTab(tab) {
  state.incomeSubTab = tab;
  renderIncome();
}

function renderIncome() {
  const subtab = state.incomeSubTab || 'income';
  document.querySelectorAll('.income-subtab-btn').forEach(b => {
    b.classList.toggle('is-active', b.dataset.subtab === subtab);
  });
  const incomeContent = document.getElementById('income-content');
  const cashContent = document.getElementById('cash-content');
  const monthNav = document.querySelector('#page-income .month-nav');
  if (incomeContent) incomeContent.classList.toggle('hidden', subtab !== 'income');
  if (monthNav) monthNav.style.visibility = subtab === 'income' ? '' : 'hidden';
  if (cashContent) {
    cashContent.classList.toggle('hidden', subtab !== 'cash');
    if (subtab === 'cash') cashContent.innerHTML = renderCashTab();
  }
  if (subtab === 'income') renderIncomeTab();
}

function cashEntryIsOffer(e) {
  return e.type === 'offer';
}

function renderCashEntryCard(e) {
  const isOffer = cashEntryIsOffer(e);
  const sid = escapeHtml(e.id);
  const offerTags = isOffer ? `<div class="offer-tags">
    ${e.category ? `<span class="offer-tag offer-tag-cat">${escapeHtml(e.category)}</span>` : ''}
    ${e.payer    ? `<span class="offer-tag offer-tag-payer">${escapeHtml(e.payer)}</span>`    : ''}
    ${e.lastAvailableDate && /^\d{4}-\d{2}-\d{2}$/.test(e.lastAvailableDate) ? `<span class="offer-tag offer-tag-date">${e.lastAvailableDate}</span>` : ''}
  </div>` : '';
  return `<div class="cash-entry" id="cash-entry-${sid}">
    <div class="cash-entry-view">
      <div class="cash-entry-info">
        <span class="cash-place">${escapeHtml(e.place)}</span>
        ${offerTags}
      </div>
      <span class="cash-entry-amount">${amd(Number(e.amount))}</span>
      <div class="cash-entry-actions">
        <button class="button button-ghost btn-sm" type="button" onclick="openCashEdit('${sid}')">Edit</button>
        <button class="button btn-delete-ghost btn-sm" type="button" onclick="confirmDeleteCash('${sid}')">Delete</button>
      </div>
    </div>
    <form class="cash-entry-edit hidden" id="cash-edit-${sid}" onsubmit="saveCashEdit(event,'${sid}')">
      <select class="form-input" name="type" onchange="toggleCashEditOfferFields(this)">
        <option value="cash"  ${!isOffer ? 'selected' : ''}>Cash Holding</option>
        <option value="offer" ${isOffer  ? 'selected' : ''}>Loan Offer</option>
      </select>
      <div class="cash-edit-offer-fields ${isOffer ? '' : 'hidden'}">
        <input class="form-input" name="category" type="text" list="offer-categories-list" value="${escapeHtml(e.category || '')}" placeholder="Category" maxlength="80">
        <input class="form-input" name="payer"    type="text" list="offer-payers-list"     value="${escapeHtml(e.payer    || '')}" placeholder="For whom"  maxlength="80">
        <input class="form-input" name="lastAvailableDate" type="date" value="${escapeHtml(e.lastAvailableDate || '')}">
      </div>
      <input class="form-input" name="place"  value="${escapeHtml(e.place)}" placeholder="Bank / Place" required maxlength="100">
      <input class="form-input" name="amount" type="number" value="${Number(e.amount)}" min="0" step="1000" required>
      <div class="cash-edit-btns">
        <button class="button button-ghost btn-sm"   type="button" onclick="closeCashEdit('${sid}')">Cancel</button>
        <button class="button button-primary btn-sm" type="submit">Save</button>
      </div>
    </form>
  </div>`;
}

function toggleCashEditOfferFields(typeSelect) {
  const fields = typeSelect.closest('form').querySelector('.cash-edit-offer-fields');
  if (fields) fields.classList.toggle('hidden', typeSelect.value !== 'offer');
}

function toggleCashAddOfferFields(typeSelect) {
  const grp = document.getElementById('cash-new-offer-fields');
  if (grp) grp.classList.toggle('hidden', typeSelect.value !== 'offer');
}

function setOfferFilter(cat) {
  state.offerFilter = cat;
  renderIncome();
}

function setOfferSort(sort) {
  state.offerSort = sort;
  renderIncome();
}

function renderOfferSection(allOffers) {
  const categories = [...new Set(allOffers.map(e => e.category).filter(Boolean))].sort();
  const filter = state.offerFilter || 'all';
  const sort = state.offerSort || 'amount-desc';
  const filtered = filter === 'all' ? allOffers : allOffers.filter(e => (e.category || '') === filter);
  const sorted = [...filtered].sort((a, b) => {
    if (sort === 'amount-asc')  return (Number(a.amount) || 0) - (Number(b.amount) || 0);
    if (sort === 'date-desc')   return String(b.lastAvailableDate || '').localeCompare(String(a.lastAvailableDate || ''));
    if (sort === 'date-asc')    return String(a.lastAvailableDate || '').localeCompare(String(b.lastAvailableDate || ''));
    if (sort === 'category')    return String(a.category || '').localeCompare(String(b.category || ''));
    return (Number(b.amount) || 0) - (Number(a.amount) || 0);
  });
  const total = sorted.reduce((s, e) => s + (Number(e.amount) || 0), 0);
  const chips = [
    `<button class="offer-chip${filter === 'all' ? ' is-active' : ''}" onclick="setOfferFilter('all')">All</button>`,
    ...categories.map(c => `<button class="offer-chip${filter === c ? ' is-active' : ''}" onclick="setOfferFilter('${escapeHtml(c)}')">${escapeHtml(c)}</button>`)
  ].join('');
  return `
    <div class="offer-controls">
      <div class="offer-filter-chips">${chips}</div>
      <select class="offer-sort-select" onchange="setOfferSort(this.value)">
        <option value="amount-desc" ${sort==='amount-desc'?'selected':''}>Amount ↓</option>
        <option value="amount-asc"  ${sort==='amount-asc' ?'selected':''}>Amount ↑</option>
        <option value="date-desc"   ${sort==='date-desc'  ?'selected':''}>Date ↓</option>
        <option value="date-asc"    ${sort==='date-asc'   ?'selected':''}>Date ↑</option>
        <option value="category"    ${sort==='category'   ?'selected':''}>Category A→Z</option>
      </select>
    </div>
    ${sorted.length
      ? `<div class="cash-entries-list">${sorted.map(renderCashEntryCard).join('')}</div>
         <div class="offer-total">Showing: <strong>${amd(total)}</strong></div>`
      : `<div class="cash-empty">No loan offers${filter !== 'all' ? ' in this category' : ''}.</div>`}`;
}

function renderCashTab() {
  const offerEntries = state.cashEntries.filter(cashEntryIsOffer);
  const cashEntries  = [...state.cashEntries].filter(e => !cashEntryIsOffer(e))
    .sort((a, b) => String(a.place).localeCompare(String(b.place)));
  const cashTotal = cashEntries.reduce((s, e) => s + (Number(e.amount) || 0), 0);

  const offerCategories = [...new Set(offerEntries.map(e => e.category).filter(Boolean))].sort();
  const payerSuggestions = [...new Set([
    ...state.obligations.map(o => o.payer).filter(Boolean),
    ...offerEntries.map(e => e.payer).filter(Boolean)
  ])].sort();

  const datalists = `
    <datalist id="offer-categories-list">${offerCategories.map(c => `<option value="${escapeHtml(c)}">`).join('')}</datalist>
    <datalist id="offer-payers-list">${payerSuggestions.map(p => `<option value="${escapeHtml(p)}">`).join('')}</datalist>`;

  return `${datalists}<div class="cash-tab-layout">
    <div class="cash-add-panel">
      <h3 class="cash-section-title">Add Entry</h3>
      <form class="cash-add-form" onsubmit="submitAddCash(event)">
        <div class="form-group">
          <label class="form-label">Section</label>
          <select class="form-input" id="cash-new-type" onchange="toggleCashAddOfferFields(this)">
            <option value="cash">Cash Holding</option>
            <option value="offer">Loan Offer</option>
          </select>
        </div>
        <div id="cash-new-offer-fields" class="hidden">
          <div class="form-group">
            <label class="form-label">Category</label>
            <input class="form-input" id="cash-new-category" type="text" list="offer-categories-list" placeholder="e.g. Ապառիկ, Cash, Credit Line" maxlength="80">
          </div>
          <div class="form-group">
            <label class="form-label">For whom</label>
            <input class="form-input" id="cash-new-payer" type="text" list="offer-payers-list" placeholder="e.g. Hovhannes" maxlength="80">
          </div>
          <div class="form-group">
            <label class="form-label">Last available</label>
            <input class="form-input" id="cash-new-date" type="date">
          </div>
        </div>
        <div class="form-group">
          <label class="form-label">Bank / Place</label>
          <input class="form-input" id="cash-new-place" placeholder="e.g. Wallet, ACBA" required maxlength="100">
        </div>
        <div class="form-group">
          <label class="form-label">Amount (֏)</label>
          <input class="form-input" id="cash-new-amount" type="number" placeholder="0" min="0" step="1000" required>
        </div>
        <button class="btn-add" type="submit">Add</button>
      </form>
    </div>
    <div class="cash-list-panel">
      <div class="income-list-header">
        <h3 class="cash-section-title">Cash Holdings</h3>
        <span class="muted">Total: <strong>${amd(cashTotal)}</strong></span>
      </div>
      ${cashEntries.length
        ? `<div class="cash-entries-list">${cashEntries.map(renderCashEntryCard).join('')}</div>`
        : '<div class="cash-empty">No cash entries yet.</div>'}
      <div class="cash-offer-divider"></div>
      <div class="income-list-header">
        <h3 class="cash-section-title">Loan Offers</h3>
      </div>
      <div class="cash-offer-note">Pre-approved offers — not yet drawn.</div>
      ${renderOfferSection(offerEntries)}
    </div>
  </div>`;
}

async function submitAddCash(event) {
  event.preventDefault();
  const type     = document.getElementById('cash-new-type').value || 'cash';
  const category = type === 'offer' ? (document.getElementById('cash-new-category').value.trim()) : '';
  const payer    = type === 'offer' ? (document.getElementById('cash-new-payer').value.trim()) : '';
  const lastAvailableDate = type === 'offer' ? (document.getElementById('cash-new-date').value) : '';
  const place    = document.getElementById('cash-new-place').value.trim();
  const amount   = Number(document.getElementById('cash-new-amount').value) || 0;
  if (!place) return;
  const entry = { id: 'cash-' + Date.now(), place, amount, type, category, payer, lastAvailableDate, updatedAt: new Date().toISOString() };
  state.cashEntries = [...state.cashEntries, entry];
  document.getElementById('cash-new-place').value = '';
  document.getElementById('cash-new-amount').value = '';
  if (type === 'offer') {
    document.getElementById('cash-new-category').value = '';
    document.getElementById('cash-new-payer').value = '';
    document.getElementById('cash-new-date').value = '';
  }
  renderIncome();
  try {
    await callApi({ action: 'addCashEntry', place, amount, type, category, payer, lastAvailableDate });
  } catch (err) {
    state.cashEntries = state.cashEntries.filter(e => e.id !== entry.id);
    renderIncome();
    showError('Could not save — please try again.');
  }
}

function openCashEdit(id) {
  const view = document.querySelector(`#cash-entry-${id} .cash-entry-view`);
  const form = document.getElementById('cash-edit-' + id);
  if (view) view.classList.add('hidden');
  if (form) form.classList.remove('hidden');
}

function closeCashEdit(id) {
  const view = document.querySelector(`#cash-entry-${id} .cash-entry-view`);
  const form = document.getElementById('cash-edit-' + id);
  if (view) view.classList.remove('hidden');
  if (form) form.classList.add('hidden');
}

async function saveCashEdit(event, id) {
  event.preventDefault();
  const form = document.getElementById('cash-edit-' + id);
  const type     = form.elements.type ? form.elements.type.value : 'cash';
  const category = type === 'offer' && form.elements.category ? form.elements.category.value.trim() : '';
  const payer    = type === 'offer' && form.elements.payer    ? form.elements.payer.value.trim()    : '';
  const lastAvailableDate = type === 'offer' && form.elements.lastAvailableDate ? form.elements.lastAvailableDate.value : '';
  const place  = form.elements.place.value.trim();
  const amount = Number(form.elements.amount.value) || 0;
  if (!place) return;
  const prev = state.cashEntries.find(e => e.id === id);
  state.cashEntries = state.cashEntries.map(e => e.id === id ? { ...e, place, amount, type, category, payer, lastAvailableDate } : e);
  renderIncome();
  try {
    await callApi({ action: 'updateCashEntry', id, place, amount, type, category, payer, lastAvailableDate });
  } catch (err) {
    if (prev) state.cashEntries = state.cashEntries.map(e => e.id === id ? prev : e);
    renderIncome();
    showError('Could not save — please try again.');
  }
}

async function confirmDeleteCash(id) {
  const entry = state.cashEntries.find(e => e.id === id);
  if (!entry) return;
  if (!confirm(`Delete "${entry.place}" (${amd(Number(entry.amount))})?`)) return;
  state.cashEntries = state.cashEntries.filter(e => e.id !== id);
  renderIncome();
  try {
    await callApi({ action: 'deleteCashEntry', id });
  } catch (err) {
    state.cashEntries = [...state.cashEntries, entry];
    renderIncome();
    showError('Could not delete — please try again.');
  }
}

function renderIncomeTab() {
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
  const streamOpts = Object.entries(streamLabel)
    .map(([v, l]) => `<option value="${v}">{L}</option>`.replace('{L}', l))
    .join('');

  q('income-tbody').innerHTML = sorted.map(i => {
    const opts = Object.entries(streamLabel)
      .map(([v, l]) => `<option value="${v}"${i.stream === v ? ' selected' : ''}>${l}</option>`).join('');
    return `<tr id="income-row-${escapeHtml(i.id)}">
      <td>${escapeHtml(String(i.date).slice(0, 10))}</td>
      <td>${escapeHtml(streamLabel[i.stream] || i.stream)}</td>
      <td class="tr fw7">${amd(i.amount)}</td>
      <td class="muted">${escapeHtml(i.note || '')}</td>
      <td class="income-row-actions">
        <button class="button button-ghost btn-sm" type="button" onclick="openIncomeEdit('${escapeHtml(i.id)}')">Edit</button>
        <button class="button btn-delete-ghost btn-sm" type="button" onclick="confirmDeleteIncome('${escapeHtml(i.id)}')">Delete</button>
      </td>
    </tr>
    <tr id="income-edit-${escapeHtml(i.id)}" class="income-edit-tr hidden">
      <td colspan="5">
        <form class="income-inline-edit" onsubmit="saveIncomeEdit(event,'${escapeHtml(i.id)}')">
          <input class="form-input income-edit-field" name="date" type="date" value="${escapeHtml(String(i.date).slice(0, 10))}" required>
          <select class="form-select income-edit-field" name="stream">${opts}</select>
          <input class="form-input income-edit-field" name="amount" type="number" value="${Number(i.amount)}" min="1" required>
          <input class="form-input income-edit-field" name="note" type="text" value="${escapeHtml(i.note || '')}" placeholder="Note">
          <div class="income-edit-btns">
            <button class="button button-ghost btn-sm" type="button" onclick="closeIncomeEdit('${escapeHtml(i.id)}')">Cancel</button>
            <button class="button button-primary btn-sm" type="submit">Save</button>
          </div>
        </form>
      </td>
    </tr>`;
  }).join('');
}

function openIncomeEdit(id) {
  document.querySelectorAll('.income-edit-tr:not(.hidden)').forEach(r => r.classList.add('hidden'));
  const row = document.getElementById('income-edit-' + id);
  if (row) row.classList.remove('hidden');
}

function closeIncomeEdit(id) {
  const row = document.getElementById('income-edit-' + id);
  if (row) row.classList.add('hidden');
}

async function saveIncomeEdit(event, id) {
  event.preventDefault();
  const form = event.target;
  const date = form.elements.date.value;
  const amount = Number(form.elements.amount.value);
  const stream = form.elements.stream.value;
  const note = form.elements.note.value.trim();
  if (!date || !amount) return;
  const prev = state.income.find(i => i.id === id);
  state.income = state.income.map(i => i.id === id ? { ...i, date, amount, stream, note } : i);
  closeIncomeEdit(id);
  renderIncomeTab();
  try {
    await callApi({ action: 'updateIncome', id, date, amount, stream, note });
  } catch (err) {
    if (prev) state.income = state.income.map(i => i.id === id ? prev : i);
    renderIncomeTab();
    showError('Could not save — please try again.');
  }
}

async function confirmDeleteIncome(id) {
  const entry = state.income.find(i => i.id === id);
  if (!entry) return;
  if (!confirm(`Delete income of ${amd(Number(entry.amount))} on ${entry.date}?`)) return;
  state.income = state.income.filter(i => i.id !== id);
  renderIncomeTab();
  try {
    await callApi({ action: 'deleteIncome', id });
  } catch (err) {
    state.income = [...state.income, entry];
    renderIncomeTab();
    showError('Could not delete — please try again.');
  }
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
// Utilities
// ================================================================
function activeUtils() {
  return state.utilities.filter(u => u.active === true || String(u.active).toUpperCase() === 'TRUE');
}

function isUtilPersonal(u) {
  return u.personalExpense === true || String(u.personalExpense).toUpperCase() === 'TRUE';
}

function isUtilFixed(u) {
  return String(u.type || '').toLowerCase() === 'fixed';
}

async function toggleUtilityPaid(id) {
  const key = pkey(id, state.month);
  if (state.payments[key]) { await setUtilityPayment(id, 'unpaid', null); return; }
  const u = state.utilities.find(u => String(u.id) === String(id));
  if (!u) return;
  if (isUtilPersonal(u) && !isUtilFixed(u)) { openUtilPanel(id); return; }
  const amt = isUtilFixed(u) ? (Number(u.amount) || 0) : 0;
  await setUtilityPayment(id, 'paid', amt);
}

function openUtilPanel(id) {
  document.querySelectorAll('.util-amount-panel:not(.hidden)').forEach(p => p.classList.add('hidden'));
  const panel = document.getElementById('util-panel-' + id);
  if (!panel) return;
  panel.classList.remove('hidden');
  setTimeout(() => panel.querySelector('.util-amount-input')?.focus(), 50);
}

function closeUtilPanel(id) {
  const el = document.getElementById('util-panel-' + id);
  if (el) el.classList.add('hidden');
}

async function confirmUtilAmount(id) {
  const panel = document.getElementById('util-panel-' + id);
  const input = panel?.querySelector('.util-amount-input');
  const amount = Number(input?.value ?? 0) || 0;
  closeUtilPanel(id);
  await setUtilityPayment(id, 'paid', amount);
}

async function setUtilityPayment(id, status, paidAmt) {
  const key = pkey(id, state.month);
  const paid = status === 'paid';
  const prev = { paid: state.payments[key], meta: state.paymentMeta[key] };
  state.payments[key] = paid;
  state.paymentMeta[key] = {
    key, paid, status,
    paidAmount: paidAmt !== null ? paidAmt : '',
    completedAt: paid ? new Date().toISOString() : '',
    updatedAt: new Date().toISOString()
  };
  patchUtilRow(id);
  try {
    await callApi({ action: 'setPayment', key, paid, status, month: state.month,
      paidAmount: paidAmt !== null ? paidAmt : '' });
    if (paid) showToast('Utility marked done.');
  } catch (err) {
    state.payments[key] = prev.paid;
    if (prev.meta) state.paymentMeta[key] = prev.meta; else delete state.paymentMeta[key];
    patchUtilRow(id);
    showError('Could not save — please try again.');
  }
}

function patchUtilRow(id) {
  const row = document.getElementById('util-row-' + id);
  if (!row) { renderUtilities(); return; }
  const paid = !!state.payments[pkey(id, state.month)];
  row.classList.toggle('is-done', paid);
  const btn = row.querySelector('.util-toggle');
  if (btn) {
    btn.classList.toggle('is-done', paid);
    btn.setAttribute('aria-label', paid ? 'Mark undone' : 'Mark done');
    btn.title = paid ? 'Mark undone' : 'Mark done';
  }
  const panel = row.querySelector('.util-amount-panel');
  if (panel && paid) panel.classList.add('hidden');
  const group = row.closest('.util-group');
  if (group) {
    const rows = group.querySelectorAll('.util-row');
    const doneCount = [...rows].filter(r => r.classList.contains('is-done')).length;
    const prog = group.querySelector('.util-group-progress');
    if (prog) {
      prog.textContent = `${doneCount}/${rows.length} done`;
      prog.classList.toggle('is-complete', doneCount === rows.length);
    }
    group.classList.toggle('all-done', doneCount === rows.length);
  }
}

async function copyAbonent(value, btn) {
  try {
    await navigator.clipboard.writeText(value);
    if ('vibrate' in navigator) navigator.vibrate(10);
    const orig = btn.textContent;
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = orig; }, 1200);
  } catch {
    showError('Copy failed.');
  }
}

function renderUtilities() {
  const utils = activeUtils();
  const container = q('utils-container');
  if (!container) return;
  if (!utils.length) {
    container.innerHTML = '<div class="empty-state">No utilities loaded. Add rows to the Utilities sheet and sync.</div>';
    return;
  }
  const PAYER_ORDER = ['Plus 1 Law Group LLC', 'Home', 'Family'];
  const groups = {};
  utils.forEach(u => { const p = String(u.payer || '').trim(); (groups[p] = groups[p] || []).push(u); });
  const sortedPayers = Object.keys(groups).sort((a, b) => {
    const ai = PAYER_ORDER.indexOf(a), bi = PAYER_ORDER.indexOf(b);
    if (ai >= 0 && bi >= 0) return ai - bi;
    if (ai >= 0) return -1; if (bi >= 0) return 1;
    return a.localeCompare(b);
  });
  container.innerHTML = sortedPayers.map(payer => {
    const items = groups[payer];
    const doneCount = items.filter(u => state.payments[pkey(u.id, state.month)]).length;
    const allDone = doneCount === items.length;
    return `<section class="util-group${allDone ? ' all-done' : ''}">
      <div class="util-group-header">
        <span class="util-group-name">${escapeHtml(payer)}</span>
        <span class="util-group-progress${allDone ? ' is-complete' : ''}">${doneCount}/${items.length} done</span>
      </div>
      <div class="util-group-list">${items.map(utilityRow).join('')}</div>
    </section>`;
  }).join('');
}

function utilityRow(u) {
  const key = pkey(u.id, state.month);
  const paid = !!state.payments[key];
  const paidAmt = state.paymentMeta[key]?.paidAmount;
  const personal = isUtilPersonal(u);
  const fixed = isUtilFixed(u);
  const rawAbonent = String(u.abonentNumber || '').replace(/:$/, '').trim();
  const showAbonent = rawAbonent && rawAbonent !== 'transfer';

  return `<div class="util-row${paid ? ' is-done' : ''}" id="util-row-${escapeHtml(u.id)}" data-util-id="${escapeHtml(u.id)}">
    <div class="util-row-main">
      <div>
        <div class="util-row-info">
          <span class="util-type">${escapeHtml(u.name)}</span>
          <span class="util-provider">${escapeHtml(u.provider)}</span>
          ${showAbonent
            ? `<div class="util-abonent">
                <code class="abonent-code">${escapeHtml(rawAbonent)}</code>
                <button class="util-copy-btn" type="button"
                        onclick="copyAbonent('${escapeHtml(rawAbonent)}', this)">Copy</button>
              </div>`
            : `<span class="util-transfer-label">via transfer</span>`}
        </div>
        <div class="util-row-meta">
          ${Number(u.dueDay) > 0 ? `<span class="util-due-badge">day ${Number(u.dueDay)}</span>` : ''}
          ${fixed && Number(u.amount) > 0 ? `<span class="util-amount-label">${amd(Number(u.amount))}</span>` : ''}
          ${!personal ? `<span class="util-biz-tag">business</span>` : ''}
          ${paid && paidAmt ? `<span class="util-paid-badge">${amd(Number(paidAmt))}</span>` : ''}
        </div>
      </div>
      <div style="display:flex;gap:6px;align-items:center">
        <button class="util-toggle${paid ? ' is-done' : ''}" type="button"
                onclick="toggleUtilityPaid('${escapeHtml(u.id)}')"
                aria-label="${paid ? 'Mark undone' : 'Mark done'}"
                title="${paid ? 'Mark undone' : 'Mark done'}"></button>
        <button class="btn-icon-edit" type="button" onclick="openUtilEdit('${escapeHtml(u.id)}')"
                title="Edit" aria-label="Edit utility">✎</button>
        <button class="btn-icon-delete" type="button" onclick="confirmDeleteUtility('${escapeHtml(u.id)}')"
                title="Delete" aria-label="Delete utility">✕</button>
      </div>
    </div>
    ${personal && !fixed && !paid ? `<div class="util-amount-panel hidden" id="util-panel-${escapeHtml(u.id)}">
      <label class="util-panel-label">Amount paid ֏</label>
      <div class="util-panel-row">
        <input class="util-amount-input" type="number" min="0" step="1000" placeholder="Enter amount"
               onkeydown="if(event.key==='Enter'){event.preventDefault();confirmUtilAmount('${escapeHtml(u.id)}');}">
        <button class="button button-primary" type="button" onclick="confirmUtilAmount('${escapeHtml(u.id)}')">OK</button>
        <button class="button button-ghost" type="button" onclick="closeUtilPanel('${escapeHtml(u.id)}')">Cancel</button>
      </div>
    </div>` : ''}
  </div>`;
}

// ================================================================
// Delete confirm modal
// ================================================================
let _deleteConfirmCallback = null;

function openDeleteConfirm(message, onConfirm) {
  q('delete-confirm-msg').textContent = message;
  _deleteConfirmCallback = onConfirm;
  q('delete-confirm-modal').classList.remove('hidden');
}

function closeDeleteConfirm() {
  _deleteConfirmCallback = null;
  q('delete-confirm-modal').classList.add('hidden');
}

function executeDeleteConfirm() {
  const fn = _deleteConfirmCallback;
  closeDeleteConfirm();
  if (fn) fn();
}

async function confirmDeleteObligation(id) {
  const ob = state.obligations.find(o => String(o.id) === String(id));
  if (!ob) return;
  openDeleteConfirm(
    `Delete "${ob.bank || ob.id}" (${ob.payer})? This cannot be undone.`,
    async () => {
      try {
        const res = await callApi({ action: 'deleteObligation', id });
        if (res.error) throw new Error(res.error);
        state.obligations = state.obligations.filter(o => String(o.id) !== String(id));
        renderPayerFilters();
        renderCurrentTab();
        showToast('Obligation deleted.');
      } catch (err) {
        showError('Delete failed: ' + err.message);
      }
    }
  );
}

async function confirmDeleteUtility(id) {
  const u = state.utilities.find(u => String(u.id) === String(id));
  if (!u) return;
  openDeleteConfirm(
    `Delete "${u.name || u.id}" (${u.payer})? This cannot be undone.`,
    async () => {
      try {
        const res = await callApi({ action: 'deleteUtility', id });
        if (res.error) throw new Error(res.error);
        state.utilities = state.utilities.filter(u => String(u.id) !== String(id));
        closeUtilEdit();
        renderPayerFilters();
        renderCurrentTab();
        showToast('Utility deleted.');
      } catch (err) {
        showError('Delete failed: ' + err.message);
      }
    }
  );
}

// ================================================================
// Utility CRUD
// ================================================================
function openAddUtilityModal() {
  const payerList = ['Plus 1 Law Group LLC', 'Home', 'Family',
    ...new Set(activeUtils().map(u => String(u.payer || '').trim()).filter(Boolean))];
  q('add-util-payer-list').innerHTML = [...new Set(payerList)].map(p => `<option value="${escapeHtml(p)}">`).join('');
  q('add-util-modal').classList.remove('hidden');
  q('add-util-name').focus();
}

function closeAddUtilityModal() {
  q('add-util-modal').classList.add('hidden');
  q('add-util-form').reset();
}

async function submitAddUtility() {
  const name = q('add-util-name').value.trim();
  const payer = q('add-util-payer').value.trim();
  if (!name || !payer) { alert('Name and Payer are required.'); return; }
  const params = {
    action: 'addUtility',
    name,
    payer,
    provider: q('add-util-provider').value.trim(),
    abonentNumber: q('add-util-abonent').value.trim(),
    amount: q('add-util-amount').value || '0',
    type: q('add-util-type').value,
    dueDay: q('add-util-dueday').value || '0',
    active: 'true',
    personalExpense: q('add-util-personal').value
  };
  try {
    const res = await callApi(params);
    if (res.error) throw new Error(res.error);
    closeAddUtilityModal();
    await refreshData();
    showToast('Utility added.');
  } catch (err) {
    alert('Failed to add: ' + err.message);
  }
}

function openUtilEdit(id) {
  const u = state.utilities.find(u => String(u.id) === String(id));
  if (!u) return;
  q('edit-util-id').value = u.id;
  q('edit-util-name').value = u.name || '';
  q('edit-util-payer').value = u.payer || '';
  q('edit-util-provider').value = u.provider || '';
  q('edit-util-abonent').value = u.abonentNumber || '';
  q('edit-util-amount').value = u.amount || '';
  q('edit-util-type').value = u.type || 'variable';
  q('edit-util-dueday').value = u.dueDay || '';
  q('edit-util-personal').value = String(u.personalExpense) === 'true' ? 'true' : 'false';
  q('edit-util-active').value = String(u.active) === 'true' || String(u.active).toUpperCase() === 'TRUE' ? 'true' : 'false';
  const payerList = ['Plus 1 Law Group LLC', 'Home', 'Family',
    ...new Set(activeUtils().map(u => String(u.payer || '').trim()).filter(Boolean))];
  q('edit-util-payer-list').innerHTML = [...new Set(payerList)].map(p => `<option value="${escapeHtml(p)}">`).join('');
  q('edit-util-modal').classList.remove('hidden');
  q('edit-util-name').focus();
}

function closeUtilEdit() {
  q('edit-util-modal').classList.add('hidden');
  q('edit-util-form').reset();
}

async function submitUtilEdit() {
  const id = q('edit-util-id').value;
  const name = q('edit-util-name').value.trim();
  const payer = q('edit-util-payer').value.trim();
  if (!name || !payer) { alert('Name and Payer are required.'); return; }
  const params = {
    action: 'updateUtility',
    id,
    name,
    payer,
    provider: q('edit-util-provider').value.trim(),
    abonentNumber: q('edit-util-abonent').value.trim(),
    amount: q('edit-util-amount').value || '0',
    type: q('edit-util-type').value,
    dueDay: q('edit-util-dueday').value || '0',
    personalExpense: q('edit-util-personal').value,
    active: q('edit-util-active').value
  };
  try {
    const res = await callApi(params);
    if (res.error) throw new Error(res.error);
    closeUtilEdit();
    await refreshData();
    showToast('Utility updated.');
  } catch (err) {
    alert('Failed to update: ' + err.message);
  }
}

// ================================================================
// Reports
// ================================================================

function amdCompact(n) {
  n = Number(n || 0);
  if (Math.abs(n) >= 1000000) return (n / 1000000).toFixed(1) + 'M ֏';
  if (Math.abs(n) >= 1000) return Math.round(n / 1000) + 'K ֏';
  return amd(n);
}

function shortMonLabel(m) {
  const [y, mo] = m.split('-');
  return new Date(+y, +mo - 1, 1).toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
}

function sortTh(label, col, panel, curSort, extraCls = '') {
  const [curCol, curDir] = (curSort || 'month-asc').split('-');
  const active = curCol === col;
  const nextDir = active && curDir === 'asc' ? 'desc' : 'asc';
  const ind = active ? (curDir === 'asc' ? '▲' : '▼') : '⇅';
  const cls = ['sortable-th', extraCls, active ? `sort-${curDir}` : ''].filter(Boolean).join(' ');
  return `<th class="${cls}" data-sp="${panel}" data-sc="${col}" data-sd="${nextDir}">${label}<span class="sort-ind">${ind}</span></th>`;
}

function sortRows(arr, sortStr) {
  const [col, dir] = (sortStr || 'month-asc').split('-');
  const mult = dir === 'desc' ? -1 : 1;
  return [...arr].sort((a, b) => {
    let va = a[col], vb = b[col];
    if (va == null) va = mult > 0 ? '￿' : '';
    if (vb == null) vb = mult > 0 ? '￿' : '';
    return typeof va === 'string' ? va.localeCompare(vb) * mult : (va - vb) * mult;
  });
}

async function syncReports() {
  state.reportLoading = true;
  state.reportError = false;
  state.reportData = null;
  renderReports();
  const btn = document.getElementById('btn-sync-reports');
  if (btn) { btn.disabled = true; btn.textContent = '↻ Syncing…'; }
  try {
    const params = { action: 'getReportData', toMonth: todayMonth(), window: state.reportWindow };
    if (state.reportPayer !== 'all') params.payer = state.reportPayer;
    const data = await callApi(params, { timeout: 55000 });
    if (data.error) throw new Error(data.error);
    state.reportData = data;
  } catch (err) {
    state.reportError = true;
    showError('Could not load reports: ' + err.message);
  } finally {
    state.reportLoading = false;
    if (btn) { btn.disabled = false; btn.textContent = '↻ Sync'; }
    renderReports();
  }
}

function renderReports() {
  const body = document.getElementById('report-body');
  if (!body) return;
  const balanceHtml = renderBalancePanel();
  if (!state.reportData && !state.reportLoading) {
    if (state.reportError) {
      body.innerHTML = balanceHtml + `<div class="report-panel"><div class="report-empty">Could not load report data.<br>Tap <strong>↻ Sync</strong> to retry.</div></div>`;
      return;
    }
    syncReports();
    body.innerHTML = balanceHtml + reportsSkeleton();
    return;
  }
  if (state.reportLoading || !state.reportData) { body.innerHTML = balanceHtml + reportsSkeleton(); return; }
  const d = state.reportData;

  // Build payer list from loaded obligations+utilities (no extra API call needed)
  const payerSet = new Set();
  state.obligations.forEach(o => { if (o.active === true || String(o.active).toUpperCase() === 'TRUE') payerSet.add(String(o.payer || '').trim()); });
  state.utilities.forEach(u => { if (u.active === true || String(u.active).toUpperCase() === 'TRUE') payerSet.add(String(u.payer || '').trim()); });
  payerSet.delete('');
  const payers = [...payerSet].sort();

  const payerBar = payers.length > 1 ? `
    <div class="report-filter-bar">
      <span class="rfl-label">Payer</span>
      <select class="report-payer-select rfl-select">
        <option value="all"${state.reportPayer === 'all' ? ' selected' : ''}>All payers</option>
        ${payers.map(p => `<option value="${escapeHtml(p)}"${state.reportPayer === p ? ' selected' : ''}>${escapeHtml(p)}</option>`).join('')}
      </select>
      ${state.reportPayer !== 'all' ? `<span class="rfl-active-pill">${escapeHtml(state.reportPayer)}</span>` : ''}
    </div>` : '';

  body.innerHTML = balanceHtml + `
    ${payerBar}
    ${renderReportSummary(d)}
    ${renderCashFlowPanel(d)}
    <div class="report-2col">
      ${renderDebtPanel(d)}
      ${renderLoanProjections(d)}
    </div>
    ${renderCategoryPanel()}
    ${renderPayerPanel()}
    ${renderHealthPanel(d)}
  `;
}

function reportsSkeleton() {
  const r = '<div class="skel skel-row"></div>';
  const r6 = r.repeat(6), r4 = r.repeat(4);
  const panel = (rows) => `<div class="report-panel">
    <div class="report-panel-header"><div class="skel skel-title"></div></div>
    <div class="report-panel-body rp-pad">${rows}</div>
  </div>`;
  return `${panel(r6)}<div class="report-2col">${panel(r4)}${panel(r4)}</div>${panel(r6)}`;
}

function renderCashFlowPanel(d) {
  const raw = d.cashFlow || [];
  if (!raw.length) return `<div class="report-panel"><div class="report-empty">No income data yet — add income records to generate cash flow analysis.</div></div>`;

  // Build payment lookup map once (state.payments starts as {} before fetchAll, guard for that)
  const payArr = Array.isArray(state.payments) ? state.payments : [];
  const payMap = new Map();
  payArr.forEach(p => payMap.set(String(p.key), p));

  const activeUtils = state.utilities.filter(u => u.active === true || String(u.active).toUpperCase() === 'TRUE');

  function monthPaid(month) {
    const items = [
      ...activeObs().filter(o => isObligationDueThisMonth(o, month)),
      ...activeUtils
    ];
    let total = 0;
    items.forEach(item => {
      const p = payMap.get(`${item.id}__${month}`);
      if (!p) return;
      const isPd = p.paid === true || String(p.paid).toUpperCase() === 'TRUE';
      const isPartial = String(p.status || '').toLowerCase() === 'partial';
      if (isPd || isPartial) {
        total += Number(p.paidAmount) > 0 ? Number(p.paidAmount) : (Number(item.amount) || 0);
      }
    });
    return total;
  }

  // Use client-side paid amounts (obligation.amount fallback when paidAmount not entered)
  const enriched = raw.map(r => {
    const paid = monthPaid(r.month);
    const net = r.income - paid;
    const cov = r.income > 0 ? Math.round((paid / r.income) * 100) : 0;
    return { ...r, paid, net, cov };
  });
  const sorted = sortRows(enriched, state.reportCfSort);

  let totIncome = 0, totPaid = 0;
  enriched.forEach(r => { totIncome += r.income; totPaid += r.paid; });

  const bodyRows = sorted.map(r => {
    const net = r.net, pos = net >= 0;
    const covCol = r.cov < 60 ? 'var(--success)' : r.cov < 80 ? 'var(--warning)' : 'var(--danger)';
    return `<tr>
      <td class="cf-month">${shortMonLabel(r.month)}</td>
      <td class="cf-num">${r.income ? amdCompact(r.income) : '<span class="cf-zero">—</span>'}</td>
      <td class="cf-num">${r.paid ? amdCompact(r.paid) : '<span class="cf-zero">—</span>'}</td>
      <td class="cf-num ${pos ? 'cf-pos' : 'cf-neg'}">${pos ? '+' : '−'}${amdCompact(Math.abs(net))}</td>
      <td class="cf-cov">
        <div class="cf-bar-wrap"><div class="cf-bar" style="width:${Math.min(r.cov,100)}%;background:${covCol}"></div></div>
        <span class="cf-pct">${r.cov}%</span>
      </td>
    </tr>`;
  }).join('');

  const totNet = totIncome - totPaid, totPos = totNet >= 0;
  const totCov = totIncome > 0 ? Math.round((totPaid / totIncome) * 100) : 0;
  const totCovCol = totCov < 60 ? 'var(--success)' : totCov < 80 ? 'var(--warning)' : 'var(--danger)';
  const s = state.reportCfSort;

  return `<div class="report-panel">
    <div class="report-panel-header">
      <div class="rp-title">
        <svg class="rp-icon" viewBox="0 0 20 20"><path d="M3 15h14M3 10h14M3 5h10"/></svg>
        Cash Flow Statement
      </div>
      <div class="rp-badge">${raw.length} months</div>
    </div>
    <div class="report-panel-body">
      <table class="report-table">
        <thead><tr>
          ${sortTh('Month','month','cf',s)}
          ${sortTh('Income','income','cf',s,'cf-num')}
          ${sortTh('Paid out','paid','cf',s,'cf-num')}
          ${sortTh('Net','net','cf',s,'cf-num')}
          ${sortTh('Coverage','cov','cf',s,'cf-cov-head')}
        </tr></thead>
        <tbody>${bodyRows}</tbody>
        <tfoot><tr>
          <td class="cf-month rp-total">Total</td>
          <td class="cf-num rp-total">${amdCompact(totIncome)}</td>
          <td class="cf-num rp-total">${amdCompact(totPaid)}</td>
          <td class="cf-num rp-total ${totPos ? 'cf-pos' : 'cf-neg'}">${totPos ? '+' : '−'}${amdCompact(Math.abs(totNet))}</td>
          <td class="cf-cov rp-total">
            <div class="cf-bar-wrap"><div class="cf-bar" style="width:${Math.min(totCov,100)}%;background:${totCovCol}"></div></div>
            <span class="cf-pct">${totCov}%</span>
          </td>
        </tr></tfoot>
      </table>
    </div>
  </div>`;
}

function renderDebtPanel(d) {
  const raw = d.debt || [];
  if (!raw.length) return `<div class="report-panel rp-flex"><div class="report-empty">No loan snapshots available.</div></div>`;
  const sorted = sortRows(raw, state.reportDebtSort);
  const s = state.reportDebtSort;
  const bodyRows = sorted.map(r => {
    let deltaHtml = '<span class="debt-neutral">—</span>';
    if (r.delta !== null && r.delta !== undefined) {
      if (r.delta < 0) deltaHtml = `<span class="debt-good">▼ ${amdCompact(Math.abs(r.delta))}</span>`;
      else if (r.delta > 0) deltaHtml = `<span class="debt-bad">▲ ${amdCompact(r.delta)}</span>`;
      else deltaHtml = `<span class="debt-neutral">= unchanged</span>`;
    }
    return `<tr>
      <td class="cf-month">${shortMonLabel(r.month)}</td>
      <td class="cf-num"><strong>${r.totalBalance ? amdCompact(r.totalBalance) : '—'}</strong></td>
      <td>${deltaHtml}</td>
    </tr>`;
  }).join('');
  return `<div class="report-panel rp-flex">
    <div class="report-panel-header">
      <div class="rp-title">
        <svg class="rp-icon" viewBox="0 0 20 20"><path d="M3 17V7l7-4 7 4v10M8 17v-5h4v5"/></svg>
        Debt Trend
      </div>
    </div>
    <div class="report-panel-body">
      <table class="report-table">
        <thead><tr>
          ${sortTh('Month','month','debt',s)}
          ${sortTh('Total balance','totalBalance','debt',s,'cf-num')}
          ${sortTh('Change','delta','debt',s)}
        </tr></thead>
        <tbody>${bodyRows}</tbody>
      </table>
    </div>
  </div>`;
}

function renderLoanProjections(d) {
  const raw = d.loanProjections || [];
  if (!raw.length) return `<div class="report-panel rp-flex"><div class="report-empty">No active loans to project.</div></div>`;

  const [lsCol, lsDir] = (state.reportLoanSort || 'payoff-asc').split('-');
  const lsMult = lsDir === 'desc' ? -1 : 1;
  const loans = [...raw].sort((a, b) => {
    if (lsCol === 'payoff') {
      const va = a.payoffDate || '9999-99', vb = b.payoffDate || '9999-99';
      return va.localeCompare(vb) * lsMult;
    }
    if (lsCol === 'balance') return ((a.balance || 0) - (b.balance || 0)) * lsMult;
    if (lsCol === 'bank')  return (a.bank  || '').localeCompare(b.bank  || '') * lsMult;
    if (lsCol === 'payer') return (a.payer || '').localeCompare(b.payer || '') * lsMult;
    return 0;
  });

  const lsOpts = [
    ['payoff-asc','Payoff ↑'], ['payoff-desc','Payoff ↓'],
    ['balance-desc','Balance ↓'], ['balance-asc','Balance ↑'],
    ['bank-asc','Name A–Z'], ['payer-asc','Payer A–Z'],
  ].map(([v, l]) => `<option value="${v}"${state.reportLoanSort === v ? ' selected' : ''}>${l}</option>`).join('');

  const items = loans.map(loan => {
    let payoffHtml;
    if (loan.payoffDate) {
      const [y, mo] = loan.payoffDate.split('-');
      const label = new Date(+y, +mo - 1, 1).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
      const [ty, tm] = todayMonth().split('-').map(Number);
      const [py, pm] = loan.payoffDate.split('-').map(Number);
      const moLeft = (py * 12 + pm) - (ty * 12 + tm);
      const urgCls = moLeft <= 6 ? 'payoff-urgent' : moLeft <= 18 ? 'payoff-soon' : 'payoff-ok';
      payoffHtml = `<div class="payoff-date ${urgCls}">${escapeHtml(label)}</div><div class="payoff-months">${moLeft} mo left</div>`;
    } else {
      payoffHtml = `<div class="payoff-variable">Variable</div>`;
    }
    return `<div class="loan-proj-row">
      <div class="loan-proj-info">
        <div class="loan-proj-name">${escapeHtml(loan.bank || loan.id)}</div>
        <div class="loan-proj-payer">${escapeHtml(loan.payer)}</div>
      </div>
      <div class="loan-proj-right">
        <div class="loan-proj-balance">${amdCompact(loan.balance)}</div>
        <div class="loan-proj-payoff">${payoffHtml}</div>
      </div>
    </div>`;
  }).join('');
  return `<div class="report-panel rp-flex">
    <div class="report-panel-header">
      <div class="rp-title">
        <svg class="rp-icon" viewBox="0 0 20 20"><path d="M10 2a8 8 0 1 0 0 16A8 8 0 0 0 10 2Zm0 4v4l3 3"/></svg>
        Loan Payoffs
      </div>
      <div class="rp-header-right">
        <span class="rp-badge">${raw.length} active</span>
        <select class="panel-sort-select loan-sort-select">${lsOpts}</select>
      </div>
    </div>
    <div class="report-panel-body"><div class="loan-proj-list">${items}</div></div>
  </div>`;
}

function renderHealthPanel(d) {
  const raw = d.paymentHealth || [];
  if (!raw.length) return '';
  const rows = sortRows(raw, state.reportHealthSort);
  const hsOpts = [
    ['month-asc','Month ↑'], ['month-desc','Month ↓'],
    ['rate-desc','Health ↓'], ['rate-asc','Health ↑'],
    ['missed-desc','Missed ↓'],
  ].map(([v, l]) => `<option value="${v}"${state.reportHealthSort === v ? ' selected' : ''}>${l}</option>`).join('');
  const barsHtml = rows.map(r => {
    const rate = r.rate || 0;
    const cls = rate >= 80 ? 'health-green' : rate >= 60 ? 'health-amber' : 'health-red';
    return `<div class="health-bar-row">
      <span class="health-month">${shortMonLabel(r.month)}</span>
      <div class="health-bar-track"><div class="health-bar-fill ${cls}" style="width:${rate}%"></div></div>
      <span class="health-stat">${r.paid}/${r.total}</span>
      <span class="health-pct ${cls}-text">${rate}%</span>
    </div>`;
  }).join('');
  const allMissed = [];
  rows.forEach(r => (r.missedItems || []).forEach(m => allMissed.push({ month: r.month, ...m })));
  const missedHtml = allMissed.length
    ? allMissed.map(m => `<div class="missed-item">
        <span class="missed-month">${shortMonLabel(m.month)}</span>
        <span class="missed-name">${escapeHtml(m.name)}</span>
        <span class="missed-payer">${escapeHtml(m.payer)}</span>
        <span class="missed-badge">missed</span>
      </div>`).join('')
    : '<div class="report-empty-ok">✓ No missed payments in this period</div>';
  return `<div class="report-panel">
    <div class="report-panel-header">
      <div class="rp-title">
        <svg class="rp-icon" viewBox="0 0 20 20"><path d="M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16Zm-1.5-5 5-5-1.5-1.5-3.5 3.5-1.5-1.5L7 11l1.5 2Z"/></svg>
        Payment Health
      </div>
      <div class="rp-header-right">
        <select class="panel-sort-select health-sort-select">${hsOpts}</select>
      </div>
    </div>
    <div class="report-panel-body health-layout">
      <div class="health-bars">${barsHtml}</div>
      <div class="health-missed">
        <div class="health-missed-title">Missed payments</div>
        ${missedHtml}
      </div>
    </div>
  </div>`;
}

async function saveCash(amount) {
  const amt = Math.max(0, Math.round(Number(String(amount).replace(/[^\d.]/g, '')) || 0));
  state.cash = amt;
  const loans = activeLoans();
  const totalDebt = loans.reduce((s, l) => s + (Number(l.currentBalance) || 0), 0);
  const net = amt - totalDebt;
  const netEl = document.querySelector('.bs-net');
  if (netEl) {
    netEl.textContent = (net >= 0 ? '+' : '−') + amdCompact(Math.abs(net));
    netEl.className = 'bs-value bs-net ' + (net >= 0 ? 'bs-net-pos' : 'bs-net-neg');
  }
  try {
    await callApi({ action: 'setCash', amount: amt });
  } catch (err) {
    showError('Could not save cash: ' + err.message);
  }
}

function renderBalancePanel() {
  const loans = activeLoans();
  const totalDebt = loans.reduce((s, l) => s + (Number(l.currentBalance) || 0), 0);
  const cashOnlyEntries = state.cashEntries.filter(e => !cashEntryIsOffer(e));
  const offerEntries = state.cashEntries.filter(e => cashEntryIsOffer(e));
  const cash = cashOnlyEntries.reduce((s, e) => s + (Number(e.amount) || 0), 0);
  const netPos = cash - totalDebt;
  const netIsPos = netPos >= 0;

  const creditLineObs = activeObs().filter(isCreditLine);
  const availableCredit = creditLineObs.reduce((s, o) => s + (Number(o.loanTotal) || 0), 0);
  const liquidFunds = cash + availableCredit;
  const totalOffers = offerEntries.reduce((s, e) => s + (Number(e.amount) || 0), 0);

  const cashDetail = cashOnlyEntries.length
    ? cashOnlyEntries.map(e => `<span class="bs-cash-item">${escapeHtml(e.place)}: ${amdCompact(Number(e.amount))}</span>`).join('')
    : `<span class="bs-no-cash"><button class="bs-link-btn" onclick="setIncomeSubTab('cash');switchTab('income')">Add cash →</button></span>`;
  const creditDetail = creditLineObs.map(o =>
    `<span class="bs-cash-item">${escapeHtml(o.bank)}: ${amdCompact(Number(o.loanTotal))}</span>`
  ).join('');
  const offerDetail = offerEntries.map(e =>
    `<span class="bs-cash-item">${escapeHtml(e.place)}: ${amdCompact(Number(e.amount))}</span>`
  ).join('');

  return `<div class="report-panel bs-panel">
    <div class="report-panel-header">
      <div class="rp-title">
        <svg class="rp-icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="2" y="5" width="16" height="11" rx="2"/><path d="M2 9h16M6 13h2"/></svg>
        Balance Sheet
      </div>
      <button class="rp-badge bs-manage-btn" onclick="setIncomeSubTab('cash');switchTab('income')">Manage →</button>
    </div>
    <div class="report-panel-body rp-pad">

      <div class="bs-section-label">Net Position</div>
      <div class="bs-row">
        <span class="bs-label">Cash on hand</span>
        <span class="bs-value">${amdCompact(cash)}</span>
      </div>
      <div class="bs-cash-breakdown">${cashDetail}</div>
      <div class="bs-row">
        <span class="bs-label">Total debt</span>
        <span class="bs-value bs-debt">${amdCompact(totalDebt)}</span>
      </div>
      <div class="bs-row bs-net-row">
        <span class="bs-label bs-net-label">Net position</span>
        <span class="bs-value bs-net ${netIsPos ? 'bs-net-pos' : 'bs-net-neg'}">${netIsPos ? '+' : '−'}${amdCompact(Math.abs(netPos))}</span>
      </div>

      <div class="bs-section-divider"></div>
      <div class="bs-section-label">Liquid Funds</div>
      <div class="bs-row">
        <span class="bs-label">Cash on hand</span>
        <span class="bs-value">${amdCompact(cash)}</span>
      </div>
      ${availableCredit > 0 ? `
      <div class="bs-row">
        <span class="bs-label">Credit lines</span>
        <span class="bs-value bs-credit">${amdCompact(availableCredit)}</span>
      </div>
      <div class="bs-cash-breakdown">${creditDetail}</div>` : ''}
      <div class="bs-row bs-net-row">
        <span class="bs-label bs-liquidity-label">Liquid funds</span>
        <span class="bs-value bs-liquidity">${amdCompact(liquidFunds)}</span>
      </div>

      <div class="bs-section-divider"></div>
      <div class="bs-section-label">Loan Offers</div>
      ${offerEntries.length ? `
      <div class="bs-cash-breakdown">${offerDetail}</div>
      <div class="bs-row bs-net-row">
        <span class="bs-label bs-liquidity-label">Total offers</span>
        <span class="bs-value bs-offer">${amdCompact(totalOffers)}</span>
      </div>` : `<div class="bs-row"><span class="bs-no-cash"><button class="bs-link-btn" onclick="setIncomeSubTab('cash');switchTab('income')">Add loan offer →</button></span></div>`}

    </div>
  </div>`;
}

function renderReportSummary(d) {
  const loans = activeLoans();
  const totalDebt = loans.reduce((s, l) => s + (Number(l.currentBalance) || 0), 0);
  const monthlyObl = activeObs().reduce((s, o) => s + (Number(o.amount) || 0), 0);
  const utils = state.utilities.filter(u => u.active === true || String(u.active).toUpperCase() === 'TRUE');
  const monthlyUtil = utils.reduce((s, u) => s + (Number(u.amount) || 0), 0);
  const monthlyTotal = monthlyObl + monthlyUtil;
  const cfData = d.cashFlow || [];
  const avgIncome = cfData.length ? Math.round(cfData.reduce((s, r) => s + (r.income || 0), 0) / cfData.length) : 0;
  const healthData = d.paymentHealth || [];
  const avgHealth = healthData.length
    ? Math.round(healthData.reduce((s, r) => s + (r.rate || 0), 0) / healthData.length * 10) / 10 : 0;
  const healthCls = avgHealth >= 80 ? 'rk-value-ok' : avgHealth >= 60 ? 'rk-value-warn' : 'rk-value-bad';

  return `<div class="report-kpi-row">
    <div class="report-kpi">
      <div class="rk-label">Monthly Obligations</div>
      <div class="rk-value">${amdCompact(monthlyTotal)}</div>
      <div class="rk-sub">${activeObs().length + utils.length} active items</div>
    </div>
    <div class="report-kpi">
      <div class="rk-label">Avg Monthly Income</div>
      <div class="rk-value">${amdCompact(avgIncome)}</div>
      <div class="rk-sub">over ${cfData.length} months</div>
    </div>
    <div class="report-kpi">
      <div class="rk-label">Total Debt</div>
      <div class="rk-value">${amdCompact(totalDebt)}</div>
      <div class="rk-sub">${loans.length} active loan${loans.length !== 1 ? 's' : ''}</div>
    </div>
    <div class="report-kpi">
      <div class="rk-label">Avg Payment Health</div>
      <div class="rk-value ${healthCls}">${avgHealth}%</div>
      <div class="rk-sub">over ${healthData.length} months</div>
    </div>
  </div>`;
}

function renderCategoryPanel() {
  const active = activeObs();
  const utils = state.utilities.filter(u => u.active === true || String(u.active).toUpperCase() === 'TRUE');
  if (!active.length && !utils.length) return '';

  const byCategory = {};
  const catMeta = {
    loan:     { label: 'Loans',     color: 'var(--primary)' },
    personal: { label: 'Personal',  color: 'var(--warning)' },
    credit:   { label: 'Credit',    color: 'var(--danger)'  },
    utility:  { label: 'Utilities', color: 'var(--success)' },
  };
  active.forEach(o => {
    const cat = String(o.category || 'other').toLowerCase().trim();
    if (!byCategory[cat]) byCategory[cat] = { ...( catMeta[cat] || { label: cat.charAt(0).toUpperCase() + cat.slice(1), color: 'var(--muted)' }), count: 0, total: 0 };
    byCategory[cat].count++;
    byCategory[cat].total += Number(o.amount) || 0;
  });
  if (utils.length) {
    if (!byCategory.utility) byCategory.utility = { ...catMeta.utility, count: 0, total: 0 };
    utils.forEach(u => { byCategory.utility.count++; byCategory.utility.total += Number(u.amount) || 0; });
  }

  const cats = Object.values(byCategory).sort((a, b) => b.total - a.total);
  const grandTotal = cats.reduce((s, c) => s + c.total, 0);
  if (!grandTotal) return '';

  const rows = cats.map(c => {
    const pct = Math.round((c.total / grandTotal) * 100);
    return `<div class="cat-row">
      <span class="cat-label">${escapeHtml(c.label)}</span>
      <div class="cat-bar-wrap"><div class="cat-bar" style="width:${pct}%;background:${c.color}"></div></div>
      <span class="cat-pct">${pct}%</span>
      <span class="cat-amount">${amdCompact(c.total)} <span class="cat-count">· ${c.count}</span></span>
    </div>`;
  }).join('');

  return `<div class="report-panel">
    <div class="report-panel-header">
      <div class="rp-title">
        <svg class="rp-icon" viewBox="0 0 20 20"><path d="M3 5h14M3 9h10M3 13h6"/></svg>
        Expense Breakdown
      </div>
      <div class="rp-badge">${amdCompact(grandTotal)}/mo</div>
    </div>
    <div class="report-panel-body rp-pad"><div class="cat-list">${rows}</div></div>
  </div>`;
}

function renderPayerPanel() {
  const all = activeObs();
  const utils = state.utilities.filter(u => u.active === true || String(u.active).toUpperCase() === 'TRUE');
  const colors = ['var(--primary)', '#7c3aed', '#0891b2', '#dc2626', '#d97706'];
  const byPayer = {};
  all.forEach(o => {
    const p = String(o.payer || '').trim(); if (!p) return;
    if (!byPayer[p]) byPayer[p] = { count: 0, total: 0 };
    byPayer[p].count++; byPayer[p].total += Number(o.amount) || 0;
  });
  utils.forEach(u => {
    const p = String(u.payer || '').trim(); if (!p) return;
    if (!byPayer[p]) byPayer[p] = { count: 0, total: 0 };
    byPayer[p].count++; byPayer[p].total += Number(u.amount) || 0;
  });

  const payerArr = Object.entries(byPayer).sort((a, b) => b[1].total - a[1].total);
  if (payerArr.length < 2) return '';
  const grandTotal = payerArr.reduce((s, [, v]) => s + v.total, 0);

  const rows = payerArr.map(([name, v], i) => {
    const pct = grandTotal > 0 ? Math.round((v.total / grandTotal) * 100) : 0;
    return `<div class="cat-row">
      <span class="cat-label">${escapeHtml(name)}</span>
      <div class="cat-bar-wrap"><div class="cat-bar" style="width:${pct}%;background:${colors[i % colors.length]}"></div></div>
      <span class="cat-pct">${pct}%</span>
      <span class="cat-amount">${amdCompact(v.total)} <span class="cat-count">· ${v.count}</span></span>
    </div>`;
  }).join('');

  return `<div class="report-panel">
    <div class="report-panel-header">
      <div class="rp-title">
        <svg class="rp-icon" viewBox="0 0 20 20"><path d="M13 6a3 3 0 1 1-6 0 3 3 0 0 1 6 0ZM5 18a5 5 0 0 1 10 0"/></svg>
        Per-Payer Breakdown
      </div>
      <div class="rp-badge">${payerArr.length} payers</div>
    </div>
    <div class="report-panel-body rp-pad"><div class="cat-list">${rows}</div></div>
  </div>`;
}

// ================================================================
// Boot
// ================================================================
document.addEventListener('DOMContentLoaded', () => {
  // Input-modality tracking: keyboard actions stay instant; pointer/touch actions may animate.
  const setKeyboardMode = event => {
    if (event.key === 'Tab' || event.key.startsWith('Arrow') || event.key === 'Enter' || event.key === ' ') {
      document.body.classList.add('using-keyboard');
    }
  };
  const setPointerMode = () => document.body.classList.remove('using-keyboard');
  document.addEventListener('keydown', setKeyboardMode, true);
  document.addEventListener('pointerdown', setPointerMode, true);
  document.addEventListener('touchstart', setPointerMode, { capture: true, passive: true });

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

  // Report period tabs
  document.getElementById('report-period-tabs').addEventListener('click', event => {
    const tab = event.target.closest('.rp-tab');
    if (!tab) return;
    const win = Number(tab.dataset.window);
    if (!win || win === state.reportWindow) return;
    state.reportWindow = win;
    document.querySelectorAll('#report-period-tabs .rp-tab').forEach(t =>
      t.classList.toggle('active', t === tab)
    );
    state.reportData = null;
    state.reportLoading = false;
    state.reportError = false;
    if (state.tab === 'reports') syncReports();
  });

  document.getElementById('btn-sync-reports').addEventListener('click', () => {
    state.reportData = null;
    state.reportLoading = false;
    state.reportError = false;
    if (state.tab === 'reports') syncReports();
  });

  // Report column sort (click on <th data-sp data-sc>)
  document.getElementById('page-reports').addEventListener('click', e => {
    const th = e.target.closest('[data-sp][data-sc]');
    if (!th) return;
    const sortStr = `${th.dataset.sc}-${th.dataset.sd}`;
    const panel = th.dataset.sp;
    if (panel === 'cf')   state.reportCfSort   = sortStr;
    if (panel === 'debt') state.reportDebtSort  = sortStr;
    if (state.tab === 'reports' && state.reportData) renderReports();
  });

  // Report dropdowns (payer, loan sort, health sort) — delegated on page-reports
  document.getElementById('page-reports').addEventListener('change', e => {
    if (e.target.matches('.report-payer-select')) {
      const v = e.target.value;
      if (v === state.reportPayer) return;
      state.reportPayer = v;
      state.reportData = null;
      state.reportLoading = false;
      state.reportError = false;
      if (state.tab === 'reports') syncReports();
      return;
    }
    if (e.target.matches('.loan-sort-select')) {
      state.reportLoanSort = e.target.value;
      if (state.tab === 'reports' && state.reportData) renderReports();
      return;
    }
    if (e.target.matches('.health-sort-select')) {
      state.reportHealthSort = e.target.value;
      if (state.tab === 'reports' && state.reportData) renderReports();
    }
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
    if (state.reportLoading) return;
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
