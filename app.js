'use strict';

// ================================================================
// State
// ================================================================
const state = {
  obligations: [],
  payments: {},   // "id__YYYY-MM" -> true/false
  paymentMeta: {},
  monthCache: {}, // "YYYY-MM" -> last raw API response (stale-while-revalidate)
  loanSnapshotIndex: {},
  reconSearch: '',
  reconBank: 'all',
  reconPayer: 'all',
  reconSortField: 'bank',
  reconSortDirection: 'asc',
  reconShowDone: false, // reconciled loans drop out of the list until toggled on
  income: [],
  loanHistory: [],
  utilities: [],
  partners: [],
  month: todayMonth(),
  tab: 'schedule',
  filter: 'all',
  statusFilter: 'unresolved',
  search: '',
  paymentType: 'all',
  paymentCategory: 'all',
  paymentBank: 'all',
  paymentFrequency: 'all',
  paymentBalanceStatus: 'all',
  paymentDueMin: '',
  paymentDueMax: '',
  paymentAmountMin: '',
  paymentAmountMax: '',
  paymentDebtMin: '',
  paymentDebtMax: '',
  paymentSortField: 'dueDay',
  paymentSortDirection: 'asc',
  loanSort: 'debt-desc',
  obligationSearch: '',
  obligationType: 'all',
  obligationPayer: 'all',
  obligationCategory: 'all',
  obligationBank: 'all',
  obligationFrequency: 'all',
  obligationPaymentStatus: 'all',
  obligationBalanceStatus: 'all',
  obligationDueMin: '',
  obligationDueMax: '',
  obligationAmountMin: '',
  obligationAmountMax: '',
  obligationDebtMin: '',
  obligationDebtMax: '',
  obligationSortField: 'currentBalance',
  obligationSortDirection: 'desc',
  incomeSort: 'date-desc',
  incomeSearch: '',
  incomeSourceFilter: 'all',
  incomeDateFrom: '',
  incomeDateTo: '',
  incomeScope: 'month',
  cashEntries: [],
  cashFilter: 'all',
  cashPayerFilter: 'all',
  cashPlaceFilter: 'all',
  cashSort: 'amount-desc',
  offerFilter: 'all',
  offerPayerFilter: 'all',
  offerPlaceFilter: 'all',
  offerSort: 'amount-desc',
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

const DATA_CACHE_PREFIX = 'finance-arm:month:';
const DATA_CACHE_MAX_AGE = 30 * 24 * 60 * 60 * 1000;
const monthRequests = new Map();
const monthFreshAt = {};
let dataRevision = 0;
let pendingWrites = 0;
let loadedMonth = '';
let appliedFingerprint = '';
let filterReturnFocus = null;
const reconDrafts = new Map();
const reconSaveTasks = new Set();
const reconSessionSaved = new Set();
let financialWriteQueue = Promise.resolve();
let toastTimer;
let reportSyncTask = null;
let reportSyncToken = 0;

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

function validMonthParam(value) {
  return /^\d{4}-\d{2}$/.test(String(value || ''));
}

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

function displayDueAmount(id, scheduled) {
  if (!isPartial(id)) return Number(scheduled);
  const paid = getPaidAmount(id);
  return paid !== null ? Math.max(0, Number(scheduled) - paid) : Number(scheduled);
}

function isPaymentResolved(id, month = state.month) {
  // Partial is intentionally NOT resolved — the card stays visible until paid in full.
  return ['paid', 'not_done', 'no_need'].includes(paymentStatus(id, month));
}

function activeObs() {
  return state.obligations.filter(o => o.active === true || String(o.active).toUpperCase() === 'TRUE');
}

function filteredObs() {
  let rows = dueThisMonth();
  if (state.filter !== 'all') rows = rows.filter(o => o.payer === state.filter);
  if (state.statusFilter === 'resolved') rows = rows.filter(o => isPaymentResolved(o.id));
  if (state.statusFilter === 'unresolved') rows = rows.filter(o => !isPaymentResolved(o.id));
  if (!['all', 'resolved', 'unresolved'].includes(state.statusFilter)) {
    rows = rows.filter(o => paymentStatus(o.id) === state.statusFilter);
  }
  if (state.search) {
    const needle = state.search.toLocaleLowerCase();
    rows = rows.filter(o =>
      [o.id, o.payer, o.bank, o.category, o.contractNumber, o.frequency,
       o.amount, o.dueDay, o.currentBalance, o.loanTotal, paymentStatus(o.id)]
        .some(value => String(value || '').toLocaleLowerCase().includes(needle))
    );
  }
  rows = rows.filter(o => {
    const loan = isLoanRecord(o);
    const balance = loan ? loanBalance(o) : null;
    const balanceKnown = balance !== '' && balance !== null && balance !== undefined && balance !== false;
    if (state.paymentType === 'loan' && !loan) return false;
    if (state.paymentType === 'other' && loan) return false;
    if (state.paymentCategory !== 'all' && String(o.category || '') !== state.paymentCategory) return false;
    if (state.paymentBank !== 'all' && normalizeBankName(o.bank) !== normalizeBankName(state.paymentBank) && String(o.bank || '') !== state.paymentBank) return false;
    if (state.paymentFrequency !== 'all' &&
        String(o.frequency || 'monthly') !== state.paymentFrequency) return false;
    if (state.paymentBalanceStatus !== 'all') {
      const matches = {
        owed: loan && balanceKnown && Number(balance) > 0,
        paid_off: loan && balanceKnown && Number(balance) === 0,
        current: loan && balanceKnown && balanceSourceMonth(o) === state.month,
        stale: loan && balanceKnown && balanceSourceMonth(o) !== state.month,
        unverified: loan && !balanceKnown,
        not_applicable: !loan
      };
      if (!matches[state.paymentBalanceStatus]) return false;
    }
    if (!numberInRange(o.dueDay, state.paymentDueMin, state.paymentDueMax)) return false;
    if (!numberInRange(o.amount, state.paymentAmountMin, state.paymentAmountMax)) return false;
    if ((state.paymentDebtMin !== '' || state.paymentDebtMax !== '') &&
        (!loan || !balanceKnown ||
         !numberInRange(balance, state.paymentDebtMin, state.paymentDebtMax))) return false;
    return true;
  });
  return rows;
}

function totalAmt(obs) {
  return obs.reduce((s, o) => s + Number(o.amount), 0);
}

function payerClass(p) {
  return p ? 'payer-accent' : '';
}

const PALETTE = ['#2563eb','#db2777','#16a34a','#d97706','#7c3aed','#0891b2','#9a3412','#475569'];

function formatAbonent(value) {
  return String(value ?? '').replace(/:$/, '').trim();
}

function abonentCopyButton(value) {
  const code = formatAbonent(value);
  if (!code || code.toLowerCase() === 'transfer') return '';
  const safe = escapeHtml(code);
  return `<button class="util-copy-btn util-copy-chip abonent-chip" type="button"
      onclick="copyAbonent('${safe}', this)"
      title="Copy ${safe}"
      aria-label="Copy abonent ${safe}">
      <code class="abonent-code-inner">${safe}</code>
      <span>Copy</span>
    </button>`;
}

function personalUtilsAsObs() {
  return activeUtils().filter(shouldShowUtilityInPayments).map(u => {
    const rawAbonent = formatAbonent(u.abonentNumber);
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

function utilitySearchText(u) {
  return [u.name, u.payer, u.provider, u.abonentNumber, u.type]
    .map(value => String(value || '').toLowerCase())
    .join(' ');
}

function isRealEstateUtility(u) {
  return /\b(real[_\s-]?estate|office|rent|tenant|unit)\b|օֆիս|վարձ/.test(utilitySearchText(u));
}

function isDepositCoveredUtility(u) {
  const text = utilitySearchText(u);
  return isRealEstateUtility(u) && (
    text.includes('deposit') ||
    text.includes('դեպոզիտ') ||
    text.includes('ավանդ') ||
    (isUtilFixed(u) && Number(u.amount || 0) <= 0)
  );
}

function shouldShowUtilityInPayments(u) {
  if (!isUtilPersonal(u)) return false;
  if (isDepositCoveredUtility(u)) return false;
  if (isUtilFixed(u) && Number(u.amount || 0) <= 0) return false;
  return true;
}

function payers() {
  const all = [...activeObs(), ...personalUtilsAsObs()];
  return [...new Set(all.map(o => String(o.payer || '').trim()).filter(Boolean))];
}

// Existing creditors, so new obligations reuse an exact name instead of a
// near-duplicate that would split the bank filter.
function creditors() {
  return [...new Set(activeObs().map(o => String(o.bank || '').trim()).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b));
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

// Sheets stores "2026-07" as a date, so it comes back as an ISO timestamp.
// At UTC+4 that is "2026-06-30T20:00:00.000Z" — parsing it locally recovers July.
// Accepts either form and always returns "YYYY-MM".
function toMonthKey(value) {
  if (value === null || value === undefined || value === '') return '';
  const str = String(value);
  if (/^\d{4}-\d{2}$/.test(str)) return str;
  const date = new Date(str);
  if (Number.isNaN(date.getTime())) return str;
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function loanSnapshot(id, month = state.month) {
  return state.loanSnapshotIndex[`${month}__${id}`] || null;
}

function loanBalance(loan, month = state.month) {
  const snapshot = loanSnapshot(loan.id, month);
  const snapshotValue = snapshot ? snapshot.currentBalance : null;
  const value = snapshotValue === '' || snapshotValue === null || snapshotValue === undefined
    ? loan.currentBalance
    : snapshotValue;
  return value === '' || value === null || value === undefined ? null : Number(value);
}

function balanceSourceMonth(loan, month = state.month) {
  const snapshot = loanSnapshot(loan.id, month);
  const snapshotValue = snapshot ? snapshot.currentBalance : null;
  const useSnapshot = snapshotValue !== '' && snapshotValue !== null && snapshotValue !== undefined;
  return toMonthKey((useSnapshot && snapshot && snapshot.balanceSourceMonth) || loan.balanceUpdatedMonth || '');
}

// When the balance was actually read. updateBalance always stamps the
// obligation itself, so trust that first — the month snapshot can lag behind it.
function balanceReadMonth(loan, month = state.month) {
  if (toMonthKey(loan.balanceUpdatedMonth) === month) return month;
  return balanceSourceMonth(loan, month);
}

const CASH_CATEGORIES = { cash: 'Cash', aparik: 'Ապառիկ', credit_line: 'Credit Line' };

// The category label is unreliable — the Add/Edit Obligation form has no
// dedicated "credit line" category, so these often get tagged 'loan' too.
// A credit facility with nothing currently drawn is available credit, not debt,
// regardless of what category it was filed under.
function isCreditLine(o) {
  return (Number(o.loanTotal) || 0) > 0 && (Number(o.currentBalance) || 0) === 0;
}

function isLoanRecord(obligation) {
  if (isCreditLine(obligation)) return false;
  return String(obligation.category).toLowerCase() === 'loan' ||
    Number(obligation.loanTotal) > 0 || Number(obligation.currentBalance) > 0;
}

function activeLoans() {
  return activeObs().filter(isLoanRecord);
}

// Quarterly obligations spread over 3 months, one-time items aren't recurring —
// summing raw .amount for every active obligation overstates true monthly cost.
function monthlyEquivalent(o) {
  const freq = String(o.frequency || 'monthly').toLowerCase().trim();
  const amt = Number(o.amount) || 0;
  if (freq === 'quarterly') return amt / 3;
  if (freq === 'one_time') return 0;
  return amt;
}

// Variable-rate utilities don't have a reliable fixed monthly amount —
// treat them the same way the Payments tab does (0 until a bill is entered).
function monthlyUtilAmount(u) {
  return isUtilFixed(u) ? (Number(u.amount) || 0) : 0;
}

function isObligationDueThisMonth(ob, month) {
  month = month || state.month;
  const freq = String(ob.frequency || 'monthly').toLowerCase().trim();
  if (!freq || freq === 'monthly') return true;
  if (freq === 'one_time') {
    const dueMon = toMonthKey(ob.startDate);
    return dueMon === month;
  }
  if (freq === 'quarterly') {
    const start = toMonthKey(ob.startDate);
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
function monthCacheKey(month) {
  return `${DATA_CACHE_PREFIX}${encodeURIComponent(API_URL)}:${month}`;
}

function readCachedMonth(month) {
  try {
    const raw = localStorage.getItem(monthCacheKey(month));
    if (!raw) return null;
    const cached = JSON.parse(raw);
    if (!cached || !cached.data || Date.now() - Number(cached.savedAt || 0) > DATA_CACHE_MAX_AGE) return null;
    return cached.data;
  } catch {
    return null;
  }
}

function writeCachedMonth(month, data) {
  try {
    localStorage.setItem(monthCacheKey(month), JSON.stringify({ savedAt: Date.now(), data }));
  } catch {
    /* storage can be full or disabled; the app still works without it */
  }
}

function invalidateCachedMonth(month = state.month) {
  delete state.monthCache[month];
  try {
    localStorage.removeItem(monthCacheKey(month));
  } catch {
    /* storage can be unavailable */
  }
}

async function callApi(params, options = {}) {
  const isWrite = params.action && !['all', 'getReportData'].includes(params.action);
  if (!isWrite) return requestApi(params, options);
  // A read started before a write must never overwrite the user's newer changes.
  dataRevision++;
  pendingWrites++;
  state.monthCache = {};
  Object.keys(monthFreshAt).forEach(month => delete monthFreshAt[month]);
  try {
    Object.keys(localStorage).filter(key => key.startsWith(DATA_CACHE_PREFIX)).forEach(key => localStorage.removeItem(key));
  } catch { /* storage is optional */ }
  setSyncStatus('saving', 'Saving changes...');
  try {
    const repeatable = ['setPayment', 'updateBalance'].includes(params.action);
    const send = () => requestApi(params, { ...options, retries: repeatable ? 1 : 0, timeout: options.timeout ?? 45000 });
    const task = repeatable ? financialWriteQueue.then(send) : send();
    if (repeatable) financialWriteQueue = task.catch(() => {});
    const result = await task;
    setSyncStatus(pendingWrites > 1 ? 'saving' : 'ready', pendingWrites > 1 ? 'Saving changes...' : 'Changes saved');
    return result;
  } catch (err) {
    setSyncStatus('error', 'Save failed. Try again');
    throw err;
  } finally {
    pendingWrites--;
    dataRevision++;
    if (!pendingWrites && loadedMonth !== state.month) revalidateMonth(state.month, true);
  }
}

async function requestApi(params, { retries = 1, timeout = 30000 } = {}) {
  const url = new URL(API_URL);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, String(v)));
  url.searchParams.set('_t', Date.now());

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const res = await fetch(url.toString(), { cache: 'no-store', signal: controller.signal });
      if (!res.ok) throw Object.assign(new Error(`Server returned ${res.status}`), { retryable: res.status >= 500 || res.status === 429 });
      const json = await res.json();
      if (json.error) throw Object.assign(new Error(json.error), { retryable: /lock|timed out|try again|too many times/i.test(json.error) });
      if (['setPayment', 'updateBalance'].includes(params.action) && json.success !== true) {
        throw Object.assign(new Error('The server did not confirm the save. Refresh to check its status.'), { retryable: false });
      }
      if (params.action && !['all', 'getReportData', 'repairSchema'].includes(params.action)) {
        invalidateCachedMonth(validMonthParam(params.month) ? params.month : state.month);
      }
      return json;
    } catch (err) {
      clearTimeout(timer);
      if (attempt < retries && err.retryable !== false) {
        await new Promise(r => setTimeout(r, 1500));
        continue;
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}

// Apply a raw "all" API response into state and re-render.
function applyAllData(data) {
  const fingerprint = JSON.stringify([state.month, data.obligations, data.payments, data.income, data.loanHistory, data.utilities, data.cashEntries, data.partners]);
  loadedMonth = state.month;
  document.body.classList.remove('month-pending');
  if (fingerprint === appliedFingerprint) return;
  appliedFingerprint = fingerprint;
  state.obligations = data.obligations || [];
  state.payments = {};
  state.paymentMeta = {};
  (data.payments || []).forEach(p => {
    state.payments[p.key] = (p.paid === true || String(p.paid).toUpperCase() === 'TRUE');
    state.paymentMeta[p.key] = p;
  });
  state.income = data.income || [];
  state.loanHistory = data.loanHistory || [];
  state.loanSnapshotIndex = {};
  state.loanHistory.forEach(row => {
    state.loanSnapshotIndex[`${toMonthKey(row.month)}__${row.obligationId}`] = row;
  });
  state.utilities = (data.utilities || []).map(u => ({
    ...u,
    abonentNumber: formatAbonent(u.abonentNumber)
  }));
  state.cashEntries = data.cashEntries || [];
  state.partners = data.partners || [];
  renderPayerFilters();
  render();
}

async function fetchAll() {
  return revalidateMonth(state.month, true);
}

async function togglePayment(id) {
  const status = paymentStatus(id);
  if (status === 'paid' || status === 'partial') return setPaymentStatus(id, 'unpaid');
  return setPaymentStatus(id, 'paid');
}

async function setPaymentStatus(id, status) {
  return setPaymentWithAmount(id, status, null);
}


/** Futuristic neon "done" frame — then optional card vanish */
function playNeonDoneFx(el, { label = 'DONE', vanish = true } = {}) {
  return new Promise(resolve => {
    if (!el || !el.isConnected) {
      resolve();
      return;
    }
    // Avoid stacking
    el.querySelectorAll('.neon-fx-overlay').forEach(n => n.remove());
    el.classList.add('neon-fx-active', 'neon-fx-pulse');
    el.style.pointerEvents = 'none';

    const overlay = document.createElement('div');
    overlay.className = 'neon-fx-overlay';
    overlay.setAttribute('aria-hidden', 'true');
    overlay.innerHTML = `
      <div class="neon-fx-frame"></div>
      <div class="neon-fx-frame neon-fx-frame--outer"></div>
      <div class="neon-fx-grid"></div>
      <div class="neon-fx-scan"></div>
      <div class="neon-fx-sparks">
        <i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i>
      </div>
      <div class="neon-fx-stamp"><span>${escapeHtml(label)}</span></div>
    `;
    if (getComputedStyle(el).position === 'static') el.style.position = 'relative';
    el.appendChild(overlay);

    const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const hold = reduce ? 200 : 950;
    const exitMs = reduce ? 180 : 560;

    setTimeout(() => {
      if (!el.isConnected) {
        resolve();
        return;
      }
      if (vanish) {
        el.classList.add('neon-fx-exit');
        setTimeout(() => {
          if (el.isConnected) el.remove();
          resolve();
        }, exitMs);
      } else {
        el.classList.remove('neon-fx-pulse', 'neon-fx-active');
        el.style.pointerEvents = '';
        overlay.remove();
        resolve();
      }
    }, hold);
  });
}

function neonLabelForStatus(status) {
  return ({
    paid: 'PAID',
    partial: 'PARTIAL',
    not_done: 'SKIPPED',
    no_need: 'NO NEED'
  })[status] || 'DONE';
}

function shouldVanishPaymentCard(status) {
  // Default Payments view hides resolved items
  if (state.search) return false;
  if (state.statusFilter === 'unresolved') {
    return ['paid', 'not_done', 'no_need'].includes(status);
  }
  return false;
}

async function setPaymentWithAmount(id, status, paidAmt) {
  const paymentMonth = state.month;
  const key = pkey(id, state.month);
  invalidateCachedMonth(state.month); // this month's cached snapshot is now stale
  const previousPaid = !!state.payments[key];
  const previousMeta = state.paymentMeta[key] ? { ...state.paymentMeta[key] } : null;
  const paid = status === 'paid';
  const resolved = paid || status === 'partial';
  const cardEl = document.querySelector(`[data-payment-id="${CSS.escape(String(id))}"]`);
  const celebrate = ['paid', 'partial', 'not_done', 'no_need'].includes(status);
  const vanish = celebrate && shouldVanishPaymentCard(status);

  state.payments[key] = paid;
  state.paymentMeta[key] = {
    key, paid, status,
    paidAmount: paidAmt !== null ? paidAmt : '',
    completedAt: resolved ? new Date().toISOString() : '',
    updatedAt: new Date().toISOString()
  };

  const toasts = {
    paid: 'Payment completed.',
    partial: `Partial payment of ${amd(paidAmt)} recorded.`,
    not_done: 'Marked as did not pay.',
    no_need: 'Marked no need.'
  };

  // Save immediately in parallel with neon FX (do not wait for animation)
  const savePromise = callApi({
    action: 'setPayment', key, paid, status, month: state.month,
    paidAmount: paidAmt !== null ? paidAmt : ''
  }).then(result => {
    if (toasts[status]) showToast(toasts[status]);
    state.paymentMeta[key] = {
      key, paid,
      status: result.status || status,
      paidAmount: result.paidAmount !== undefined ? result.paidAmount : (paidAmt ?? ''),
      completedAt: result.completedAt || '',
      updatedAt: new Date().toISOString()
    };
    if (!pendingWrites && state.month === paymentMonth && loadedMonth === paymentMonth) {
      const data = {
        obligations: state.obligations, payments: Object.values(state.paymentMeta),
        income: state.income, loanHistory: state.loanHistory,
        utilities: state.utilities, cashEntries: state.cashEntries
      };
      state.monthCache[paymentMonth] = data;
      writeCachedMonth(paymentMonth, data);
    }
    return result;
  }).catch(err => {
    state.payments[key] = previousPaid;
    if (previousMeta) state.paymentMeta[key] = previousMeta;
    else delete state.paymentMeta[key];
    showError(`Save could not be confirmed: ${err.message}. Refresh to check before retrying.`);
    throw err;
  });

  try {
    if (celebrate && cardEl) {
      if (!vanish) patchPaymentEl(id);
      await playNeonDoneFx(cardEl, {
        label: neonLabelForStatus(status),
        vanish
      });
      if (vanish && state.month === paymentMonth) renderSchedule();
      else if (!vanish) patchPaymentEl(id);
    } else {
      patchPaymentEl(id);
    }
    await savePromise;
  } catch (err) {
    // Revert UI if save failed (FX may have removed the card)
    renderCurrentTab();
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

  // Done/Paid button (card view) — partial keeps a primary "Pay rest" button.
  const doneBtn = el.querySelector('.payment-done');
  if (doneBtn) {
    doneBtn.textContent = paid ? 'Paid ✓' : status === 'partial' ? 'Pay rest' : 'Paid';
    doneBtn.classList.toggle('button-primary', !paid);
    doneBtn.classList.toggle('button-secondary', paid);
    doneBtn.setAttribute('onclick', paid
      ? `setPaymentStatus('${id}', 'unpaid')`
      : `setPaymentStatus('${id}', 'paid')`);
  }

  // Partial button — hide once fully paid
  const partialBtn = el.querySelector('.payment-partial-btn');
  if (partialBtn) partialBtn.style.display = paid ? 'none' : '';

  // Amount display — show remaining when partial
  const ob = state.obligations.find(o => String(o.id) === String(id))
           || personalUtilsAsObs().find(u => String(u.id) === String(id));
  if (ob && Number(ob.amount) > 0) {
    const amtEl = el.querySelector('.payment-card-amount strong, .payment-basic-meta strong, .util-pay-amount');
    if (amtEl) amtEl.textContent = amd(displayDueAmount(id, ob.amount));
  }

  // Balance line (loan card) — read-only, reflects current balance
  const balLine = el.querySelector('.payment-balance-line span:last-child');
  if (balLine && ob) {
    const balRaw = loanBalance(ob);
    const balKnown = balRaw !== '' && balRaw !== null && balRaw !== undefined && balRaw !== false;
    balLine.textContent = `Balance: ${balKnown ? amd(Number(balRaw)) : '—'}`;
  }

  // Partial info
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
  renderPaymentOverview(all, obs);
  if (state.tab === 'schedule' && !obs.some(o => String(o.id) === String(id))) {
    el.remove();
    if (!obs.length) renderSchedule();
  }
}

// ================================================================
// Reconcile — monthly balance entry, one bank app at a time.
// Saves in place (never re-renders) so typing is never interrupted.
// ================================================================
function reconBankOf(l) { return String(l.bank || 'Other'); }

function filteredReconLoans() {
  let rows = activeLoans();
  // Reconciled loans drop out of the list — that is the whole point at 70 loans.
  if (!state.reconShowDone) rows = rows.filter(l => balanceReadMonth(l) !== state.month || reconSessionSaved.has(pkey(l.id, state.month)));
  if (state.reconBank !== 'all') rows = rows.filter(l => reconBankOf(l) === state.reconBank);
  if (state.reconPayer !== 'all') rows = rows.filter(l => String(l.payer || '') === state.reconPayer);
  if (state.reconSearch) {
    const needle = state.reconSearch.toLocaleLowerCase();
    rows = rows.filter(l =>
      [l.bank, l.payer, l.contractNumber, l.loanTotal, l.amount]
        .some(v => String(v || '').toLocaleLowerCase().includes(needle))
    );
  }
  return rows.sort((a, b) => {
    const av = obligationSortValue(a, state.reconSortField);
    const bv = obligationSortValue(b, state.reconSortField);
    const missingA = av === null || av === undefined || av === '';
    const missingB = bv === null || bv === undefined || bv === '';
    if (missingA !== missingB) return missingA ? 1 : -1;
    const difference = typeof av === 'number' && typeof bv === 'number'
      ? av - bv : String(av ?? '').localeCompare(String(bv ?? ''), undefined, { numeric: true, sensitivity: 'base' });
    return difference * (state.reconSortDirection === 'asc' ? 1 : -1);
  });
}

function hideSavedRecon() {
  reconSessionSaved.clear();
  state.reconShowDone = false;
  renderReconcile();
}

function activeReconFilterCount() {
  return [
    state.reconSearch,
    state.reconBank !== 'all',
    state.reconPayer !== 'all'
  ].filter(Boolean).length;
}

function clearReconFilters() {
  state.reconSearch = '';
  state.reconBank = 'all';
  state.reconPayer = 'all';
  state.reconShowDone = false;
  renderReconcile();
}

function syncReconControls() {
  const map = {
    'recon-search': state.reconSearch,
    'recon-bank': state.reconBank,
    'recon-payer': state.reconPayer,
    'recon-sort-field': state.reconSortField,
    'recon-sort-direction': state.reconSortDirection
  };
  Object.entries(map).forEach(([id, value]) => {
    const el = q(id);
    if (el && el.value !== value) el.value = value;
  });
  const toggle = q('recon-show-done');
  if (toggle) toggle.checked = state.reconShowDone;
}

function syncReconFilterOptions(all) {
  const uniq = values => [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b));
  fillReconSelect('recon-bank', 'All banks', uniq(all.map(reconBankOf)), 'reconBank');
  fillReconSelect('recon-payer', 'All payers', uniq(all.map(l => String(l.payer || ''))), 'reconPayer');
}

function fillReconSelect(id, allLabel, values, stateKey) {
  const sel = q(id);
  if (!sel) return;
  let vals = values.map(v => normalizeBankName(v)).filter(Boolean);
  if (isBankFilterSelect(id)) vals = [...vals, ...allBankEntries().map(b => b.name)];
  vals = [...new Set(vals)].sort((a, b) => a.localeCompare(b));
  if (!vals.includes(state[stateKey]) && state[stateKey] !== 'all') state[stateKey] = 'all';
  sel.innerHTML = [`<option value="all">${allLabel}</option>`]
    .concat(vals.map(v => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`))
    .join('');
  sel.value = state[stateKey];
  if (isBankFilterSelect(id)) syncBankPicker(id, allLabel);
}

function renderReconcile() {
  const container = q('recon-container');
  if (!container) return;
  const all = activeLoans();
  syncReconFilterOptions(all);
  syncReconControls();
  updateFilterBadge('recon', activeReconFilterCount());

  if (!all.length) {
    container.innerHTML = '<div class="empty-state">No active loans to reconcile.</div>';
    updateReconProgress();
    return;
  }

  const loans = filteredReconLoans();
  const hidden = state.reconShowDone ? 0 : all.filter(l => balanceReadMonth(l) === state.month).length;
  const intro = `
    <div class="recon-intro">
      <div class="recon-bar"><div class="recon-bar-fill" id="recon-bar-fill"></div></div>
      <p class="recon-hint">
        <span id="recon-results-count">${reconResultsText(all, loans)}</span>
        <br>Type the remaining balance, then Save or press Enter. Cards update as you confirm each loan.
      </p>
    </div>`;

  if (!loans.length) {
    const noFilters = !state.reconSearch && state.reconBank === 'all' && state.reconPayer === 'all';
    container.innerHTML = `${intro}
      <div class="empty-state">
        ${hidden && noFilters
          ? `All ${all.length} loans reconciled for ${monthLabel(state.month)}.`
          : 'No loans match these filters.'}
      </div>`;
    updateReconProgress();
    return;
  }

  const groups = Object.create(null);
  loans.forEach(l => {
    const group = state.reconSortField === 'bank' ? reconBankOf(l) : 'Filtered loans';
    (groups[group] = groups[group] || []).push(l);
  });

  container.innerHTML = intro + Object.keys(groups).map(bank => {
    const inBank = state.reconSortField === 'bank' ? all.filter(l => reconBankOf(l) === bank) : loans;
    const done = inBank.filter(l => balanceReadMonth(l) === state.month).length;
    return `<section class="recon-group" data-bank="${escapeHtml(bank)}">
      <header class="recon-group-head">
        <h2 class="recon-group-title">${bankAvatarHtml(bank, 'offer-avatar--sm')}<span>${escapeHtml(bank)}</span></h2>
        <span class="recon-group-count">${done}/${inBank.length}</span>
      </header>
      ${groups[bank].map(reconRow).join('')}
    </section>`;
  }).join('');

  updateReconProgress();
}

function reconRow(l) {
  const id = escapeHtml(l.id);
  const prev = loanBalance(l);
  const src = balanceReadMonth(l);
  const done = src === state.month;
  const contracts = contractParts(l.contractNumber);
  const draft = reconDrafts.get(pkey(l.id, state.month));
  const saving = reconSaveTasks.has(pkey(l.id, state.month));
  const bank = l.bank || 'Bank';
  return `<div class="recon-row recon-glass-card ${done ? 'is-done' : ''} ${saving ? 'is-saving' : ''}" data-recon-id="${id}" ${saving ? 'aria-busy="true"' : ''}>
    <div class="recon-glass-main">
      <div class="recon-id">
        <div class="recon-glass-title">
          ${bankAvatarHtml(bank)}
          <div class="recon-glass-text">
            <div class="recon-name" style="color:${payerColor(l.payer)}">${escapeHtml(l.payer || '—')}</div>
            <div class="recon-sub">
              <span class="recon-bank-label">${escapeHtml(bank)}</span>
              ${contracts.length ? contracts.map(part => copyChip(part)).join('')
                                 : '<span class="recon-nocontract">no contract</span>'}
              ${Number(l.loanTotal) > 0 ? `<span class="recon-initial">${amd(l.loanTotal)} initial</span>` : ''}
              ${Number(l.amount) > 0 ? `<span>${amd(l.amount)}/mo</span>` : ''}
            </div>
          </div>
        </div>
      </div>
      <div class="recon-prev-wrap">
        <span class="recon-prev-label">Last saved</span>
        <span class="recon-prev">${prev !== null ? amd(prev) : '—'}</span>
        <span class="recon-prev-when">${src ? monthLabel(src) : 'never read'}</span>
      </div>
      <div class="recon-entry">
        <label class="recon-entry-label" for="recon-input-${id}">New balance</label>
        <input class="recon-input" id="recon-input-${id}" type="number" inputmode="numeric" min="0"
               aria-label="Remaining balance for ${escapeHtml(l.payer || '')} at ${escapeHtml(l.bank || '')}"
               value="${escapeHtml(draft?.value ?? (done && prev !== null ? String(prev) : ''))}" ${saving ? 'disabled' : ''}
               placeholder="${prev !== null ? prev : 'balance'}"
               onfocus="this.select()"
               oninput="reconcileDelta('${id}', this)"
               onkeydown="reconcileKey(event, '${id}', this)">
        <span class="recon-delta ${draft?.status === 'error' ? 'is-up' : ''}" id="recon-delta-${id}" role="status">${saving ? 'Saving...' : draft?.status === 'error' ? 'Not confirmed. Retry or refresh.' : draft ? 'Not saved' : done ? 'Saved' : ''}</span>
      </div>
      <div class="recon-actions">
        <button class="button button-primary recon-save" id="recon-save-${id}" type="button" ${saving ? 'disabled' : ''}
                onclick="reconcileSave('${id}', q('recon-input-${id}'))">${saving ? 'Saving...' : draft?.status === 'error' ? 'Retry' : 'Save'}</button>
        <button class="button button-ghost recon-keep" type="button" ${saving ? 'disabled' : ''}
                onclick="reconcileKeep('${id}')" title="Fill in the last saved balance">Use last</button>
      </div>
    </div>
  </div>`;
}

function updateReconProgress() {
  const loans = activeLoans();
  const done = loans.filter(l => balanceReadMonth(l) === state.month).length;
  const label = q('recon-progress');
  if (label) label.textContent = `${done} / ${loans.length} done`;
  const fill = q('recon-bar-fill');
  if (fill) fill.style.width = loans.length ? `${Math.round(done / loans.length * 100)}%` : '0%';
}

function reconcileDelta(id, input) {
  reconDrafts.set(pkey(id, state.month), { value: input.value, status: 'draft' });
  const save = q('recon-save-' + id);
  if (save) { save.disabled = false; save.textContent = 'Save'; }
  const el = q('recon-delta-' + id);
  if (!el) return;
  const loan = state.obligations.find(o => String(o.id) === String(id));
  const prev = loan ? loanBalance(loan) : null;
  const raw = String(input.value).trim();
  if (raw === '' || prev === null) { el.textContent = ''; el.className = 'recon-delta'; return; }
  const val = Number(raw);
  if (!isFinite(val)) { el.textContent = ''; el.className = 'recon-delta'; return; }
  const diff = val - prev;
  if (diff === 0) { el.textContent = 'Unchanged. Click Save to confirm.'; el.className = 'recon-delta is-flat'; return; }
  el.textContent = `Not saved: ${diff < 0 ? '−' : '+'}${amd(Math.abs(diff))}`;
  el.className = 'recon-delta ' + (diff < 0 ? 'is-down' : 'is-up');
}

function reconcileKey(event, id, input) {
  if (event.key !== 'Enter') return;
  event.preventDefault();
  const inputs = Array.from(document.querySelectorAll('.recon-input'));
  const next = inputs[inputs.indexOf(input) + 1];
  reconcileSave(id, input);
  if (next) { next.focus(); next.select(); } else input.blur();
}

function reconcileKeep(id) {
  const loan = state.obligations.find(o => String(o.id) === String(id));
  const cur = loan ? loanBalance(loan) : null;
  if (cur === null) { showError('No previous balance to keep — enter one.'); return; }
  const input = q('recon-input-' + id);
  if (!input) return;
  input.value = cur;
  reconcileDelta(id, input);
  input.focus();
}

async function reconcileSave(id, input) {
  if (!input) return;
  const month = state.month;
  const key = pkey(id, month);
  if (reconSaveTasks.has(key)) return;
  const raw = String(input.value).trim();
  if (raw === '') { showError('Enter a balance before saving.'); return; }
  const val = Number(raw);
  if (!isFinite(val) || val < 0) { showError('Enter a valid balance.'); return; }

  const loan = state.obligations.find(o => String(o.id) === String(id));
  if (!loan) return;
  reconDrafts.set(key, { value: raw, status: 'saving' });
  reconSaveTasks.add(key);
  updateReconSaveState(id, 'saving');

  try {
    await callApi({ action: 'updateBalance', id, balance: val, month });
    reconDrafts.delete(key);
    reconSessionSaved.add(key);
    if (state.month === month) {
      const currentLoan = state.obligations.find(o => String(o.id) === String(id));
      if (currentLoan) { currentLoan.currentBalance = val; currentLoan.balanceUpdatedMonth = month; }
      let snap = loanSnapshot(id, month);
      if (!snap) {
        snap = { obligationId: id, month };
        state.loanHistory.push(snap);
        state.loanSnapshotIndex[`${month}__${id}`] = snap;
      }
      snap.currentBalance = val;
      snap.balanceSourceMonth = month;
      updateReconSaveState(id, 'saved', val);
      updateReconGroupCount(reconBankOf(loan));
      updateReconResultsCount();
      updateReconProgress();
    }
  } catch (err) {
    reconDrafts.set(key, { value: raw, status: 'error' });
    if (state.month === month) updateReconSaveState(id, 'error');
    showError(`Balance save could not be confirmed: ${err.message}. Your entry is kept.`);
  } finally {
    reconSaveTasks.delete(key);
  }
}

function updateReconSaveState(id, status, balance) {
  const input = q('recon-input-' + id);
  const row = input?.closest('.recon-row');
  if (!row) return;
  const saving = status === 'saving';
  row.classList.toggle('is-saving', saving);
  if (saving) row.setAttribute('aria-busy', 'true'); else row.removeAttribute('aria-busy');
  input.disabled = saving;
  row.querySelectorAll('.recon-actions button').forEach(button => { button.disabled = saving; });
  const save = q('recon-save-' + id);
  save.textContent = saving ? 'Saving...' : status === 'saved' ? 'Saved' : 'Retry';
  save.disabled = saving || status === 'saved';
  const delta = q('recon-delta-' + id);
  delta.textContent = saving ? 'Waiting for confirmation...' : status === 'saved' ? 'Saved to worksheet' : 'Not confirmed. Retry or refresh.';
  delta.className = 'recon-delta ' + (status === 'saved' ? 'is-saved' : status === 'error' ? 'is-up' : '');
  if (status === 'saved') {
    row.classList.add('is-done');
    row.querySelector('.recon-prev').textContent = amd(balance);
    row.querySelector('.recon-prev-when').textContent = monthLabel(state.month);
  }
}

function updateReconGroupCount(bank) {
  const groupName = state.reconSortField === 'bank' ? bank : 'Filtered loans';
  const group = document.querySelector(`.recon-group[data-bank="${CSS.escape(groupName)}"]`);
  if (!group) return;
  const inBank = state.reconSortField === 'bank' ? activeLoans().filter(l => reconBankOf(l) === bank) : filteredReconLoans();
  const done = inBank.filter(l => balanceReadMonth(l) === state.month).length;
  const count = group.querySelector('.recon-group-count');
  if (count) count.textContent = `${done}/${inBank.length}`;
}

function reconResultsText(all, loans) {
  const hidden = state.reconShowDone ? 0 : all.filter(l => balanceReadMonth(l) === state.month && !reconSessionSaved.has(pkey(l.id, state.month))).length;
  return `Showing ${loans.length} of ${all.length} loans${hidden ? ` · ${hidden} reconciled hidden` : ''}`;
}

function updateReconResultsCount() {
  const el = q('recon-results-count');
  if (el) el.textContent = reconResultsText(activeLoans(), filteredReconLoans());
}

// Once saved, a reconciled loan slides out — what's left on screen is what's left to do.
function reconRetireRow(row, bank) {
  row.classList.add('is-leaving');
  setTimeout(() => {
    const group = row.closest('.recon-group');
    row.remove();
    if (group && !group.querySelector('.recon-row')) group.remove();
    if (!document.querySelector('.recon-row')) { renderReconcile(); return; }
    updateReconGroupCount(bank);
    updateReconResultsCount();
    updateReconProgress();
  }, 260);
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
      String(s.obligationId) === String(id) && toMonthKey(s.month) === state.month
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
  q('add-ob-bank').setAttribute('list', 'add-ob-bank-list');
  q('add-ob-bank-list').innerHTML = creditors().map(b => `<option value="${escapeHtml(b)}">`).join('');
  q('add-ob-startdate-row').classList.add('hidden');
  q('add-ob-startdate').required = false;
  q('add-ob-modal').classList.remove('hidden');
  q('add-ob-bank').focus();
  wireBankPickers(q('add-ob-modal') || document);
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
      bank: normalizeBankName(v('bank')),
      category: v('category'),
      amount: Number(v('amount')) || 0,
      dueDay: Number(v('dueDay')) || 0,
      startDate: v('startDate') || '',
      frequency: v('frequency'),
      currentBalance: v('currentBalance') === '' ? '' : Number(v('currentBalance')),
      loanTotal: v('loanTotal') === '' ? '' : Number(v('loanTotal')),
      contractNumber: v('contractNumber').trim()
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
  const card = button.closest('.loan-card, .obligation-card, article');
  try {
    await callApi({ action: 'completeLoan', id, month: state.month });
    const loan = state.obligations.find(o => String(o.id) === String(id));
    if (loan) {
      loan.active = false;
      loan.currentBalance = 0;
      loan.completedAt = new Date().toISOString();
    }
    if (card) {
      await playNeonDoneFx(card, { label: 'COMPLETE', vanish: true });
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
  return revalidateMonth(state.month, true);
}

// Refresh a month in the background without a full-screen skeleton.
// Only repaints if the user is still viewing that month when it returns.
async function revalidateMonth(month, force = false) {
  if (pendingWrites) return;
  if (!force && Date.now() - (monthFreshAt[month] || 0) < 60000) return;
  const requestKey = `${month}:${dataRevision}`;
  if (monthRequests.has(requestKey)) return monthRequests.get(requestKey);
  const revision = dataRevision;
  const hasUsableMonth = loadedMonth === month;
  if (!hasUsableMonth) setSyncStatus('loading', 'Loading this month...');
  const task = (async () => {
    try {
      const data = await callApi({ action: 'all', month });
      if (revision !== dataRevision || pendingWrites) return;
      state.monthCache[month] = data;
      monthFreshAt[month] = Date.now();
      writeCachedMonth(month, data);
      if (state.month !== month) return;
      const editing = loadedMonth === month && (
        [...reconDrafts.keys()].some(key => key.endsWith('__' + month)) ||
        document.activeElement?.matches('input, textarea, select, [contenteditable="true"]') ||
        document.querySelector('.modal-backdrop:not(.hidden), .pay-panel:not(.hidden)')
      );
      if (editing) {
        setSyncStatus('ready', 'Update ready. Tap to refresh');
      } else {
        applyAllData(data);
        setSyncStatus('ready', 'Up to date');
      }
    } catch (err) {
      if (state.month !== month || revision !== dataRevision) return;
      setSyncStatus('error', loadedMonth === month ? 'Saved view. Tap to retry' : 'Could not load. Tap to retry');
      if (loadedMonth !== month) showError('Could not load this month. Use the refresh button to retry.');
    } finally {
      monthRequests.delete(requestKey);
      if (state.month === month) {
        showLoading(false);
        const syncButton = q('sync-button');
        if (syncButton?.dataset.status === 'loading') {
          setSyncStatus(loadedMonth === month ? 'ready' : 'error', loadedMonth === month ? 'Up to date' : 'Could not load. Tap to retry');
        }
      }
    }
  })();
  monthRequests.set(requestKey, task);
  return task;
}

function setSyncStatus(status, label) {
  document.querySelectorAll('.header-sync, #sync-button').forEach(button => {
    button.dataset.status = status;
    button.disabled = status === 'saving';
    button.title = label || 'Refresh data';
  });
  const statusLabel = q('sync-status');
  if (statusLabel) statusLabel.textContent = label;
}

function toggleMobileNav(open) {
  const menu = q('mobile-menu');
  const button = q('mobile-more-button');
  if (!menu) return;
  const shouldOpen = open ?? menu.classList.contains('hidden');
  menu.classList.toggle('hidden', !shouldOpen);
  if (button) button.setAttribute('aria-expanded', String(shouldOpen));
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
  clearTimeout(toastTimer);
  const el = document.getElementById('error-toast');
  el.textContent = msg;
  el.classList.remove('hidden', 'is-success');
  el.classList.add('is-error');
  toastTimer = setTimeout(() => el.classList.add('hidden'), 9000);
}

function showToast(msg) {
  clearTimeout(toastTimer);
  const el = q('error-toast');
  el.textContent = msg;
  el.classList.remove('hidden', 'is-error');
  el.classList.add('is-success');
  toastTimer = setTimeout(() => el.classList.add('hidden'), 2200);
}

// ================================================================
// URL routing -- each tab (and the Reports period sub-tab) gets its own
// address, so a direct link or a page refresh lands back on the same view.
// ================================================================
const VALID_TABS = ['schedule', 'loans', 'reconcile', 'income', 'cash', 'offers', 'utilities', 'partners', 'reports'];

function parseRoute() {
  const raw = (location.hash || '').replace(/^#\/?/, '');
  const [tabPart, subPart] = raw.split('/');
  const tab = VALID_TABS.includes(tabPart) ? tabPart : null;
  return { tab, sub: subPart || '' };
}

function routeHash(tab, sub) {
  return sub ? `#${tab}/${sub}` : `#${tab}`;
}

function updateUrlForTab(tab, sub = '') {
  const hash = routeHash(tab, sub);
  if (location.hash !== hash) history.replaceState(null, '', hash);
}

function activateTab(tab) {
  state.tab = tab;
  document.querySelectorAll('.sidebar-nav a').forEach(a => {
    a.classList.toggle('active', a.dataset.tab === tab);
    if (a.dataset.tab === tab) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  q('mobile-more-button')?.classList.toggle('active', ['cash', 'offers', 'reconcile', 'utilities', 'partners', 'reports'].includes(tab));
  document.querySelectorAll('.page').forEach(p =>
    p.classList.toggle('active', p.id === 'page-' + tab)
  );
}

function ensureUiUnlocked() {
  // Never allow a stale overlay/inert state to make the whole app unclickable.
  try {
    document.body.classList.remove('filter-drawer-open');
    document.body.classList.remove('is-loading');
    const appEl = document.querySelector('.app');
    if (appEl) {
      appEl.inert = false;
      appEl.removeAttribute('inert');
    }
    const drawer = q('filter-drawer');
    if (drawer) drawer.inert = true;
    document.querySelectorAll('.modal-backdrop:not(.hidden)').forEach(m => m.classList.add('hidden'));
  } catch (_) { /* ignore */ }
}

function switchTab(tab) {
  ensureUiUnlocked();
  toggleMobileNav(false);
  activateTab(tab);
  updateUrlForTab(tab, tab === 'reports' ? String(state.reportWindow) : '');
  renderCurrentTab();
}

function renderCurrentTab() {
  updateMonthLabels();
  if (loadedMonth !== state.month) return;
  switch (state.tab) {
    case 'schedule':   renderSchedule();   break;
    case 'loans':      renderLoans(); wireBankPickers(document); break;
    case 'reconcile':  renderReconcile();  break;
    case 'income':     renderIncome();     break;
    case 'cash':       renderCash(); wireBankPickers(document); break;
    case 'offers':     renderOffers(); wireBankPickers(document); break;
    case 'utilities':  renderUtilities();  break;
    case 'partners':   renderPartnersTab(); break;
    case 'reports':    renderDashboard();  renderReports();  break;
  }
}

function render() { updateMonthLabels(); renderCurrentTab(); }

function updateMonthLabels() {
  document.querySelectorAll('.month-label').forEach(el => {
    el.textContent = monthLabel(state.month);
  });
  refreshHeaderToggles();
}

const HEADER_STATE_KEY = 'finance-arm:headers';

function readHeaderStates() {
  try { return JSON.parse(localStorage.getItem(HEADER_STATE_KEY) || '{}') || {}; }
  catch (err) { return {}; }
}

function isPageHeaderOpen(pageId) {
  return readHeaderStates()[pageId] === 'open';
}

function setPageHeaderOpen(pageId, open) {
  const all = readHeaderStates();
  if (open) all[pageId] = 'open';
  else delete all[pageId];
  try { localStorage.setItem(HEADER_STATE_KEY, JSON.stringify(all)); } catch (err) { /* ignore */ }
}

function pageHeaderTitle(page) {
  return page.querySelector('.page-header h1')?.textContent?.trim() || 'Menu';
}

function refreshHeaderToggles() {
  document.querySelectorAll('.page > .page-header').forEach(header => {
    const page = header.parentElement;
    const btn = header.querySelector('.header-toggle');
    if (!btn || !page) return;
    const open = isPageHeaderOpen(page.id);
    page.classList.toggle('header-open', open);
    page.classList.toggle('header-closed', !open);
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    const month = page.querySelector('.month-label')?.textContent || '';
    btn.innerHTML = `<span class="ht-orb" aria-hidden="true"></span>
      <span class="ht-copy"><span class="ht-kicker">${open ? 'Hide controls' : 'Open controls'}</span>
      <span class="header-toggle-title">${escapeHtml(pageHeaderTitle(page))}</span></span>
      <span class="header-toggle-meta">${escapeHtml(month)}</span>
      <span class="header-toggle-chev" aria-hidden="true"></span>`;
  });
}

function togglePageHeader(pageId) {
  setPageHeaderOpen(pageId, !isPageHeaderOpen(pageId));
  refreshHeaderToggles();
}

function initCollapsibleHeaders() {
  document.querySelectorAll('.page > .page-header').forEach(header => {
    const page = header.parentElement;
    if (!page || header.querySelector('.header-rail')) return;
    const rail = document.createElement('div');
    rail.className = 'header-rail';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'header-toggle';
    btn.addEventListener('click', () => togglePageHeader(page.id));
    const sync = document.createElement('button');
    sync.type = 'button';
    sync.className = 'header-sync';
    sync.title = 'Refresh data';
    sync.innerHTML = `<span class="sync-dot" aria-hidden="true"></span>
      <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M16 8a6 6 0 1 0 0 5M16 3v5h-5"/></svg>`;
    sync.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      refreshData(false).catch(() => {});
    });
    rail.append(btn, sync);
    header.insertBefore(rail, header.firstChild);
  });
  if (!q('sync-status')) {
    const live = document.createElement('span');
    live.id = 'sync-status';
    live.className = 'sr-only';
    live.setAttribute('role', 'status');
    live.setAttribute('aria-live', 'polite');
    document.body.appendChild(live);
  }
  refreshHeaderToggles();
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
  const all = dueThisMonth();
  syncPaymentFilterOptions(all);
  const obs = sortPayments(filteredObs());
  const paymentResults = q('payment-results-count');
  const paymentFilterCount = q('payment-filter-count');
  if (paymentResults) paymentResults.textContent = `Showing ${obs.length} of ${all.length} payments`;
  if (paymentFilterCount) {
    const count = activePaymentFilterCount();
    paymentFilterCount.textContent = count ? `(${count} active)` : '';
    updateFilterBadge('payment', count);
  }
  const board = q('payments-board');
  if (board) {
    board.innerHTML = obs.length ? obs.map(paymentCard).join('') : `
      <div class="empty-state payment-empty">
        ${state.statusFilter === 'unresolved' && !state.search
          ? `All payments done for ${monthLabel(state.month)}`
          : 'No payments match these filters.'}
      </div>`;

    const allResolved = all.filter(o => isPaymentResolved(o.id));
    const visResolved = obs.filter(o => isPaymentResolved(o.id));
    q('sched-total').textContent = amd(totalAmt(obs));
    q('sched-count').textContent = `${visResolved.length}/${obs.length}`;
    q('sched-grand').textContent = `Total: ${amd(totalAmt(all))} · ${allResolved.length}/${all.length} resolved`;
    renderPaymentOverview(all, obs);
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
    ${state.statusFilter === 'unresolved' && !state.search
      ? `All payments done for ${monthLabel(state.month)} ✓`
      : 'No payments match these filters.'}
  </td></tr>`;

  const allResolved2 = all.filter(o => isPaymentResolved(o.id));
  const visResolved2 = obs.filter(o => isPaymentResolved(o.id));

  q('sched-total').textContent  = amd(totalAmt(obs));
  q('sched-count').textContent  = `${visResolved2.length}/${obs.length}`;
  q('sched-grand').textContent  = `Total: ${amd(totalAmt(all))} · ${allResolved2.length}/${all.length} resolved`;
}

function renderPaymentOverview(all, visible) {
  const unresolved = all.filter(o => !isPaymentResolved(o.id));
  const remaining = unresolved.reduce((sum, o) => sum + Math.max(0, displayDueAmount(o.id, Number(o.amount) || 0)), 0);
  const resolved = all.length - unresolved.length;
  const percent = all.length ? Math.round(resolved / all.length * 100) : 0;
  const loans = activeLoans();
  let unknown = 0, stale = 0;
  const debt = loans.reduce((sum, loan) => {
    const balance = loanBalance(loan);
    if (balance === '' || balance == null || balance === false || !Number.isFinite(Number(balance))) { unknown++; return sum; }
    if (balanceSourceMonth(loan) !== state.month) stale++;
    return sum + Number(balance);
  }, 0);
  q('overview-remaining').textContent = amd(remaining);
  q('overview-caption').textContent = unresolved.length ? `${unresolved.length} payments still to resolve` : all.length ? 'Everything is taken care of.' : 'No payments scheduled this month.';
  q('overview-debt').textContent = loans.length && unknown === loans.length ? 'Not verified' : amd(debt);
  q('overview-debt-note').textContent = unknown ? `${unknown} unverified balances excluded` : stale ? `Includes ${stale} earlier balances` : 'Balances verified this month';
  q('overview-resolved').textContent = `${resolved} of ${all.length}`;
  q('overview-percent').textContent = `${percent}%`;
  q('completion-orbit').style.setProperty('--completion', `${percent}%`);
  q('sched-grand').textContent = `${visible.length} shown of ${all.length} scheduled`;
  q('sched-count').textContent = 'Scheduled in this view';
  q('payment-results-count').textContent = `Showing ${visible.length} of ${all.length} payments`;
  if (document.body.classList.contains('filter-drawer-open') && !q('drawer-payment-filters').classList.contains('hidden')) {
    q('filter-results-count').textContent = q('payment-results-count').textContent;
  }
  const search = q('payment-quick-search');
  if (document.activeElement !== search) search.value = state.search;
  const quickSort = q('payment-quick-sort');
  const sort = `${state.paymentSortField}:${state.paymentSortDirection}`;
  quickSort.value = [...quickSort.options].some(option => option.value === sort) ? sort : 'custom';
  syncShowCompletedToggle();
}

function paymentCard(o, index) {
  if (o.category === 'utility') return utilityPaymentCard(o, index);
  return isLoanRecord(o) ? loanPaymentCard(o, index) : standardPaymentCard(o, index);
}

// One consistent action row shared by every payment card type so the
// buttons are always the same set, order, and place.
function paymentActionsRow(o, isUtility) {
  const id = escapeHtml(o.id);
  const paid = isPaid(o.id);
  const status = paymentStatus(o.id);
  const editFn = isUtility ? `openUtilEdit('${id}')` : `openLoanEditor('${id}')`;
  return `<div class="payment-basic-actions payment-actions-row">
      <button class="button ${paid ? 'button-secondary' : 'button-primary'} payment-done" type="button"
              onclick="${paid ? `setPaymentStatus('${id}', 'unpaid')` : `setPaymentStatus('${id}', 'paid')`}">
        ${paid ? 'Paid ✓' : status === 'partial' ? 'Pay rest' : 'Paid'}
      </button>
      ${!paid ? `<button class="button button-ghost payment-partial-btn" type="button"
              onclick="openPaymentPanel('${id}')">Partial</button>` : ''}
      <button class="button button-ghost loan-edit-toggle" type="button"
              onclick="${editFn}">Edit</button>
      <button class="button button-secondary payment-not-done" type="button"
              onclick="setPaymentStatus('${id}', 'not_done')">Did not pay</button>
      <button class="button button-ghost payment-no-need" type="button"
              onclick="setPaymentStatus('${id}', 'no_need')">No need</button>
    </div>`;
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

  return `<article class="util-pay-card payment-glass-card row-reveal ${paid ? 'is-paid' : ''} is-${status.replace('_','-')} ${urgency}"
                  data-payment-id="${escapeHtml(o.id)}"
                  style="--payer-color:${payerColor(o.payer)};animation-delay:${revealDelay}ms">
    <div class="util-pay-body">
      <div class="util-pay-info">
        <div class="payment-bank-row">
          ${bankAvatarHtml(o.provider || o.bank || 'U')}
          <div class="payment-bank-text">
            <div class="payment-basic-payer" style="color:var(--payer-color)">${escapeHtml(o.payer)}</div>
            <div class="util-pay-name">${escapeHtml(o.bank)}
              <span class="badge utility" style="vertical-align:middle">utility</span>
              ${paymentStatusBadge(status)}
            </div>
          </div>
        </div>
        <div class="util-pay-sub">
          ${o.provider ? `<span>${escapeHtml(o.provider)}</span>` : ''}
          ${showAbonent ? abonentCopyButton(o.abonentNumber).replace('util-copy-btn util-copy-chip', 'copy-chip') : ''}
          ${resolved && completedAt ? `<time class="payment-card-time">${paid ? 'Paid' : 'Recorded'} ${formatTimestamp(completedAt)}</time>` : ''}
        </div>
      </div>
      <div class="util-pay-actions">
        ${Number(o.amount) > 0 ? `<strong class="util-pay-amount">${amd(displayDueAmount(o.id, o.amount))}</strong>` : ''}
        ${dueDay > 0 ? `<span class="util-pay-due">Day ${dueDay}</span>` : ''}
      </div>
    </div>
    ${buildPartialInfo(o.id, o) || '<div class="partial-info" style="display:none"></div>'}
    <div class="payment-card-mid-spacer" aria-hidden="true"></div>
    ${paymentActionsRow(o, true)}
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

  return `<article class="payment-loan-card payment-glass-card row-reveal ${paid ? 'is-paid' : ''} is-${status.replace('_', '-')} ${staleBalance ? 'is-stale' : ''}"
                  data-payment-id="${escapeHtml(o.id)}"
                  style="--payer-color:${payerColor(o.payer)};animation-delay:${revealDelay}ms">
    <div class="payment-card-head">
      <div class="payment-card-title">
        <div class="payment-bank-row">
          ${bankAvatarHtml(o.bank || 'Loan')}
          <div class="payment-bank-text">
            <h2>${escapeHtml(o.bank || 'Loan')}</h2>
            <div class="payment-payer-line">${escapeHtml(o.payer || '')}</div>
          </div>
        </div>
        <div class="loan-contract-inline">${contracts.length ? contracts.map(part => copyChip(part)).join('') : '<span class="contract-empty">No contract</span>'}</div>
      </div>
      <div class="payment-card-amount">
        <strong>${Number(o.amount) > 0 ? amd(displayDueAmount(o.id, o.amount)) : '—'}</strong>
        <span>/month${Number(o.dueDay) > 0 ? ` · due ${Number(o.dueDay)}` : ''}</span>
      </div>
    </div>
    ${paymentStatusBadge(status)}
    <div class="payment-progress">
      <div class="payment-progress-bar">
        <div class="payment-progress-fill" style="width:${pct}%"></div>
      </div>
      <div class="payment-progress-labels">
        <span>${balKnown && total ? `${pct}% paid off` : 'Balance not verified'}</span>
        <span>Total: ${total ? amd(total) : '—'}</span>
      </div>
      <div class="payment-progress-labels payment-balance-line">
        <span></span>
        <span>Balance: ${balKnown ? amd(bal) : '—'}</span>
      </div>
      ${paid && completedAt ? `<time class="payment-card-time">Paid ${formatTimestamp(completedAt)}</time>` : ''}
    </div>
    ${buildPartialInfo(o.id, o) || '<div class="partial-info" style="display:none"></div>'}
    <div class="payment-card-mid-spacer" aria-hidden="true"></div>
    ${paymentActionsRow(o)}
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

  return `<article class="payment-basic-card payment-glass-card row-reveal ${paid ? 'is-paid' : ''} is-${status.replace('_', '-')} ${urgency}"
                  data-payment-id="${escapeHtml(o.id)}"
                  style="--payer-color:${payerColor(o.payer)};animation-delay:${revealDelay}ms">
    <div class="payment-basic-head">
      <div>
        <div class="payment-bank-row">
          ${bankAvatarHtml(o.bank)}
          <div class="payment-bank-text">
            <div class="payment-basic-payer" style="color:var(--payer-color)">${escapeHtml(o.payer)}</div>
            <h2>${escapeHtml(o.bank)}</h2>
          </div>
        </div>
        <span class="badge ${escapeHtml(o.category)}">${escapeHtml(o.category)}</span>
        ${paymentStatusBadge(status)}
      </div>
      <div class="payment-basic-meta">
        <strong>${Number(o.amount) > 0 ? amd(displayDueAmount(o.id, o.amount)) : '—'}</strong>
        <span>${Number(o.dueDay) > 0 ? `Due day ${o.dueDay}` : 'No due day'}</span>
        ${resolved && completedAt ? `<time class="payment-card-time">${paid ? 'Paid' : 'Recorded'} ${formatTimestamp(completedAt)}</time>` : ''}
      </div>
    </div>
    ${buildPartialInfo(o.id, o) || '<div class="partial-info" style="display:none"></div>'}
    <div class="payment-card-mid-spacer" aria-hidden="true"></div>
    ${paymentActionsRow(o)}
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
  const field = state.paymentSortField;
  const direction = state.paymentSortDirection === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const av = paymentSortValue(a, field);
    const bv = paymentSortValue(b, field);
    const aMissing = av === null || av === undefined || av === '';
    const bMissing = bv === null || bv === undefined || bv === '';
    if (aMissing !== bMissing) return aMissing ? 1 : -1;
    if (typeof av === 'number' && typeof bv === 'number') {
      const difference = (av - bv) * direction;
      if (difference) return difference;
    } else {
      const difference = String(av).localeCompare(String(bv), undefined, {
        numeric: true,
        sensitivity: 'base'
      }) * direction;
      if (difference) return difference;
    }
    return String(a.bank || '').localeCompare(String(b.bank || ''), undefined, {
      numeric: true,
      sensitivity: 'base'
    });
  });
}

function paymentSortValue(o, field) {
  switch (field) {
    case 'amount': return Number(o.amount) || 0;
    case 'dueDay': return o.dueDay === '' || o.dueDay === null || o.dueDay === undefined
      ? null : Number(o.dueDay);
    case 'currentBalance': return isLoanRecord(o) ? loanBalance(o) : null;
    case 'loanTotal': return isLoanRecord(o) ? Number(o.loanTotal) || 0 : null;
    case 'paymentStatus': return paymentStatus(o.id);
    case 'startDate': return o.startDate ? new Date(o.startDate).getTime() || null : null;
    default: return String(o[field] || '');
  }
}

function syncPaymentFilterOptions(rows) {
  state.paymentCategory = setObligationSelectOptions(
    'payment-category', rows.map(o => o.category), 'All categories', state.paymentCategory
  );
  state.paymentBank = setObligationSelectOptions(
    'payment-bank', rows.map(o => o.bank), 'All banks / payees', state.paymentBank
  );
}

function activePaymentFilterCount() {
  return [
    state.search,
    state.filter !== 'all',
    state.paymentType !== 'all',
    state.statusFilter !== 'unresolved',
    state.paymentCategory !== 'all',
    state.paymentBank !== 'all',
    state.paymentFrequency !== 'all',
    state.paymentBalanceStatus !== 'all',
    state.paymentDueMin,
    state.paymentDueMax,
    state.paymentAmountMin,
    state.paymentAmountMax,
    state.paymentDebtMin,
    state.paymentDebtMax
  ].filter(Boolean).length;
}

function clearPaymentFilters() {
  state.search = '';
  state.filter = 'all';
  state.paymentType = 'all';
  state.statusFilter = 'unresolved';
  state.paymentCategory = 'all';
  state.paymentBank = 'all';
  state.paymentFrequency = 'all';
  state.paymentBalanceStatus = 'all';
  state.paymentDueMin = '';
  state.paymentDueMax = '';
  state.paymentAmountMin = '';
  state.paymentAmountMax = '';
  state.paymentDebtMin = '';
  state.paymentDebtMax = '';
  syncPaymentControls();
  q('payer-filters').querySelectorAll('.pill').forEach(p =>
    p.classList.toggle('active', p.dataset.filter === 'all')
  );
  renderSchedule();
}

function syncPaymentControls() {
  const values = {
    'schedule-search': state.search,
    'payment-type': state.paymentType,
    'payment-status': state.statusFilter,
    'payment-category': state.paymentCategory,
    'payment-bank': state.paymentBank,
    'payment-frequency': state.paymentFrequency,
    'payment-balance-status': state.paymentBalanceStatus,
    'payment-due-min': state.paymentDueMin,
    'payment-due-max': state.paymentDueMax,
    'payment-amount-min': state.paymentAmountMin,
    'payment-amount-max': state.paymentAmountMax,
    'payment-debt-min': state.paymentDebtMin,
    'payment-debt-max': state.paymentDebtMax,
    'payment-sort-field': state.paymentSortField,
    'payment-sort-direction': state.paymentSortDirection
  };
  Object.entries(values).forEach(([id, value]) => {
    const control = q(id);
    if (control) control.value = value;
  });
  syncShowCompletedToggle();
}

function syncShowCompletedToggle() {
  const toggle = q('show-completed');
  if (!toggle) return;
  toggle.checked = !['unresolved', 'unpaid'].includes(state.statusFilter);
}

function formatTimestamp(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('en-US', {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
  });
}

function jumpToPayment(id) {
  clearPaymentFilters();
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
  const allRows = activeObs();
  syncObligationFilterOptions(allRows);
  const filteredRows = sortObligations(filterObligations(allRows));
  const loans = filteredRows.filter(isLoanRecord);
  const nonLoans = filteredRows.filter(o => !isLoanRecord(o));
  const totalDebt = loans.reduce((sum, loan) => sum + Number(loanBalance(loan) || 0), 0);
  const resultsCount = q('obligation-results-count');
  const filterCount = q('obligation-filter-count');
  if (resultsCount) {
    resultsCount.textContent = `Showing ${filteredRows.length} of ${allRows.length} active obligations`;
  }
  if (filterCount) {
    const count = activeObligationFilterCount();
    filterCount.textContent = count ? `(${count} active)` : '';
    updateFilterBadge('obligation', count);
  }

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
      <span>${filteredRows.length} result${filteredRows.length !== 1 ? 's' : ''} · ${loans.length} loan${loans.length !== 1 ? 's' : ''} · ${nonLoans.length} other</span>
      <strong>${amd(totalDebt)} total debt</strong>
    </div>
    ${filteredRows.length
      ? loansSection + nonLoansSection
      : '<div class="obligation-empty"><strong>No obligations match these filters.</strong><span>Adjust or clear the filters to see more results.</span></div>'}
  `;
}

function filterObligations(rows) {
  const search = state.obligationSearch.toLocaleLowerCase();
  return rows.filter(o => {
    const isLoan = isLoanRecord(o);
    const status = paymentStatus(o.id);
    const balance = isLoan ? loanBalance(o) : null;
    const balanceKnown = balance !== '' && balance !== null && balance !== undefined && balance !== false;
    const sourceMonth = isLoan ? balanceSourceMonth(o) : '';

    if (search) {
      const searchable = [
        o.id, o.payer, o.bank, o.category, o.amount, o.dueDay,
        o.currentBalance, o.loanTotal, o.contractNumber, o.startDate,
        o.balanceUpdatedMonth, o.completedAt, o.updatedAt, o.frequency,
        status, isLoan ? 'loan' : 'other'
      ];
      if (!searchable.some(value => String(value ?? '').toLocaleLowerCase().includes(search))) {
        return false;
      }
    }

    if (state.obligationType === 'loan' && !isLoan) return false;
    if (state.obligationType === 'other' && isLoan) return false;
    if (state.obligationPayer !== 'all' && String(o.payer || '') !== state.obligationPayer) return false;
    if (state.obligationCategory !== 'all' && String(o.category || '') !== state.obligationCategory) return false;
    if (state.obligationBank !== 'all' && normalizeBankName(o.bank) !== normalizeBankName(state.obligationBank) && String(o.bank || '') !== state.obligationBank) return false;
    if (state.obligationFrequency !== 'all' &&
        String(o.frequency || 'monthly') !== state.obligationFrequency) return false;

    if (state.obligationPaymentStatus === 'resolved' && !isPaymentResolved(o.id)) return false;
    if (state.obligationPaymentStatus === 'unresolved' && isPaymentResolved(o.id)) return false;
    if (!['all', 'resolved', 'unresolved'].includes(state.obligationPaymentStatus) &&
        status !== state.obligationPaymentStatus) return false;

    if (state.obligationBalanceStatus !== 'all') {
      const balanceStateMatches = {
        owed: isLoan && balanceKnown && Number(balance) > 0,
        paid_off: isLoan && balanceKnown && Number(balance) === 0,
        current: isLoan && balanceKnown && sourceMonth === state.month,
        stale: isLoan && balanceKnown && sourceMonth !== state.month,
        unverified: isLoan && !balanceKnown,
        not_applicable: !isLoan
      };
      if (!balanceStateMatches[state.obligationBalanceStatus]) return false;
    }

    if (!numberInRange(o.dueDay, state.obligationDueMin, state.obligationDueMax)) return false;
    if (!numberInRange(o.amount, state.obligationAmountMin, state.obligationAmountMax)) return false;
    if ((state.obligationDebtMin !== '' || state.obligationDebtMax !== '') &&
        (!isLoan || !balanceKnown ||
         !numberInRange(balance, state.obligationDebtMin, state.obligationDebtMax))) return false;

    return true;
  });
}

function numberInRange(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min === '' && max === '';
  if (min !== '' && number < Number(min)) return false;
  if (max !== '' && number > Number(max)) return false;
  return true;
}

function obligationSortValue(o, field) {
  switch (field) {
    case 'currentBalance': return isLoanRecord(o) ? loanBalance(o) : null;
    case 'amount': return Number(o.amount) || 0;
    case 'loanTotal': return isLoanRecord(o) ? Number(o.loanTotal) || 0 : null;
    case 'dueDay': return o.dueDay === '' || o.dueDay === null || o.dueDay === undefined
      ? null : Number(o.dueDay);
    case 'startDate': return o.startDate ? new Date(o.startDate).getTime() || null : null;
    case 'balanceUpdatedMonth': return isLoanRecord(o) ? balanceSourceMonth(o) : '';
    case 'paymentStatus': return paymentStatus(o.id);
    default: return String(o[field] || '');
  }
}

function sortObligations(rows) {
  const field = state.obligationSortField;
  const direction = state.obligationSortDirection === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const av = obligationSortValue(a, field);
    const bv = obligationSortValue(b, field);
    const aMissing = av === null || av === undefined || av === '';
    const bMissing = bv === null || bv === undefined || bv === '';
    if (aMissing !== bMissing) return aMissing ? 1 : -1;

    if (typeof av === 'number' && typeof bv === 'number') {
      const difference = (av - bv) * direction;
      if (difference) return difference;
    } else {
      const difference = String(av).localeCompare(String(bv), undefined, {
        numeric: true,
        sensitivity: 'base'
      }) * direction;
      if (difference) return difference;
    }
    return String(a.bank || '').localeCompare(String(b.bank || ''), undefined, {
      numeric: true,
      sensitivity: 'base'
    });
  });
}

function syncObligationFilterOptions(rows) {
  state.obligationPayer = setObligationSelectOptions(
    'obligation-payer',
    rows.map(o => o.payer),
    'All payers',
    state.obligationPayer
  );
  state.obligationCategory = setObligationSelectOptions(
    'obligation-category',
    rows.map(o => o.category),
    'All categories',
    state.obligationCategory
  );
  state.obligationBank = setObligationSelectOptions(
    'obligation-bank',
    rows.map(o => o.bank),
    'All banks / payees',
    state.obligationBank
  );
}

function setObligationSelectOptions(id, values, allLabel, selectedValue) {
  const select = q(id);
  if (!select) return selectedValue;
  let source = values.map(value => String(value || '').trim()).filter(Boolean).map(normalizeBankName);
  // Bank/place filters always include full catalog so every bank is selectable
  if (isBankFilterSelect(id)) {
    source = source.concat(allBankEntries().map(b => b.name));
  }
  const options = [...new Set(source)]
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
  const validValue = selectedValue === 'all' || options.includes(selectedValue) ? selectedValue : 'all';
  select.innerHTML = `<option value="all">${allLabel}</option>` +
    options.map(value => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`).join('');
  select.value = validValue;
  if (isBankFilterSelect(id)) syncBankPicker(id, allLabel);
  return validValue;
}

const BANK_FILTER_SELECTS = new Set([
  'payment-bank', 'obligation-bank', 'recon-bank', 'cash-place', 'offer-place'
]);

function isBankFilterSelect(id) {
  return BANK_FILTER_SELECTS.has(id);
}

function syncBankPicker(selectId, allLabel) {
  const select = q(selectId);
  if (!select) return;
  select.classList.add('filter-bank-select-hidden');
  let list = q(selectId + '-list');
  if (!list) {
    list = document.createElement('div');
    list.id = selectId + '-list';
    list.className = 'filter-bank-list';
    list.setAttribute('role', 'listbox');
    list.setAttribute('aria-label', allLabel || 'Banks');
    const field = select.closest('.filter-field') || select.parentElement;
    if (field) field.appendChild(list);
    else select.insertAdjacentElement('afterend', list);
  }
  const options = [...select.options];
  list.innerHTML = options.map(opt => {
    const val = opt.value;
    const active = val === select.value ? ' is-active' : '';
    const logo = val === 'all'
      ? `<div class="offer-avatar offer-avatar--sm offer-avatar--all" aria-hidden="true">All</div>`
      : bankAvatarHtml(val, 'offer-avatar--sm');
    return `<button type="button" class="filter-bank-option${active}" role="option" aria-selected="${val === select.value}" data-value="${escapeHtml(val)}" onclick="pickBankFilter('${selectId}', this.getAttribute('data-value'))">
      ${logo}
      <span class="filter-bank-option-label">${escapeHtml(opt.textContent)}</span>
      <span class="filter-bank-option-check" aria-hidden="true"></span>
    </button>`;
  }).join('');
}

function pickBankFilter(selectId, value) {
  const select = q(selectId);
  if (!select) return;
  select.value = value;
  select.dispatchEvent(new Event('change', { bubbles: true }));
  syncBankPicker(selectId);
}

function activeObligationFilterCount() {
  return [
    state.obligationSearch,
    state.obligationType !== 'all',
    state.obligationPayer !== 'all',
    state.obligationCategory !== 'all',
    state.obligationBank !== 'all',
    state.obligationFrequency !== 'all',
    state.obligationPaymentStatus !== 'all',
    state.obligationBalanceStatus !== 'all',
    state.obligationDueMin,
    state.obligationDueMax,
    state.obligationAmountMin,
    state.obligationAmountMax,
    state.obligationDebtMin,
    state.obligationDebtMax
  ].filter(Boolean).length;
}

function clearObligationFilters() {
  state.obligationSearch = '';
  state.obligationType = 'all';
  state.obligationPayer = 'all';
  state.obligationCategory = 'all';
  state.obligationBank = 'all';
  state.obligationFrequency = 'all';
  state.obligationPaymentStatus = 'all';
  state.obligationBalanceStatus = 'all';
  state.obligationDueMin = '';
  state.obligationDueMax = '';
  state.obligationAmountMin = '';
  state.obligationAmountMax = '';
  state.obligationDebtMin = '';
  state.obligationDebtMax = '';
  syncObligationControls();
  renderLoans();
}

function syncObligationControls() {
  const values = {
    'obligation-search': state.obligationSearch,
    'obligation-type': state.obligationType,
    'obligation-payer': state.obligationPayer,
    'obligation-category': state.obligationCategory,
    'obligation-bank': state.obligationBank,
    'obligation-frequency': state.obligationFrequency,
    'obligation-payment-status': state.obligationPaymentStatus,
    'obligation-balance-status': state.obligationBalanceStatus,
    'obligation-due-min': state.obligationDueMin,
    'obligation-due-max': state.obligationDueMax,
    'obligation-amount-min': state.obligationAmountMin,
    'obligation-amount-max': state.obligationAmountMax,
    'obligation-debt-min': state.obligationDebtMin,
    'obligation-debt-max': state.obligationDebtMax,
    'obligation-sort-field': state.obligationSortField,
    'obligation-sort-direction': state.obligationSortDirection
  };
  Object.entries(values).forEach(([id, value]) => {
    const control = q(id);
    if (control) control.value = value;
  });
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

  return `<article class="loan-card loan-glass-card ${!balKnown ? 'is-unverified' : ''} ${paidOff ? 'is-paid-off' : ''}"
                   style="--bank-color:${bankColor}">
    <div class="loan-card-top">
      <div class="loan-identity">
        ${bankAvatarHtml(o.bank, 'bank-avatar')}
        <div>
          <div class="loan-bank">${escapeHtml(o.bank)}</div>
          <div class="loan-meta">${escapeHtml(o.payer)}${o.startDate ? ` · Started ${fmtStartDate(o.startDate)}` : ''}</div>
        </div>
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
    <div class="loan-card-actions">
      ${paidOff ? '<span class="paid-off-badge">Paid off</span>' : ''}
      <button class="button button-secondary loan-complete" type="button"
              onclick="completeLoan('${escapeHtml(o.id)}', this)">Complete</button>
      <button class="button button-ghost loan-edit-toggle" type="button"
              onclick="openLoanEditor('${escapeHtml(o.id)}')">Edit</button>
      <button class="button btn-delete-ghost" type="button"
              onclick="confirmDeleteObligation('${escapeHtml(o.id)}')">Delete</button>
    </div>
    <form class="inline-loan-edit hidden" id="inline-edit-${escapeHtml(o.id)}"
          onsubmit="submitInlineLoanEdit(event, '${escapeHtml(o.id)}')">
      <label class="bank-picker-label-wrap">Bank / Payee${bankPickerHtml({ nameAttr: "bank", value: o.bank, required: true, placeholder: "Select bank…" })}</label>
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
  return `<article class="obligation-card loan-glass-card" style="--bank-color:${bankColor}">
    <div class="loan-card-top">
      <div class="loan-identity">
        ${bankAvatarHtml(o.bank, 'bank-avatar')}
        <div>
          <div class="loan-bank">${escapeHtml(o.bank)}</div>
          <div class="loan-meta">${escapeHtml(o.payer)} · ${escapeHtml(catDisplay)}</div>
        </div>
      </div>
    </div>
    <div class="obligation-details">
      <span class="ob-amount">${Number(o.amount) > 0 ? amd(Number(o.amount)) : '—'}</span>
      ${Number(o.dueDay) > 0 ? `<span class="ob-due">due day ${Number(o.dueDay)}</span>` : ''}
      ${badge}
    </div>
    <div class="loan-card-actions">
      <button class="button button-ghost loan-edit-toggle" type="button"
              onclick="openLoanEditor('${escapeHtml(o.id)}')">Edit</button>
      <button class="button btn-delete-ghost" type="button"
              onclick="confirmDeleteObligation('${escapeHtml(o.id)}')">Delete</button>
    </div>
    <form class="inline-loan-edit hidden" id="inline-edit-${escapeHtml(o.id)}"
          onsubmit="submitInlineObligationEdit(event, '${escapeHtml(o.id)}')">
      <label class="bank-picker-label-wrap">Bank / Payee${bankPickerHtml({ nameAttr: "bank", value: o.bank, required: true, placeholder: "Select bank…" })}</label>
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
  if (!panel.classList.contains('hidden')) {
    wireBankPickers(panel);
    panel.querySelector('.bank-picker-trigger, input')?.focus();
  }
}

function submitInlineLoanEdit(event, id) {
  event.preventDefault();
  const form = event.currentTarget;
  const value = name => form.elements[name].value;
  const optionalNumber = name => value(name) === '' ? '' : Number(value(name));
  updateLoan(id, {
    bank: normalizeBankName(value('bank')),
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
    bank: normalizeBankName(value('bank')),
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
  normalizeBankName(q('edit-bank').value) = loan.bank || '';
  q('edit-category').value = String(loan.category || 'personal').toLowerCase();
  q('edit-frequency').value = String(loan.frequency || 'monthly').toLowerCase().trim() || 'monthly';
  q('edit-amount').value = Number(loan.amount) || 0;
  q('edit-due-day').value = Number(loan.dueDay) || 0;
  q('edit-balance').value = loan.currentBalance === '' ? '' : Number(loan.currentBalance);
  q('edit-total').value = loan.loanTotal === '' ? '' : Number(loan.loanTotal);
  q('edit-start-date').value = inputMonth(loan.startDate);
  q('edit-contract').value = loan.contractNumber || '';
  q('loan-edit-title').textContent = `Edit ${loan.bank || 'loan'}`;
  q('loan-edit-modal').classList.remove('hidden');
  q('edit-bank').focus();
  wireBankPickers(q('loan-edit-modal') || document);
}

function closeLoanEditor() {
  q('loan-edit-modal').classList.add('hidden');
}

function submitLoanEdit(event) {
  event.preventDefault();
  const optionalNumber = id => q(id).value === '' ? '' : Number(q(id).value);
  updateLoan(q('edit-id').value, {
    bank: normalizeBankName(q('edit-bank').value),
    // Sent explicitly: the backend defaults frequency to 'monthly' when it is
    // absent, so omitting it silently reset quarterly/one-time obligations.
    category: q('edit-category').value,
    frequency: q('edit-frequency').value,
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
const INCOME_SOURCE_OPTIONS = [
  { value: 'car_rental', label: 'Car Rental' },
  { value: 'legal', label: 'Legal' },
  { value: 'real_estate', label: 'Real Estate' },
  { value: 'other', label: 'Other' }
];

function renderIncomeAddChips(selected) {
  const wrap = q('income-source-chips');
  if (!wrap) return;
  wrap.innerHTML = INCOME_SOURCE_OPTIONS.map(o => `
    <button type="button" class="income-source-chip${o.value === selected ? ' is-active' : ''}" data-source="${o.value}" onclick="selectIncomeSource('${o.value}')">
      ${bankAvatarHtml(o.label)}
      <span>${escapeHtml(o.label)}</span>
    </button>`).join('');
  updateIncomeAddAvatar(selected);
}

function updateIncomeAddAvatar(source) {
  const label = (INCOME_SOURCE_OPTIONS.find(o => o.value === source) || {}).label || 'Income';
  const preview = q('income-add-avatar-preview');
  if (preview) preview.innerHTML = bankAvatarHtml(label);
}

function selectIncomeSource(value) {
  q('f-stream').value = value;
  renderIncomeAddChips(value);
}

function openIncomeModal() {
  q('income-add-modal').classList.remove('hidden');
  q('f-date').value = q('f-date').value || new Date().toISOString().slice(0, 10);
  renderIncomeAddChips(q('f-stream').value || 'car_rental');
  q('f-amount').focus();
}

function closeIncomeModal() {
  q('income-add-modal').classList.add('hidden');
}

function renderIncome() {
  renderIncomeTab();
}

function renderCash() {
  const cashContent = q('cash-content');
  if (cashContent) cashContent.innerHTML = renderCashTab();
  updateCashDatalists();
}

function renderOffers() {
  const offersContent = q('offers-content');
  if (offersContent) offersContent.innerHTML = renderOffersTab();
  updateCashDatalists();
}

function updateCashDatalists() {
  const allCategories = [...new Set(state.cashEntries.map(e => e.category).filter(Boolean))].sort();
  const payerSuggestions = [...new Set([
    ...state.obligations.map(o => o.payer).filter(Boolean),
    ...state.cashEntries.map(e => e.payer).filter(Boolean)
  ])].sort();
  const catList = q('all-categories-list');
  const payerList = q('offer-payers-list');
  if (catList) catList.innerHTML = allCategories.map(c => `<option value="${escapeHtml(c)}">`).join('');
  if (payerList) payerList.innerHTML = payerSuggestions.map(p => `<option value="${escapeHtml(p)}">`).join('');
}

function cashEntryIsOffer(e) {
  return e.type === 'offer';
}

function cashEntryIsApproved(e) {
  return e.approved !== false && e.approved !== 'false';
}

function categoryAccent(cat) {
  if (!cat) return 'var(--color-border)';
  const palette = ['var(--color-primary)', 'var(--color-warning)', 'var(--color-success)', '#8b5cf6'];
  let h = 0;
  for (let i = 0; i < cat.length; i++) h = (h * 31 + cat.charCodeAt(i)) & 0xffff;
  return palette[h % palette.length];
}

/* ================================================================
   Canonical bank catalog — one source of truth for logos + names
   Used in Cash / Offers / Obligations / Payments / Reconcile
   ================================================================ */
const CANONICAL_BANKS = [
  { id: 'acba', name: 'ACBA Bank', logo: 'bank-logos/acba.png', keys: ['acba'], aliases: ['ACBA BANK CJSC', 'ACBA Bank CJSC', 'ACBA BANK'] },
  { id: 'ameria', name: 'Ameriabank', logo: 'bank-logos/ameriabank.png', keys: ['ameria'], aliases: ['Ameriabank CJSC', 'AMERIABANK'] },
  { id: 'amio', name: 'AMIO Bank', logo: 'bank-logos/amiobank.png', keys: ['amio', 'armbusiness'], aliases: ['AMIO BANK', 'Armbusinessbank', 'ArmBusinessBank'] },
  { id: 'ararat', name: 'AraratBank', logo: 'bank-logos/araratbank.png', keys: ['ararat'], aliases: ['ARARATBANK', 'Ararat Bank'] },
  { id: 'ardshin', name: 'Ardshinbank', logo: 'bank-logos/ardshinbank.png', keys: ['ardshin', 'ashib'], aliases: ['Ardshininbank', 'Ardshinbank CJSC', 'ARDSHINBANK'] },
  { id: 'aeb', name: 'Armeconombank', logo: 'bank-logos/armeconombank.png', keys: ['armeconom', 'aeb'], aliases: ['AEB', 'ArmEconomBank'] },
  { id: 'armswiss', name: 'ArmSwissBank', logo: 'bank-logos/armswissbank.svg', keys: ['armswiss'], aliases: ['ArmSwiss Bank'] },
  { id: 'artsakh', name: 'Artsakhbank', logo: 'bank-logos/artsakhbank.svg', keys: ['artsakh'], aliases: ['Artsakh Bank'] },
  { id: 'byblos', name: 'Byblos Bank Armenia', logo: 'bank-logos/byblos.svg', keys: ['byblos'], aliases: ['Byblos Bank'] },
  { id: 'converse', name: 'Converse Bank', logo: 'bank-logos/converse.png', keys: ['converse'], aliases: ['Converse Bank CJSC', 'CONVERSE BANK'] },
  { id: 'evoca', name: 'Evocabank', logo: 'bank-logos/evocabank.png', keys: ['evoca'], aliases: ['Evoca Bank', 'EVOCABANK'] },
  { id: 'fast', name: 'Fast Bank', logo: 'bank-logos/fastbank.svg', keys: ['fastbank', 'fast bank'], aliases: ['FastBank', 'FAST BANK'] },
  { id: 'idbank', name: 'IDBank', logo: 'bank-logos/idbank.png', keys: ['idbank', 'id bank', 'айди'], aliases: ['Id Bank CJSC', 'ID BANK CJSC', 'ID Bank', 'ID BANK'] },
  { id: 'ineco', name: 'Inecobank', logo: 'bank-logos/inecobank.png', keys: ['ineco'], aliases: ['Inecobank CJSC', 'INECOBANK'] },
  { id: 'mellat', name: 'Mellat Bank', logo: 'bank-logos/mellat.svg', keys: ['mellat'], aliases: ['Mellat Bank Armenia'] },
  { id: 'unibank', name: 'Unibank', logo: 'bank-logos/unibank.png', keys: ['unibank', 'uni bank'], aliases: ['Unibank CJSC', 'UNIBANK', 'UniBank'] },
  { id: 'vtb', name: 'VTB Bank Armenia', logo: 'bank-logos/vtb.png', keys: ['vtb', 'втб'], aliases: ['VTB Armenia', 'VTB Bank (Armenia)', 'VTB'] },
  { id: 'hsbc', name: 'HSBC Bank Armenia', logo: 'bank-logos/hsbc.svg', keys: ['hsbc'], aliases: ['HSBC Armenia', 'HSBC'] },
  // Common non-bank providers (still catalogued for logos / consistency)
  { id: 'ucom', name: 'Ucom', logo: 'bank-logos/ucom.svg', keys: ['ucom'], aliases: ['Ucom CJSC', 'UCOM'] },
  { id: 'arpinet', name: 'Arpinet', logo: 'bank-logos/arpinet.svg', keys: ['arpinet'], aliases: ['Arpinet LLC'] },
  { id: 'team', name: 'Team Telecom', logo: 'bank-logos/team.svg', keys: ['team telecom', 'team'], aliases: ['Team'] },
  { id: 'vivo', name: 'Viva-MTS', logo: 'bank-logos/vivo.svg', keys: ['vivo', 'viva', 'mts'], aliases: ['Viva', 'VivaCell', 'Viva-MTS'] }
];

// Back-compat for older logo matching
const BANK_LOGO_RULES = CANONICAL_BANKS.map(b => ({ keys: b.keys, file: b.logo }));

function bankAvatarTone(name) {
  const tones = ['indigo', 'cyan', 'coral', 'emerald', 'blue', 'purple'];
  const s = String(name || '');
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) & 0xffff;
  return tones[h % tones.length];
}

function bankInitialFromName(name) {
  const s = String(name || '').trim();
  return s ? s.charAt(0).toUpperCase() : '?';
}

function bankNormKey(s) {
  return String(s || '').toLowerCase().replace(/[\s.\-_/'"«»]+/g, '');
}

function allBankEntries() {
  // Partners (added on the Partners page, each with your own avatar) are
  // merged with the static bank catalog so they show up in every bank /
  // place / payee picker across the app -- one identity everywhere, not a
  // duplicate free-text entry per tab.
  const partnerEntries = (state.partners || [])
    .filter(p => p.active !== false && p.active !== 'false')
    .map(p => ({
      id: p.id,
      name: p.name,
      logo: p.avatar || null,
      keys: [String(p.name || '').toLowerCase()],
      aliases: [],
      category: p.category || '',
      isPartner: true
    }));
  const partnerNames = new Set(partnerEntries.map(p => bankNormKey(p.name)));
  const canonical = CANONICAL_BANKS.filter(b => !partnerNames.has(bankNormKey(b.name)));
  return [...partnerEntries, ...canonical];
}

function matchCanonicalBank(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  const key = bankNormKey(s);
  // exact canonical name
  for (const b of allBankEntries()) {
    if (bankNormKey(b.name) === key) return b;
    if ((b.aliases || []).some(a => bankNormKey(a) === key)) return b;
  }
  // keyword / includes (prefer longer keys)
  let best = null;
  let bestLen = 0;
  for (const b of allBankEntries()) {
    for (const k of b.keys) {
      const kk = bankNormKey(k);
      if (!kk) continue;
      if ((key.includes(kk) || bankNormKey(s).includes(kk)) && kk.length > bestLen) {
        // avoid "uni" matching too aggressively inside other words — require key length >= 4 or full match
        if (kk.length < 4 && key !== kk && !key.startsWith(kk)) continue;
        // special: "fast" only as fastbank / fast bank
        if (b.id === 'fast' && !(key.includes('fastbank') || key.includes('fast'))) continue;
        if (b.id === 'unibank' && !(key.includes('uni') && (key.includes('bank') || key === 'unibank' || key.includes('unibank')))) {
          if (!key.includes('unibank') && key !== 'uni') {
            // allow "Unibank CJSC"
            if (!s.toLowerCase().includes('uni')) continue;
          }
        }
        best = b;
        bestLen = kk.length;
      }
    }
  }
  // simpler key includes pass
  if (!best) {
    for (const b of allBankEntries()) {
      for (const k of b.keys) {
        const kl = k.toLowerCase();
        if (kl.length >= 4 && s.toLowerCase().includes(kl)) return b;
      }
    }
  }
  return best;
}

/** Map free-text → canonical bank name (or keep custom payee as-is). */
function normalizeBankName(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  const hit = matchCanonicalBank(s);
  return hit ? hit.name : s;
}

function bankLogoSrc(name) {
  const hit = matchCanonicalBank(name);
  if (hit) return hit.logo;
  // legacy fallback
  const raw = String(name || '').toLowerCase().trim();
  if (!raw) return null;
  const compact = raw.replace(/[\s.\-_/]+/g, '');
  for (const rule of BANK_LOGO_RULES) {
    for (const key of rule.keys) {
      const k = key.toLowerCase();
      if (raw.includes(k) || compact.includes(k.replace(/\s+/g, ''))) return rule.file;
    }
  }
  return null;
}

/** All banks for pickers (canonical only). */
function bankCatalogOptions() {
  return allBankEntries().slice().sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Combobox field HTML: hidden value + logo trigger + searchable list.
 * nameAttr: form field name ("bank" | "place")
 */
function bankPickerHtml({ id, nameAttr = 'bank', value = '', required = false, placeholder = 'Select bank…', allowCustom = true } = {}) {
  const v = String(value || '');
  const norm = normalizeBankName(v);
  const display = norm || '';
  const req = required ? 'required' : '';
  const logo = display ? bankAvatarHtml(display, 'offer-avatar--sm') : `<div class="offer-avatar offer-avatar--sm offer-avatar--all" aria-hidden="true">?</div>`;
  return `<div class="bank-picker" data-bank-picker="${escapeHtml(id || nameAttr)}" data-allow-custom="${allowCustom ? '1' : '0'}">
    <input type="hidden" class="bank-picker-value" id="${escapeHtml(id || '')}" name="${escapeHtml(nameAttr)}" value="${escapeHtml(norm)}" ${req}>
    <button type="button" class="bank-picker-trigger" aria-haspopup="listbox" aria-expanded="false">
      <span class="bank-picker-logo">${logo}</span>
      <span class="bank-picker-label">${display ? escapeHtml(display) : `<span class="bank-picker-placeholder">${escapeHtml(placeholder)}</span>`}</span>
      <svg class="bank-picker-chevron" viewBox="0 0 12 8" aria-hidden="true"><path d="M1 1.5 6 6.5 11 1.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
    </button>
    <div class="bank-picker-panel hidden" role="listbox">
      <input type="search" class="bank-picker-search" placeholder="Search banks…" autocomplete="off" aria-label="Search banks">
      <div class="bank-picker-list"></div>
      ${allowCustom ? `<button type="button" class="bank-picker-other">Other / custom name…</button>` : ''}
    </div>
  </div>`;
}

function fillBankPickerList(picker, filter = '') {
  const list = picker.querySelector('.bank-picker-list');
  if (!list) return;
  const qstr = String(filter || '').toLowerCase().trim();
  const current = picker.querySelector('.bank-picker-value')?.value || '';
  const items = bankCatalogOptions().filter(b => {
    if (!qstr) return true;
    const blob = [b.name, ...(b.aliases || []), ...(b.keys || [])].join(' ').toLowerCase();
    return blob.includes(qstr);
  });
  if (!items.length) {
    list.innerHTML = `<div class="bank-picker-empty">No bank match${picker.dataset.allowCustom === '1' ? ' — use custom below' : ''}</div>`;
    return;
  }
  list.innerHTML = items.map(b => {
    const active = current === b.name || matchCanonicalBank(current)?.id === b.id;
    return `<button type="button" class="bank-picker-option${active ? ' is-active' : ''}" role="option" data-bank-name="${escapeHtml(b.name)}" data-bank-id="${escapeHtml(b.id)}">
      ${bankAvatarHtml(b.name, 'offer-avatar--sm')}
      <span class="bank-picker-option-text">
        <strong>${escapeHtml(b.name)}</strong>
        ${b.aliases && b.aliases[0] ? `<small>${escapeHtml(b.aliases[0])}</small>` : ''}
      </span>
      <span class="bank-picker-option-check" aria-hidden="true"></span>
    </button>`;
  }).join('');
}

function setBankPickerValue(picker, rawName, { silent = false } = {}) {
  const valueInput = picker.querySelector('.bank-picker-value');
  const label = picker.querySelector('.bank-picker-label');
  const logoWrap = picker.querySelector('.bank-picker-logo');
  if (!valueInput) return;
  const name = normalizeBankName(rawName);
  valueInput.value = name;
  if (label) {
    label.innerHTML = name
      ? escapeHtml(name)
      : `<span class="bank-picker-placeholder">Select bank…</span>`;
  }
  if (logoWrap) {
    logoWrap.innerHTML = name
      ? bankAvatarHtml(name, 'offer-avatar--sm')
      : `<div class="offer-avatar offer-avatar--sm offer-avatar--all" aria-hidden="true">?</div>`;
  }
  if (!silent) {
    valueInput.dispatchEvent(new Event('change', { bubbles: true }));
    valueInput.dispatchEvent(new Event('input', { bubbles: true }));
  }
}

// ================================================================
// Partners -- one identity (bank, agency, employer, anyone) reused
// everywhere a bank/place/payee picker shows up, each with its own avatar.
// ================================================================
let pendingPartnerAvatar = { add: '', edit: '' };

const PARTNER_CATEGORY_LABELS = {
  bank: 'Bank',
  government: 'Government / agency',
  company: 'Company',
  person: 'Person',
  other: 'Other'
};

/** Read an image file, shrink it to a small square-ish JPEG, return a data URL. */
function resizeImageFile(file, maxDim = 128, quality = 0.78) {
  return new Promise((resolve, reject) => {
    if (!file || !file.type || !file.type.startsWith('image/')) {
      reject(new Error('Please choose an image file.'));
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read that image.'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('Could not decode that image.'));
      img.onload = () => {
        let { width, height } = img;
        const scale = Math.min(1, maxDim / Math.max(width, height));
        width = Math.max(1, Math.round(width * scale));
        height = Math.max(1, Math.round(height * scale));
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, width, height);
        ctx.drawImage(img, 0, 0, width, height);
        const dataUrl = canvas.toDataURL('image/jpeg', quality);
        if (dataUrl.length > 45000) {
          reject(new Error('That photo is too large even after shrinking. Try a simpler image.'));
          return;
        }
        resolve(dataUrl);
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

async function handlePartnerAvatarPick(event, which) {
  const file = event.target.files && event.target.files[0];
  if (!file) return;
  const preview = q(which === 'add' ? 'add-partner-avatar-preview' : 'edit-partner-avatar-preview');
  try {
    const dataUrl = await resizeImageFile(file);
    pendingPartnerAvatar[which] = dataUrl;
    if (preview) preview.innerHTML = `<img src="${dataUrl}" alt="">`;
  } catch (err) {
    showError(err.message);
  } finally {
    event.target.value = '';
  }
}

// Partner writes carry an avatar (up to ~45KB of base64), so they go over
// POST instead of the GET query string every other action uses. The body is
// sent as text/plain on purpose: a JSON content-type would trigger a CORS
// preflight (OPTIONS) request, which the Apps Script web app can't answer.
async function postApi(params, { timeout = 20000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  setSyncStatus('saving', 'Saving changes...');
  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(params),
      signal: controller.signal
    });
    if (!res.ok) throw new Error(`Server returned ${res.status}`);
    const json = await res.json();
    if (json.error) throw new Error(json.error);
    invalidateCachedMonth(state.month);
    setSyncStatus('ready', 'Changes saved');
    return json;
  } catch (err) {
    setSyncStatus('error', 'Save failed. Try again');
    if (err.name === 'AbortError') throw new Error('Server took too long. Nothing was changed in the app.');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function withSubmitLock(form, label, task) {
  const button = form?.querySelector('[type="submit"]');
  const original = button ? button.textContent : '';
  if (button) {
    button.disabled = true;
    button.textContent = label;
  }
  try {
    return await task();
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = original;
    }
  }
}

function activePartners() {
  return (state.partners || []).filter(p => p.active !== false && p.active !== 'false');
}

/** Everything already recorded under this partner's name, so it's obvious
 *  it's the same counterparty everywhere instead of a fresh duplicate. */
function partnerRelationships(name) {
  const key = bankNormKey(name);
  const matches = v => !!key && bankNormKey(v) === key;
  const cashAll = state.cashEntries || [];
  return {
    obligations: (state.obligations || []).filter(o => o.active !== false && matches(o.bank)),
    cash: cashAll.filter(c => c.type !== 'offer' && matches(c.place)),
    offers: cashAll.filter(c => c.type === 'offer' && matches(c.place)),
    utilities: (state.utilities || []).filter(u => u.active !== false && matches(u.provider))
  };
}

function partnerCardHtml(p) {
  const rel = partnerRelationships(p.name);
  const debt = rel.obligations.reduce((sum, o) => sum + (Number(o.currentBalance) || 0), 0);
  const parts = [];
  if (rel.obligations.length) parts.push(`${rel.obligations.length} obligation${rel.obligations.length === 1 ? '' : 's'}`);
  if (rel.cash.length) parts.push(`${rel.cash.length} cash entr${rel.cash.length === 1 ? 'y' : 'ies'}`);
  if (rel.offers.length) parts.push(`${rel.offers.length} offer${rel.offers.length === 1 ? '' : 's'}`);
  if (rel.utilities.length) parts.push(`${rel.utilities.length} utility bill${rel.utilities.length === 1 ? '' : 's'}`);
  const relText = parts.length ? parts.join(' · ') : 'No linked records yet';
  const catLabel = PARTNER_CATEGORY_LABELS[p.category] || '';
  return `<div class="partner-card">
    <div class="partner-card-avatar">${bankAvatarHtml(p.name, 'partner-avatar-lg')}</div>
    <div class="partner-card-body">
      <div class="partner-card-name">${escapeHtml(p.name)}</div>
      ${catLabel ? `<div class="partner-card-cat">${escapeHtml(catLabel)}</div>` : ''}
      <div class="partner-card-rel">${escapeHtml(relText)}</div>
      ${debt ? `<div class="partner-card-debt">${amd(debt)} owed</div>` : ''}
    </div>
    <div class="partner-card-actions">
      <button type="button" class="icon-btn" onclick="openEditPartnerModal('${escapeHtml(p.id)}')" aria-label="Edit ${escapeHtml(p.name)}">
        <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 16v-2.8L13.6 3.6a1.5 1.5 0 0 1 2.1 0l1.7 1.7a1.5 1.5 0 0 1 0 2.1L7.8 17H5a1 1 0 0 1-1-1Z"/></svg>
      </button>
      <button type="button" class="icon-btn icon-btn-danger" onclick="deletePartnerPrompt('${escapeHtml(p.id)}')" aria-label="Remove ${escapeHtml(p.name)}">
        <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 6h10m-8 0V4h6v2m-7 0 .6 10a1 1 0 0 0 1 1h4.8a1 1 0 0 0 1-1L14 6"/></svg>
      </button>
    </div>
  </div>`;
}

function renderPartnersTab() {
  const container = q('partners-container');
  if (!container) return;
  const partners = activePartners().slice().sort((a, b) => String(a.name).localeCompare(String(b.name)));
  if (!partners.length) {
    container.innerHTML = `<div class="empty-state">No partners yet. Add a bank, government body, employer or anyone else you deal with -- once added, they show up with their own avatar in every dropdown across the app instead of a plain typed name.</div>`;
    return;
  }
  container.innerHTML = `<div class="partner-card-grid">${partners.map(partnerCardHtml).join('')}</div>`;
}

function openAddPartnerModal() {
  pendingPartnerAvatar.add = '';
  q('add-partner-form')?.reset();
  const preview = q('add-partner-avatar-preview');
  if (preview) preview.innerHTML = '<span>?</span>';
  q('add-partner-modal').classList.remove('hidden');
  q('add-partner-name')?.focus();
}

function closeAddPartnerModal() {
  q('add-partner-modal').classList.add('hidden');
}

async function submitAddPartner(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const name = q('add-partner-name').value.trim();
  if (!name) return;
  const category = q('add-partner-category').value;
  try {
    await withSubmitLock(form, 'Adding...', () =>
      postApi({ action: 'addPartner', name, category, avatar: pendingPartnerAvatar.add || '' })
    );
    closeAddPartnerModal();
    revalidateMonth(state.month, true).catch(() => {});
    renderCurrentTab();
    showToast(`${name} added`);
  } catch (err) {
    showError(`Could not add partner: ${err.message}`);
  }
}

function openEditPartnerModal(id) {
  const partner = (state.partners || []).find(p => String(p.id) === String(id));
  if (!partner) return;
  pendingPartnerAvatar.edit = '';
  q('edit-partner-id').value = partner.id;
  q('edit-partner-name').value = partner.name || '';
  q('edit-partner-category').value = partner.category || '';
  const preview = q('edit-partner-avatar-preview');
  if (preview) preview.innerHTML = partner.avatar ? `<img src="${partner.avatar}" alt="">` : '<span>?</span>';
  q('edit-partner-modal').classList.remove('hidden');
}

function closeEditPartnerModal() {
  q('edit-partner-modal').classList.add('hidden');
}

async function submitEditPartner(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const id = q('edit-partner-id').value;
  const name = q('edit-partner-name').value.trim();
  if (!id || !name) return;
  const category = q('edit-partner-category').value;
  const params = { action: 'updatePartner', id, name, category };
  if (pendingPartnerAvatar.edit) params.avatar = pendingPartnerAvatar.edit;
  try {
    await withSubmitLock(form, 'Saving...', () => postApi(params));
    closeEditPartnerModal();
    revalidateMonth(state.month, true).catch(() => {});
    renderCurrentTab();
    showToast('Partner updated');
  } catch (err) {
    showError(`Could not update partner: ${err.message}`);
  }
}

async function deletePartnerPrompt(id) {
  const partner = (state.partners || []).find(p => String(p.id) === String(id));
  if (!partner) return;
  if (!confirm(`Remove "${partner.name}" from your partners list? Existing obligations, cash entries, offers and utilities that mention this name are kept as-is.`)) return;
  try {
    await postApi({ action: 'deletePartner', id });
    revalidateMonth(state.month, true).catch(() => {});
    renderCurrentTab();
  } catch (err) {
    showError(`Could not remove partner: ${err.message}`);
  }
}

function closeAllBankPickers(except) {
  document.querySelectorAll('.bank-picker').forEach(p => {
    if (except && p === except) return;
    p.classList.remove('is-open');
    p.querySelector('.bank-picker-panel')?.classList.add('hidden');
    p.querySelector('.bank-picker-trigger')?.setAttribute('aria-expanded', 'false');
  });
}

function openBankPicker(picker) {
  closeAllBankPickers(picker);
  picker.classList.add('is-open');
  const panel = picker.querySelector('.bank-picker-panel');
  panel?.classList.remove('hidden');
  picker.querySelector('.bank-picker-trigger')?.setAttribute('aria-expanded', 'true');
  fillBankPickerList(picker, '');
  const search = picker.querySelector('.bank-picker-search');
  if (search) {
    search.value = '';
    setTimeout(() => search.focus(), 30);
  }
}

/** Upgrade a plain text input into a bank picker (modals / legacy fields). */
function upgradeBankInput(input, { allowCustom = true, placeholder } = {}) {
  if (!input || input.dataset.bankUpgraded === '1') return null;
  if (input.closest('.bank-picker')) return input.closest('.bank-picker');
  const id = input.id || '';
  const nameAttr = input.getAttribute('name') || input.id || 'bank';
  const required = input.required;
  const value = input.value || '';
  const wrap = document.createElement('div');
  wrap.innerHTML = bankPickerHtml({
    id,
    nameAttr,
    value,
    required,
    placeholder: placeholder || input.placeholder || 'Select bank…',
    allowCustom
  });
  const picker = wrap.firstElementChild;
  input.dataset.bankUpgraded = '1';
  input.replaceWith(picker);
  // keep id on hidden for form scripts that use q('cash-new-place')
  const hidden = picker.querySelector('.bank-picker-value');
  if (id && hidden) hidden.id = id;
  return picker;
}

function wireBankPickers(root = document) {
  // One-time document listeners
  if (!window.__bankPickerWired) {
    window.__bankPickerWired = true;
    document.addEventListener('submit', e => {
      const form = e.target;
      if (!(form instanceof HTMLFormElement)) return;
      const requiredHidden = form.querySelectorAll('.bank-picker-value[required]');
      for (const hid of requiredHidden) {
        if (!String(hid.value || '').trim()) {
          e.preventDefault();
          const picker = hid.closest('.bank-picker');
          if (picker) {
            openBankPicker(picker);
            picker.classList.add('is-invalid');
          }
          showError && showError('Please select a bank from the list.');
          return;
        }
      }
    }, true);
    document.addEventListener('click', e => {
      const trigger = e.target.closest('.bank-picker-trigger');
      if (trigger) {
        const picker = trigger.closest('.bank-picker');
        if (picker.classList.contains('is-open')) closeAllBankPickers();
        else openBankPicker(picker);
        e.preventDefault();
        return;
      }
      const opt = e.target.closest('.bank-picker-option');
      if (opt) {
        const picker = opt.closest('.bank-picker');
        setBankPickerValue(picker, opt.getAttribute('data-bank-name') || '');
        closeAllBankPickers();
        e.preventDefault();
        return;
      }
      const other = e.target.closest('.bank-picker-other');
      if (other) {
        const picker = other.closest('.bank-picker');
        const custom = prompt('Custom bank / place / payee name:', picker.querySelector('.bank-picker-value')?.value || '');
        if (custom !== null && custom.trim()) {
          setBankPickerValue(picker, custom.trim());
        }
        closeAllBankPickers();
        e.preventDefault();
        return;
      }
      if (!e.target.closest('.bank-picker')) closeAllBankPickers();
    });
    document.addEventListener('input', e => {
      if (!e.target.classList.contains('bank-picker-search')) return;
      const picker = e.target.closest('.bank-picker');
      if (picker) fillBankPickerList(picker, e.target.value);
    });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') closeAllBankPickers();
    });
  }

  // Upgrade known modal / static fields
  [
    ['cash-new-place', true],
    ['offer-new-place', true],
    ['add-ob-bank', true],
    ['edit-bank', true]
  ].forEach(([id, allow]) => {
    const el = (root.getElementById ? root : document).getElementById?.(id) || q(id);
    if (el && el.tagName === 'INPUT') upgradeBankInput(el, { allowCustom: allow });
  });

  // Dynamic edit forms (cash/offer place fields)
  (root.querySelectorAll ? root : document).querySelectorAll('input[name="place"], input[data-bank-field="1"]').forEach(inp => {
    if (inp.tagName === 'INPUT' && !inp.closest('.bank-picker')) {
      upgradeBankInput(inp, { allowCustom: true, placeholder: 'Select bank / place…' });
    }
  });
  (root.querySelectorAll ? root : document).querySelectorAll('input[name="bank"]').forEach(inp => {
    if (inp.tagName === 'INPUT' && !inp.classList.contains('bank-picker-value') && !inp.closest('.bank-picker')) {
      upgradeBankInput(inp, { allowCustom: true, placeholder: 'Select bank…' });
    }
  });
}

/** Logo when bank is known; letter avatar otherwise. Used on Cash / Offers / Reconcile. */
function bankAvatarHtml(name, extraClass = '') {
  const place = String(name || 'Bank');
  const tone = bankAvatarTone(place);
  const initial = bankInitialFromName(place);
  const src = bankLogoSrc(place);
  const cls = `offer-avatar${src ? ' offer-avatar--logo' : ' offer-avatar--' + tone}${extraClass ? ' ' + extraClass : ''}`;
  if (src) {
    const safeInit = escapeHtml(initial).replace(/'/g, '');
    return `<div class="${cls}" title="${escapeHtml(place)}"><img class="bank-logo-img" src="${src}" alt="${safeInit}" loading="lazy" onerror="this.onerror=null;const p=this.parentElement;p.classList.remove('offer-avatar--logo');p.classList.add('offer-avatar--${tone}');p.textContent='${safeInit}';"></div>`;
  }
  return `<div class="${cls}" title="${escapeHtml(place)}" aria-hidden="true">${escapeHtml(initial)}</div>`;
}

function renderOfferGlassCard(e) {
  const approved = cashEntryIsApproved(e);
  const sid = escapeHtml(e.id);
  const place = e.place || 'Lender';
  const validDate = e.lastAvailableDate && /^\d{4}-\d{2}-\d{2}$/.test(e.lastAvailableDate);
  const tags = `<div class="offer-tags">
    <span class="offer-tag ${approved ? 'offer-tag-approved' : 'offer-tag-pending'}">${approved ? 'Approved' : 'Pending approval'}</span>
    ${e.category ? `<span class="offer-tag offer-tag-cat">${escapeHtml(e.category)}</span>` : ''}
    ${e.payer ? `<span class="offer-tag offer-tag-payer">${escapeHtml(e.payer)}</span>` : ''}
    ${validDate ? `<span class="offer-tag offer-tag-date">${e.lastAvailableDate}</span>` : ''}
  </div>`;

  return `<div class="offer-glass-card" id="cash-entry-${sid}">
    <div class="offer-glass-glow" aria-hidden="true"></div>
    <div class="cash-entry-view offer-glass-view">
      <div class="offer-glass-main">
        <div class="offer-glass-top">
          <div class="offer-glass-title">
            ${bankAvatarHtml(place)}
            <div class="offer-glass-text">
              <div class="offer-bank-name">${escapeHtml(place)}</div>
              <div class="offer-bank-meta">${approved ? 'Pre-approved credit · ready to draw' : 'Awaiting approval'}</div>
            </div>
          </div>
          <div class="offer-glass-amount">${amd(Number(e.amount))}</div>
        </div>
        ${tags}
      </div>
      <div class="cash-entry-actions offer-glass-actions">
        <button class="button button-primary" type="button" onclick="openCashEdit('${sid}')">Edit</button>
        <button class="button button-ghost" type="button" onclick="confirmDeleteCash('${sid}')">Delete</button>
      </div>
    </div>
    <form class="cash-entry-edit hidden" id="cash-edit-${sid}" onsubmit="saveCashEdit(event,'${sid}')">
      <select class="form-input" name="type">
        <option value="cash">Cash Holding</option>
        <option value="offer" selected>Loan Offer</option>
      </select>
      <input class="form-input" name="category" type="text" list="all-categories-list" value="${escapeHtml(e.category || '')}" placeholder="Category (optional)" maxlength="80">
      <div class="cash-edit-offer-fields">
        <input class="form-input" name="payer" type="text" list="offer-payers-list" value="${escapeHtml(e.payer || '')}" placeholder="For whom" maxlength="80">
        <input class="form-input" name="lastAvailableDate" type="date" value="${/^\d{4}-\d{2}-\d{2}$/.test(e.lastAvailableDate || '') ? e.lastAvailableDate : ''}">
        <label class="completed-switch cash-edit-approved"><input type="checkbox" name="approved" ${approved ? 'checked' : ''}><span class="switch-track" aria-hidden="true"></span><span>Already approved</span></label>
      </div>
      <input class="form-input" name="place" value="${escapeHtml(normalizeBankName(e.place))}" data-bank-field="1" placeholder="Bank / Place" required maxlength="100">
      <input class="form-input" name="amount" type="number" value="${Number(e.amount)}" min="0" step="1000" required>
      <div class="cash-edit-btns">
        <button class="button button-ghost btn-sm"   type="button" onclick="closeCashEdit('${sid}')">Cancel</button>
        <button class="button button-primary btn-sm" type="submit">Save</button>
      </div>
    </form>
  </div>`;
}

function renderCashGlassCard(e) {
  const sid = escapeHtml(e.id);
  const place = e.place || 'Place';
  const validDate = e.lastAvailableDate && /^\d{4}-\d{2}-\d{2}$/.test(e.lastAvailableDate);
  const hasTags = e.category || e.payer || validDate;
  const tags = hasTags ? `<div class="offer-tags">
    <span class="offer-tag offer-tag-cash">Cash holding</span>
    ${e.category ? `<span class="offer-tag offer-tag-cat">${escapeHtml(e.category)}</span>` : ''}
    ${e.payer ? `<span class="offer-tag offer-tag-payer">${escapeHtml(e.payer)}</span>` : ''}
    ${validDate ? `<span class="offer-tag offer-tag-date">${e.lastAvailableDate}</span>` : ''}
  </div>` : `<div class="offer-tags"><span class="offer-tag offer-tag-cash">Cash holding</span></div>`;

  return `<div class="offer-glass-card cash-glass-card" id="cash-entry-${sid}">
    <div class="offer-glass-glow cash-glass-glow" aria-hidden="true"></div>
    <div class="cash-entry-view offer-glass-view">
      <div class="offer-glass-main">
        <div class="offer-glass-top">
          <div class="offer-glass-title">
            ${bankAvatarHtml(place)}
            <div class="offer-glass-text">
              <div class="offer-bank-name">${escapeHtml(place)}</div>
              <div class="offer-bank-meta">${e.category ? escapeHtml(e.category) : 'Available balance'}</div>
            </div>
          </div>
          <div class="offer-glass-amount cash-glass-amount">${amd(Number(e.amount))}</div>
        </div>
        ${tags}
      </div>
      <div class="cash-entry-actions offer-glass-actions">
        <button class="button button-primary" type="button" onclick="openCashEdit('${sid}')">Edit</button>
        <button class="button button-ghost" type="button" onclick="confirmDeleteCash('${sid}')">Delete</button>
      </div>
    </div>
    <form class="cash-entry-edit hidden" id="cash-edit-${sid}" onsubmit="saveCashEdit(event,'${sid}')">
      <select class="form-input" name="type">
        <option value="cash" selected>Cash Holding</option>
        <option value="offer">Loan Offer</option>
      </select>
      <input class="form-input" name="category" type="text" list="all-categories-list" value="${escapeHtml(e.category || '')}" placeholder="Category (optional)" maxlength="80">
      <div class="cash-edit-offer-fields">
        <input class="form-input" name="payer" type="text" list="offer-payers-list" value="${escapeHtml(e.payer || '')}" placeholder="For whom" maxlength="80">
        <input class="form-input" name="lastAvailableDate" type="date" value="${/^\d{4}-\d{2}-\d{2}$/.test(e.lastAvailableDate || '') ? e.lastAvailableDate : ''}">
        <label class="completed-switch cash-edit-approved"><input type="checkbox" name="approved" checked><span class="switch-track" aria-hidden="true"></span><span>Already approved</span></label>
      </div>
      <input class="form-input" name="place" value="${escapeHtml(normalizeBankName(e.place))}" data-bank-field="1" placeholder="Bank / Place" required maxlength="100">
      <input class="form-input" name="amount" type="number" value="${Number(e.amount)}" min="0" step="1000" required>
      <div class="cash-edit-btns">
        <button class="button button-ghost btn-sm"   type="button" onclick="closeCashEdit('${sid}')">Cancel</button>
        <button class="button button-primary btn-sm" type="submit">Save</button>
      </div>
    </form>
  </div>`;
}

function renderCashEntryCard(e) {
  const isOffer = cashEntryIsOffer(e);
  const approved = cashEntryIsApproved(e);
  const sid = escapeHtml(e.id);
  const accent = categoryAccent(e.category);
  const validDate = e.lastAvailableDate && /^\d{4}-\d{2}-\d{2}$/.test(e.lastAvailableDate);
  const hasTags = e.category || e.payer || validDate || isOffer;
  const tags = hasTags ? `<div class="offer-tags">
    ${isOffer ? `<span class="offer-tag ${approved ? 'offer-tag-approved' : 'offer-tag-pending'}">${approved ? 'Approved' : 'Pending approval'}</span>` : ''}
    ${e.category ? `<span class="offer-tag offer-tag-cat">${escapeHtml(e.category)}</span>` : ''}
    ${e.payer ? `<span class="offer-tag offer-tag-payer">${escapeHtml(e.payer)}</span>` : ''}
    ${validDate ? `<span class="offer-tag offer-tag-date">${e.lastAvailableDate}</span>` : ''}
  </div>` : '';
  return `<div class="cash-entry" id="cash-entry-${sid}" style="border-left-color:${accent}">
    <div class="cash-entry-view">
      <div class="cash-entry-main">
        <div class="cash-entry-top">
          <span class="cash-place">${escapeHtml(e.place)}</span>
          <span class="cash-entry-amount">${amd(Number(e.amount))}</span>
        </div>
        ${tags}
      </div>
      <div class="cash-entry-actions">
        <button class="button button-primary" type="button" onclick="openCashEdit('${sid}')">Edit</button>
        <button class="button button-ghost" type="button" onclick="confirmDeleteCash('${sid}')">Delete</button>
      </div>
    </div>
    <form class="cash-entry-edit hidden" id="cash-edit-${sid}" onsubmit="saveCashEdit(event,'${sid}')">
      <select class="form-input" name="type">
        <option value="cash"  ${!isOffer ? 'selected' : ''}>Cash Holding</option>
        <option value="offer" ${isOffer  ? 'selected' : ''}>Loan Offer</option>
      </select>
      <input class="form-input" name="category" type="text" list="all-categories-list" value="${escapeHtml(e.category || '')}" placeholder="Category (optional)" maxlength="80">
      <div class="cash-edit-offer-fields">
        <input class="form-input" name="payer" type="text" list="offer-payers-list" value="${escapeHtml(e.payer || '')}" placeholder="For whom" maxlength="80">
        <input class="form-input" name="lastAvailableDate" type="date" value="${/^\d{4}-\d{2}-\d{2}$/.test(e.lastAvailableDate || '') ? e.lastAvailableDate : ''}">
        <label class="completed-switch cash-edit-approved"><input type="checkbox" name="approved" ${approved ? 'checked' : ''}><span class="switch-track" aria-hidden="true"></span><span>Already approved</span></label>
      </div>
      <input class="form-input" name="place" value="${escapeHtml(normalizeBankName(e.place))}" data-bank-field="1" placeholder="Bank / Place" required maxlength="100">
      <input class="form-input" name="amount" type="number" value="${Number(e.amount)}" min="0" step="1000" required>
      <div class="cash-edit-btns">
        <button class="button button-ghost btn-sm"   type="button" onclick="closeCashEdit('${sid}')">Cancel</button>
        <button class="button button-primary btn-sm" type="submit">Save</button>
      </div>
    </form>
  </div>`;
}


function renderCashHoldingsSection(allCash) {
  const categories = [...new Set(allCash.map(e => e.category).filter(Boolean))].sort();
  const payers     = [...new Set(allCash.map(e => e.payer).filter(Boolean))].sort();
  const places     = [...new Set(allCash.map(e => e.place).filter(Boolean))].sort();

  state.cashFilter      = setObligationSelectOptions('cash-type', categories, 'All types', state.cashFilter || 'all');
  state.cashPayerFilter = setObligationSelectOptions('cash-payer', payers, 'All payers', state.cashPayerFilter || 'all');
  state.cashPlaceFilter = setObligationSelectOptions('cash-place', places, 'All places', state.cashPlaceFilter || 'all');
  const cashSortSel = q('cash-sort');
  if (cashSortSel) cashSortSel.value = state.cashSort || 'amount-desc';

  const catFilter   = state.cashFilter;
  const payerFilter = state.cashPayerFilter;
  const placeFilter = state.cashPlaceFilter;
  const sort        = state.cashSort || 'amount-desc';

  const filtered = allCash.filter(e => {
    if (catFilter   !== 'all' && (e.category || '') !== catFilter)   return false;
    if (payerFilter !== 'all' && (e.payer    || '') !== payerFilter) return false;
    if (placeFilter !== 'all' && (e.place    || '') !== placeFilter) return false;
    return true;
  });

  const sorted = [...filtered].sort((a, b) => {
    if (sort === 'amount-asc')  return (Number(a.amount) || 0) - (Number(b.amount) || 0);
    if (sort === 'date-desc')   return String(b.lastAvailableDate || '').localeCompare(String(a.lastAvailableDate || ''));
    if (sort === 'date-asc')    return String(a.lastAvailableDate || '').localeCompare(String(b.lastAvailableDate || ''));
    if (sort === 'category')    return String(a.category || '').localeCompare(String(b.category || ''));
    if (sort === 'payer')       return String(a.payer    || '').localeCompare(String(b.payer    || ''));
    if (sort === 'place')       return String(a.place    || '').localeCompare(String(b.place    || ''));
    return (Number(b.amount) || 0) - (Number(a.amount) || 0);
  });

  const total = sorted.reduce((s, e) => s + (Number(e.amount) || 0), 0);
  const isFiltered = catFilter !== 'all' || payerFilter !== 'all' || placeFilter !== 'all';

  updateFilterBadge('cash', activeCashFilterCount());

  const resultsText = isFiltered
    ? `Showing ${sorted.length} of ${allCash.length} entries`
    : `${sorted.length} entr${sorted.length === 1 ? 'y' : 'ies'}`;

  return `
    <span id="cash-results-count" class="cash-results-line">${resultsText}</span>
    ${sorted.length
      ? `<div class="offer-glass-grid cash-glass-grid">${sorted.map(renderCashGlassCard).join('')}</div>
         <div class="section-total">${isFiltered ? 'Filtered: ' : 'Total: '}<strong>${amd(total)}</strong></div>`
      : `<div class="cash-empty">No cash entries${isFiltered ? ' matching filter' : ''}.</div>`}`;
}

function renderOfferSection(allOffers) {
  const categories = [...new Set(allOffers.map(e => e.category).filter(Boolean))].sort();
  const payers     = [...new Set(allOffers.map(e => e.payer).filter(Boolean))].sort();
  const places     = [...new Set(allOffers.map(e => e.place).filter(Boolean))].sort();

  state.offerFilter      = setObligationSelectOptions('offer-type', categories, 'All types', state.offerFilter || 'all');
  state.offerPayerFilter = setObligationSelectOptions('offer-payer', payers, 'All payers', state.offerPayerFilter || 'all');
  state.offerPlaceFilter = setObligationSelectOptions('offer-place', places, 'All places', state.offerPlaceFilter || 'all');
  const offerStatusSel = q('offer-status');
  if (offerStatusSel) offerStatusSel.value = state.offerStatusFilter || 'all';
  const offerSortSel = q('offer-sort');
  if (offerSortSel) offerSortSel.value = state.offerSort || 'amount-desc';

  const catFilter    = state.offerFilter;
  const payerFilter  = state.offerPayerFilter;
  const placeFilter  = state.offerPlaceFilter;
  const statusFilter = state.offerStatusFilter || 'all';
  const sort         = state.offerSort || 'amount-desc';

  const filtered = allOffers.filter(e => {
    if (catFilter    !== 'all' && (e.category || '') !== catFilter)   return false;
    if (payerFilter  !== 'all' && (e.payer    || '') !== payerFilter) return false;
    if (placeFilter  !== 'all' && (e.place    || '') !== placeFilter) return false;
    if (statusFilter === 'approved' && !cashEntryIsApproved(e)) return false;
    if (statusFilter === 'pending'  &&  cashEntryIsApproved(e)) return false;
    return true;
  });

  const sorted = [...filtered].sort((a, b) => {
    if (sort === 'amount-asc')  return (Number(a.amount) || 0) - (Number(b.amount) || 0);
    if (sort === 'date-desc')   return String(b.lastAvailableDate || '').localeCompare(String(a.lastAvailableDate || ''));
    if (sort === 'date-asc')    return String(a.lastAvailableDate || '').localeCompare(String(b.lastAvailableDate || ''));
    if (sort === 'category')    return String(a.category || '').localeCompare(String(b.category || ''));
    if (sort === 'payer')       return String(a.payer    || '').localeCompare(String(b.payer    || ''));
    if (sort === 'place')       return String(a.place    || '').localeCompare(String(b.place    || ''));
    return (Number(b.amount) || 0) - (Number(a.amount) || 0);
  });

  const approvedList = sorted.filter(cashEntryIsApproved);
  const pendingList  = sorted.filter(e => !cashEntryIsApproved(e));
  const total = sorted.reduce((s, e) => s + (Number(e.amount) || 0), 0);
  const isFiltered = catFilter !== 'all' || payerFilter !== 'all' || placeFilter !== 'all' || statusFilter !== 'all';

  updateFilterBadge('offer', activeOfferFilterCount());

  const resultsText = isFiltered
    ? `Showing ${sorted.length} of ${allOffers.length} offers`
    : `${sorted.length} offer${sorted.length === 1 ? '' : 's'}`;

  function subsection(title, list, badgeClass) {
    if (!list.length) return '';
    const subtotal = list.reduce((s, e) => s + (Number(e.amount) || 0), 0);
    return `<div class="cash-section-head" style="margin-top:var(--space-4)">
      <span class="cash-section-title">${title}</span>
      <span class="cash-section-badge ${badgeClass||''}">${list.length}</span>
    </div>
    <div class="offer-glass-grid">${list.map(renderOfferGlassCard).join('')}</div>
    <div class="section-total">Subtotal: <strong>${amd(subtotal)}</strong></div>`;
  }

  return `<div class="offers-block">
    <div class="offers-block-head">
      <span class="cash-section-title">Loan Offers</span>
      <span class="cash-section-badge">${allOffers.length}</span>
    </div>
    <p class="offers-block-note">Pre-approved credit lines — tap a card to edit · not yet drawn into obligations</p>
    <span id="offer-results-count" class="cash-results-line">${resultsText}</span>
    ${sorted.length
      ? `${subsection('Approved', approvedList, 'is-approved')}
         ${subsection('Pending Approval', pendingList, 'is-pending')}
         <div class="section-total">${isFiltered ? 'Filtered total: ' : 'Total: '}<strong>${amd(total)}</strong></div>`
      : `<div class="cash-empty">No loan offers${isFiltered ? ' matching filter' : ''}.</div>`}
  </div>`;
}

function renderCashTab() {
  const cashEntries = state.cashEntries.filter(e => !cashEntryIsOffer(e));
  const cashTotal   = cashEntries.reduce((s, e) => s + (Number(e.amount) || 0), 0);
  const placesN = new Set(cashEntries.map(e => e.place).filter(Boolean)).size;

  const summary = `
    <div class="actives-summary-2 cash-summary-elite">
      <div class="actives-stat">
        <span class="actives-stat-label">Cash Holdings</span>
        <span class="actives-stat-value is-success">${amd(cashTotal)}</span>
        <span class="actives-stat-sub">${cashEntries.length} entr${cashEntries.length === 1 ? 'y' : 'ies'} · available now</span>
      </div>
      <div class="actives-stat-sep"></div>
      <div class="actives-stat">
        <span class="actives-stat-label">Places</span>
        <span class="actives-stat-value">${placesN}</span>
        <span class="actives-stat-sub">Banks & cash locations</span>
      </div>
    </div>`;

  return `${summary}
    <div class="cash-section-head">
      <span class="cash-section-title">Cash Holdings</span>
      <span class="cash-section-badge">${cashEntries.length}</span>
    </div>
    <p class="offers-block-note cash-block-note">Money on hand — tap a card to edit balances</p>
    ${renderCashHoldingsSection(cashEntries)}`;
}

function renderOffersTab() {
  const offerEntries = state.cashEntries.filter(cashEntryIsOffer);
  const offerTotal   = offerEntries.reduce((s, e) => s + (Number(e.amount) || 0), 0);
  const approvedN = offerEntries.filter(cashEntryIsApproved).length;
  const lenders = new Set(offerEntries.map(e => e.place).filter(Boolean)).size;

  const summary = `
    <div class="actives-summary-2 offer-summary-elite">
      <div class="actives-stat">
        <span class="actives-stat-label">Loan Offers</span>
        <span class="actives-stat-value is-warning">${amd(offerTotal)}</span>
        <span class="actives-stat-sub">${offerEntries.length} entr${offerEntries.length === 1 ? 'y' : 'ies'} · ${approvedN} approved</span>
      </div>
      <div class="actives-stat-sep"></div>
      <div class="actives-stat">
        <span class="actives-stat-label">Lenders</span>
        <span class="actives-stat-value">${lenders}</span>
        <span class="actives-stat-sub">Compare & draw when ready</span>
      </div>
    </div>`;

  return `${summary}${renderOfferSection(offerEntries)}`;
}
async function submitAddCash(event) {
  event.preventDefault();
  const category = document.getElementById('cash-new-category').value.trim();
  const place    = normalizeBankName(document.getElementById('cash-new-place').value);
  const amount   = Number(document.getElementById('cash-new-amount').value) || 0;
  if (!place) return;
  const type = 'cash', payer = '', lastAvailableDate = '';
  const entry = { id: 'cash-' + Date.now(), place, amount, type, category, payer, lastAvailableDate, updatedAt: new Date().toISOString() };
  state.cashEntries = [...state.cashEntries, entry];
  (function(){ const el = document.getElementById('cash-new-place'); if (!el) return; const p = el.closest && el.closest('.bank-picker'); if (p) setBankPickerValue(p, '', { silent: true }); else el.value = ''; })();
  document.getElementById('cash-new-amount').value = '';
  document.getElementById('cash-new-category').value = '';
  closeCashAddModal();
  renderCash();
  try {
    await callApi({ action: 'addCashEntry', place, amount, type, category, payer, lastAvailableDate });
  } catch (err) {
    state.cashEntries = state.cashEntries.filter(e => e.id !== entry.id);
    renderCash();
    showError('Could not save — please try again.');
  }
}

async function submitAddOffer(event) {
  event.preventDefault();
  const category = document.getElementById('offer-new-category').value.trim();
  const payer    = document.getElementById('offer-new-payer').value.trim();
  const lastAvailableDate = document.getElementById('offer-new-date').value;
  const place = normalizeBankName(document.getElementById('offer-new-place').value);
  const amount   = Number(document.getElementById('offer-new-amount').value) || 0;
  const approved = document.getElementById('offer-new-approved').checked ? 'true' : 'false';
  if (!place) return;
  const type = 'offer';
  const entry = { id: 'cash-' + Date.now(), place, amount, type, category, payer, lastAvailableDate, updatedAt: new Date().toISOString(), approved };
  state.cashEntries = [...state.cashEntries, entry];
  (function(){ const el = document.getElementById('offer-new-place'); if (!el) return; const p = el.closest && el.closest('.bank-picker'); if (p) setBankPickerValue(p, '', { silent: true }); else el.value = ''; })();
  document.getElementById('offer-new-amount').value = '';
  document.getElementById('offer-new-category').value = '';
  document.getElementById('offer-new-payer').value = '';
  document.getElementById('offer-new-date').value = '';
  document.getElementById('offer-new-approved').checked = false;
  closeOfferAddModal();
  renderOffers();
  try {
    await callApi({ action: 'addCashEntry', place, amount, type, category, payer, lastAvailableDate, approved });
  } catch (err) {
    state.cashEntries = state.cashEntries.filter(e => e.id !== entry.id);
    renderOffers();
    showError('Could not save — please try again.');
  }
}

function openCashAddModal() {
  q('cash-add-modal').classList.remove('hidden');
  wireBankPickers(q('cash-add-modal') || document);
}

function closeCashAddModal() {
  q('cash-add-modal').classList.add('hidden');
}

function openOfferAddModal() {
  q('offer-add-modal').classList.remove('hidden');
  wireBankPickers(q('offer-add-modal') || document);
}

function closeOfferAddModal() {
  q('offer-add-modal').classList.add('hidden');
}

function openCashEdit(id) {
  const view = document.querySelector(`#cash-entry-${id} .cash-entry-view`);
  const form = document.getElementById('cash-edit-' + id);
  if (view) view.classList.add('hidden');
  if (form) {
    form.classList.remove('hidden');
    wireBankPickers(form);
  }
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
  const category = form.elements.category ? form.elements.category.value.trim() : '';
  const payer    = form.elements.payer             ? form.elements.payer.value.trim()             : '';
  const lastAvailableDate = form.elements.lastAvailableDate ? form.elements.lastAvailableDate.value : '';
  const approved = form.elements.approved ? (form.elements.approved.checked ? 'true' : 'false') : 'true';
  const place  = normalizeBankName(form.elements.place.value);
  const amount = Number(form.elements.amount.value) || 0;
  if (!place) return;
  const prev = state.cashEntries.find(e => e.id === id);
  state.cashEntries = state.cashEntries.map(e => e.id === id ? { ...e, place, amount, type, category, payer, lastAvailableDate, approved } : e);
  renderCash(); renderOffers();
  try {
    await callApi({ action: 'updateCashEntry', id, place, amount, type, category, payer, lastAvailableDate, approved });
  } catch (err) {
    if (prev) state.cashEntries = state.cashEntries.map(e => e.id === id ? prev : e);
    renderCash(); renderOffers();
    showError('Could not save — please try again.');
  }
}

async function confirmDeleteCash(id) {
  const entry = state.cashEntries.find(e => e.id === id);
  if (!entry) return;
  if (!confirm(`Delete "${entry.place}" (${amd(Number(entry.amount))})?`)) return;
  state.cashEntries = state.cashEntries.filter(e => e.id !== id);
  renderCash(); renderOffers();
  try {
    await callApi({ action: 'deleteCashEntry', id });
  } catch (err) {
    state.cashEntries = [...state.cashEntries, entry];
    renderCash(); renderOffers();
    showError('Could not delete — please try again.');
  }
}

function renderIncomeTab() {
  const monthRows = state.income.filter(i => String(i.date).startsWith(state.month));
  const tot       = monthRows.reduce((s, i) => s + Number(i.amount), 0);
  const allTimeTotal = state.income.reduce((sum, i) => sum + Number(i.amount), 0);
  const average = monthRows.length ? Math.round(tot / monthRows.length) : 0;
  const largest = monthRows.reduce((max, i) => Math.max(max, Number(i.amount) || 0), 0);

  q('income-month-total').textContent = amd(tot);
  q('income-all-total').textContent = amd(allTimeTotal);
  q('income-entry-count').textContent = String(monthRows.length);
  q('income-average').textContent = amd(average);
  q('income-largest').textContent = amd(largest);

  const streamLabel = { car_rental: 'Car Rental', legal: 'Legal', real_estate: 'Real Estate', other: 'Other' };

  const incomeSorters = {
    'date-desc': (a, b) => String(b.date).localeCompare(String(a.date)),
    'date-asc': (a, b) => String(a.date).localeCompare(String(b.date)),
    'amount-desc': (a, b) => Number(b.amount) - Number(a.amount),
    'amount-asc': (a, b) => Number(a.amount) - Number(b.amount),
    'source-asc': (a, b) => String(a.stream || '').localeCompare(String(b.stream || ''))
  };
  const search = state.incomeSearch.toLocaleLowerCase();
  const filtered = state.income.filter(i => {
    if (state.incomeScope === 'month' && !String(i.date).startsWith(state.month)) return false;
    if (state.incomeSourceFilter !== 'all' && i.stream !== state.incomeSourceFilter) return false;
    const date = String(i.date || '').slice(0, 10);
    if (state.incomeDateFrom && date < state.incomeDateFrom) return false;
    if (state.incomeDateTo && date > state.incomeDateTo) return false;
    if (search && ![streamLabel[i.stream] || i.stream, i.note, i.amount, date]
      .some(value => String(value || '').toLocaleLowerCase().includes(search))) return false;
    return true;
  });
  const sorted = [...filtered].sort(incomeSorters[state.incomeSort] || incomeSorters['date-desc']);
  q('income-results-count').textContent = state.incomeScope === 'month'
    ? `${sorted.length} in ${monthLabel(state.month)}`
    : `${sorted.length} of ${state.income.length} all-time`;
  q('income-scope-month')?.classList.toggle('is-active', state.incomeScope === 'month');
  q('income-scope-all')?.classList.toggle('is-active', state.incomeScope === 'all');

  const sourceGroups = Object.entries(streamLabel).map(([value, label]) => {
    const allRows = state.income.filter(i => i.stream === value);
    const scopeRows = state.incomeScope === 'month'
      ? allRows.filter(i => String(i.date).startsWith(state.month))
      : allRows;
    const amt = scopeRows.reduce((s, i) => s + Number(i.amount || 0), 0);
    const base = state.incomeScope === 'month' ? tot : allTimeTotal;
    const share = base > 0 ? Math.round((amt / base) * 100) : 0;
    return { value, label, amt, count: scopeRows.length, share };
  }).filter(g => g.count > 0);
  q('income-source-summary').innerHTML = sourceGroups.map(g => `
    <button class="income-rail-chip ${state.incomeSourceFilter === g.value ? 'is-active' : ''}"
            type="button" onclick="setIncomeSourceFilter('${g.value}')">
      <span>${escapeHtml(g.label)}</span>
      <strong>${amd(g.amt)}</strong>
      <em>${g.share}%</em>
    </button>`).join('') || '';
  const streamOpts = Object.entries(streamLabel)
    .map(([v, l]) => `<option value="${v}">{L}</option>`.replace('{L}', l))
    .join('');

  function incomeCardHtml(i) {
    const opts = Object.entries(streamLabel)
      .map(([v, l]) => `<option value="${v}"${i.stream === v ? ' selected' : ''}>${l}</option>`).join('');
    const source = streamLabel[i.stream] || i.stream || 'Income';
    const note = i.note || 'Income entry';
    return `<article class="offer-glass-card cash-glass-card unit-glass-card income-glass-card" id="income-row-${escapeHtml(i.id)}">
      <div class="offer-glass-glow cash-glass-glow" aria-hidden="true"></div>
      <div class="unit-card-shell">
        <header class="unit-card-head">
          <div class="unit-card-ident">
            ${bankAvatarHtml(source)}
            <div class="unit-card-copy">
              <h3 class="unit-card-title" title="${escapeHtml(source)}">${escapeHtml(source)}</h3>
              <p class="unit-card-meta" title="${escapeHtml(note)}">${escapeHtml(note)}</p>
            </div>
          </div>
          <div class="unit-card-amount">${amd(i.amount)}</div>
        </header>
        <div class="unit-card-tags">
          <span class="offer-tag offer-tag-cash">Income</span>
          <span class="offer-tag offer-tag-cat">${escapeHtml(String(i.date).slice(0, 10))}</span>
        </div>
        <footer class="unit-card-foot">
          <button class="button button-primary unit-card-pay" type="button" onclick="openIncomeEdit('${escapeHtml(i.id)}')">Edit</button>
          <button class="button button-ghost unit-card-edit" type="button" onclick="confirmDeleteIncome('${escapeHtml(i.id)}')">✕</button>
        </footer>
        <form class="income-inline-edit income-edit-tr hidden" id="income-edit-${escapeHtml(i.id)}" onsubmit="saveIncomeEdit(event,'${escapeHtml(i.id)}')">
          <input class="form-input income-edit-field" name="date" type="date" value="${escapeHtml(String(i.date).slice(0, 10))}" required>
          <select class="form-select income-edit-field" name="stream">${opts}</select>
          <input class="form-input income-edit-field" name="amount" type="number" value="${Number(i.amount)}" min="1" required>
          <input class="form-input income-edit-field" name="note" type="text" value="${escapeHtml(i.note || '')}" placeholder="Note">
          <div class="income-edit-btns">
            <button class="button button-ghost btn-sm" type="button" onclick="closeIncomeEdit('${escapeHtml(i.id)}')">Cancel</button>
            <button class="button button-primary btn-sm" type="submit">Save</button>
          </div>
        </form>
      </div>
    </article>`;
  }

  const grouped = Object.entries(streamLabel).map(([value, label]) => {
    const rows = sorted.filter(i => i.stream === value);
    if (!rows.length) return '';
    const subtotal = rows.reduce((s, i) => s + Number(i.amount || 0), 0);
    return `<section class="income-history-group">
      <div class="income-history-head">
        <h4>${escapeHtml(label)}</h4>
        <span>${rows.length} entries · ${amd(subtotal)}</span>
      </div>
      <div class="unit-glass-grid income-card-grid">${rows.map(incomeCardHtml).join('')}</div>
    </section>`;
  }).join('');
  const orphan = sorted.filter(i => !streamLabel[i.stream]);
  const orphanHtml = orphan.length
    ? `<section class="income-history-group">
        <div class="income-history-head"><h4>Other</h4><span>${orphan.length} entries</span></div>
        <div class="unit-glass-grid income-card-grid">${orphan.map(incomeCardHtml).join('')}</div>
      </section>`
    : '';
  q('income-tbody').innerHTML = grouped + orphanHtml || '<div class="empty-state">No income entries match these filters.</div>';
}

function setIncomeScope(scope) {
  state.incomeScope = scope === 'all' ? 'all' : 'month';
  renderIncomeTab();
}

function setIncomeSourceFilter(source) {
  state.incomeSourceFilter = state.incomeSourceFilter === source ? 'all' : source;
  q('income-source-filter').value = state.incomeSourceFilter;
  renderIncomeTab();
}

function clearIncomeFilters() {
  state.incomeSearch = '';
  state.incomeSourceFilter = 'all';
  state.incomeDateFrom = '';
  state.incomeDateTo = '';
  q('income-search').value = '';
  q('income-source-filter').value = 'all';
  q('income-date-from').value = '';
  q('income-date-to').value = '';
  renderIncomeTab();
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
  closeIncomeModal();
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
  if (!u) {
    showError('Utility not found.');
    return;
  }
  const metaAmt = Number(state.paymentMeta[key]?.paidAmount);
  const amt = isUtilFixed(u)
    ? (Number(u.amount) || 0)
    : (Number.isFinite(metaAmt) && metaAmt > 0 ? metaAmt : (Number(u.amount) || 0));
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
    showToast(paid ? 'Utility marked done.' : 'Utility unmarked.');
  } catch (err) {
    state.payments[key] = prev.paid;
    if (prev.meta) state.paymentMeta[key] = prev.meta; else delete state.paymentMeta[key];
    patchUtilRow(id);
    showError('Could not save — please try again.');
  }
}

function patchUtilRow(id) {
  renderUtilities();
  if (state.tab === 'schedule' || state.tab === 'payments') render();
}

async function copyAbonent(value, btn) {
  const text = formatAbonent(value);
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    if ('vibrate' in navigator) navigator.vibrate(10);
    const label = btn.querySelector('span') || btn;
    const orig = label.textContent;
    label.textContent = 'Copied';
    setTimeout(() => { label.textContent = orig; }, 1200);
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
  const friendly = renderUnitCards(utils);
  const detailed = sortedPayers.map(payer => {
    const items = groups[payer];
    const doneCount = items.filter(u => state.payments[pkey(u.id, state.month)]).length;
    const allDone = doneCount === items.length;
    return `<section class="util-group${allDone ? ' all-done' : ''}">
      <div class="util-group-header">
        <span class="util-group-name">${escapeHtml(payer)}</span>
        <span class="util-group-progress${allDone ? ' is-complete' : ''}">${doneCount}/${items.length} done</span>
      </div>
      <div class="util-group-list unit-glass-grid">${items.map(utilityRow).join('')}</div>
    </section>`;
  }).join('');
  container.innerHTML = friendly + `<div class="util-detail-title">Detailed list</div>` + detailed;
}

function renderUnitCards(utils) {
  const units = utils.filter(u => isUtilPersonal(u) || isRealEstateUtility(u));
  if (!units.length) return '';
  return `<div class="offer-glass-grid cash-glass-grid unit-glass-grid">${units.map(unitCard).join('')}</div>`;
}

function unitCard(u) {
  const key = pkey(u.id, state.month);
  const paid = !!state.payments[key];
  const depositCovered = isDepositCoveredUtility(u);
  const payable = shouldShowUtilityInPayments(u);
  const rawAbonent = formatAbonent(u.abonentNumber);
  const amount = Number(u.amount) || 0;
  const status = depositCovered ? 'Using deposit' : paid ? 'Done this month' : payable ? 'Payment needed' : 'No upcoming payment';
  const statusClass = depositCovered || !payable ? ' is-muted' : paid ? ' is-done' : ' is-due';
  const dueLabel = Number(u.dueDay) > 0 ? `Day ${Number(u.dueDay)}` : 'No due day';
  const payLabel = paid ? 'Undo' : 'Mark done';
  return `<article class="offer-glass-card cash-glass-card unit-glass-card${statusClass}">
    <div class="offer-glass-glow cash-glass-glow" aria-hidden="true"></div>
    <div class="unit-card-shell">
      <header class="unit-card-head">
        <div class="unit-card-ident">
          ${bankAvatarHtml(u.provider || u.name || 'Utility')}
          <div class="unit-card-copy">
            <h3 class="unit-card-title" title="${escapeHtml(u.name || 'Unit')}">${escapeHtml(u.name || 'Unit')}</h3>
            <p class="unit-card-meta" title="${escapeHtml(u.payer || 'No payer')}${u.provider ? ` · ${escapeHtml(u.provider)}` : ''}">${escapeHtml(u.payer || 'No payer')}${u.provider ? ` · ${escapeHtml(u.provider)}` : ''}</p>
          </div>
        </div>
        <div class="unit-card-amount${amount > 0 ? '' : ' is-empty'}">${amount > 0 ? amd(amount) : '—'}</div>
      </header>
      <div class="unit-card-tags">
        <span class="offer-tag offer-tag-cash">${escapeHtml(status)}</span>
        <span class="offer-tag offer-tag-cat">${dueLabel}</span>
        ${amount > 0 ? '' : '<span class="offer-tag offer-tag-payer">No amount</span>'}
        ${rawAbonent ? abonentCopyButton(rawAbonent) : '<span class="unit-card-tag-slot" aria-hidden="true"></span>'}
      </div>
      <footer class="unit-card-foot unit-card-foot-3">
        ${payable
          ? `<button class="button ${paid ? 'button-secondary' : 'button-primary'} unit-card-pay" type="button" onclick="toggleUtilityPaid('${escapeHtml(u.id)}')">${payLabel}</button>`
          : `<button class="button button-secondary unit-card-pay" type="button" disabled>Not due</button>`}
        <button class="button button-ghost unit-card-edit" type="button" onclick="openUtilEdit('${escapeHtml(u.id)}')">Edit</button>
        <button class="button button-ghost unit-card-edit" type="button" onclick="confirmDeleteUtility('${escapeHtml(u.id)}')">Delete</button>
      </footer>
    </div>
  </article>`;
}

function utilityRow(u) {
  const key = pkey(u.id, state.month);
  const paid = !!state.payments[key];
  const paidAmt = state.paymentMeta[key]?.paidAmount;
  const personal = isUtilPersonal(u);
  const fixed = isUtilFixed(u);
  const rawAbonent = formatAbonent(u.abonentNumber);
  const showAbonent = rawAbonent && rawAbonent.toLowerCase() !== 'transfer';

  const amountText = fixed && Number(u.amount) > 0 ? amd(Number(u.amount)) : paidAmt ? amd(Number(paidAmt)) : '';
  return `<div class="util-row${paid ? ' is-done' : ''}" id="util-row-${escapeHtml(u.id)}" data-util-id="${escapeHtml(u.id)}">
    <article class="offer-glass-card cash-glass-card unit-glass-card util-glass-card${paid ? ' is-done' : ''}">
      <div class="offer-glass-glow cash-glass-glow" aria-hidden="true"></div>
      <div class="unit-card-shell">
        <header class="unit-card-head">
          <div class="unit-card-ident">
            ${bankAvatarHtml(u.provider || u.name || 'Utility')}
            <div class="unit-card-copy">
              <h3 class="unit-card-title" title="${escapeHtml(u.name)}">${escapeHtml(u.name)}</h3>
              <p class="unit-card-meta" title="${escapeHtml(u.provider || 'Utility provider')}">${escapeHtml(u.provider || 'Utility provider')}</p>
            </div>
          </div>
          <div class="unit-card-amount${amountText ? '' : ' is-empty'}">${amountText || '—'}</div>
        </header>
        <div class="unit-card-tags">
          <span class="offer-tag offer-tag-cash">${paid ? 'Done' : 'Utility'}</span>
          ${Number(u.dueDay) > 0 ? `<span class="offer-tag offer-tag-cat">Day ${Number(u.dueDay)}</span>` : '<span class="offer-tag offer-tag-cat">No due day</span>'}
          ${!personal ? `<span class="offer-tag offer-tag-payer">Business</span>` : ''}
          ${showAbonent
            ? abonentCopyButton(rawAbonent)
            : '<span class="offer-tag offer-tag-date">Transfer</span>'}
        </div>
        <footer class="unit-card-foot unit-card-foot-3">
          <button class="button ${paid ? 'button-secondary' : 'button-primary'} unit-card-pay" type="button"
                  onclick="toggleUtilityPaid('${escapeHtml(u.id)}')">${paid ? 'Undo' : 'Mark done'}</button>
          <button class="button button-ghost unit-card-edit" type="button" onclick="openUtilEdit('${escapeHtml(u.id)}')">Edit</button>
          <button class="button button-ghost unit-card-edit" type="button" onclick="confirmDeleteUtility('${escapeHtml(u.id)}')">Delete</button>
        </footer>
      </div>
    </article>
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
  const [y, mo] = String(m || '').split('-');
  if (!y || !mo) return String(m || '');
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

function reportNiceMax(value) {
  const n = Math.max(0, Number(value) || 0);
  if (n <= 10) return 10;
  const pow = Math.pow(10, Math.floor(Math.log10(n)));
  const scaled = n / pow;
  const nice = scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 5 ? 5 : 10;
  return nice * pow;
}

function reportAxisTicks(max, count = 4) {
  const top = reportNiceMax(max);
  return Array.from({ length: count + 1 }, (_, i) => Math.round((top / count) * i));
}

async function syncReports(force = false) {
  if (reportSyncTask && !force) return reportSyncTask;
  const token = ++reportSyncToken;
  const cached = seedReportData();
  const fresh = !force && cached && (Date.now() - Number(cached.savedAt || 0) < 20 * 60 * 1000);
  state.reportError = false;
  renderReports();
  if (fresh) return null;

  state.reportLoading = true;
  const previousReportData = state.reportData;
  const btn = document.getElementById('btn-sync-reports');
  if (btn) { btn.disabled = true; btn.textContent = '↻ Syncing…'; }
  reportSyncTask = (async () => {
    try {
      const params = { action: 'getReportData', toMonth: todayMonth(), window: state.reportWindow };
      if (state.reportPayer !== 'all') params.payer = state.reportPayer;
      const data = await callApi(params, { retries: 0, timeout: 28000 });
      if (data.error) throw new Error(data.error);
      if (token === reportSyncToken) {
        state.reportData = data;
        writeReportCache(data);
      }
    } catch (err) {
      if (token === reportSyncToken) {
        state.reportError = !previousReportData;
        state.reportData = previousReportData || buildLocalReportData();
        if (!previousReportData) showError('Reports are taking too long. Try Sync again.');
      }
    } finally {
      if (token === reportSyncToken) {
        state.reportLoading = false;
        if (btn) { btn.disabled = false; btn.textContent = '↻ Sync'; }
        renderReports();
      }
      reportSyncTask = null;
    }
  })();
  return reportSyncTask;
}

function reportPayerOptions() {
  const payerSet = new Set();
  state.obligations.forEach(o => {
    if (o.active === true || String(o.active).toUpperCase() === 'TRUE') payerSet.add(String(o.payer || '').trim());
  });
  state.utilities.forEach(u => {
    if (u.active === true || String(u.active).toUpperCase() === 'TRUE') payerSet.add(String(u.payer || '').trim());
  });
  payerSet.delete('');
  return [...payerSet].sort();
}

function reportCacheKey() {
  return `finance-arm:report:${state.reportWindow}:${state.reportPayer || 'all'}`;
}

function readReportCache() {
  try {
    const parsed = JSON.parse(localStorage.getItem(reportCacheKey()) || 'null');
    if (!parsed || !parsed.data) return null;
    return parsed;
  } catch (err) {
    return null;
  }
}

function writeReportCache(data) {
  try {
    localStorage.setItem(reportCacheKey(), JSON.stringify({ savedAt: Date.now(), data }));
  } catch (err) { /* ignore quota */ }
}

function reportMonthList() {
  const to = todayMonth();
  const n = Math.min(Math.max(Number(state.reportWindow) || 6, 1), 24);
  return Array.from({ length: n }, (_, i) => shiftMonth(to, -(n - 1 - i)));
}

function buildLocalReportData() {
  const months = reportMonthList();
  const payer = state.reportPayer === 'all' ? '' : String(state.reportPayer || '').trim();
  const incomeByMonth = {};
  state.income.forEach(row => {
    const mo = String(row.date || '').slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(mo)) return;
    incomeByMonth[mo] = (incomeByMonth[mo] || 0) + (Number(row.amount) || 0);
  });
  const cashFlow = months.map(mo => {
    const income = incomeByMonth[mo] || 0;
    let paid = 0;
    Object.values(state.paymentMeta || {}).forEach(p => {
      const keyMo = String(p.month || String(p.key || '').split('__')[1] || '');
      if (keyMo !== mo) return;
      const isPd = p.paid === true || String(p.paid).toUpperCase() === 'TRUE';
      const isPartial = String(p.status || '').toLowerCase() === 'partial';
      if (isPd || isPartial) paid += Number(p.paidAmount) || 0;
    });
    return { month: mo, income, paid, net: income - paid };
  });
  const loans = activeLoans().filter(l => !payer || String(l.payer || '').trim() === payer);
  const nowDebt = loans.reduce((s, l) => s + (Number(loanBalance(l) ?? l.currentBalance) || 0), 0);
  const debt = months.map((mo, i) => ({
    month: mo,
    totalBalance: mo === todayMonth() || mo === state.month ? nowDebt : 0,
    delta: i === 0 ? null : 0
  }));
  if (debt.length) debt[debt.length - 1].totalBalance = nowDebt;
  const loanProjections = loans.map(loan => {
    const balance = Number(loanBalance(loan) ?? loan.currentBalance) || 0;
    const monthly = Number(loan.amount) || 0;
    const payoffDate = monthly > 0 && balance > 0 ? shiftMonth(todayMonth(), Math.ceil(balance / monthly)) : null;
    return { id: loan.id, bank: String(loan.bank || ''), payer: String(loan.payer || ''), balance, monthly, payoffDate };
  });
  return {
    months, cashFlow, debt, paymentHealth: [], loanProjections,
    payers: reportPayerOptions(), activeFilter: payer || null, local: true
  };
}

function seedReportData() {
  const cached = readReportCache();
  if (cached && cached.data) {
    state.reportData = cached.data;
    return cached;
  }
  if (!state.reportData) state.reportData = buildLocalReportData();
  return null;
}

function reportEnrichedCashFlow(d) {
  const raw = d.cashFlow || [];
  const payMap = new Map(Object.entries(state.paymentMeta || {}));
  const utils = state.utilities.filter(u => u.active === true || String(u.active).toUpperCase() === 'TRUE');

  function monthPaid(month, fallback) {
    const items = [
      ...activeObs().filter(o => isObligationDueThisMonth(o, month)),
      ...utils
    ];
    let total = 0;
    let saw = false;
    items.forEach(item => {
      const p = payMap.get(`${item.id}__${month}`);
      if (!p) return;
      saw = true;
      const isPd = p.paid === true || String(p.paid).toUpperCase() === 'TRUE';
      const isPartial = String(p.status || '').toLowerCase() === 'partial';
      if (isPd || isPartial) {
        total += Number(p.paidAmount) > 0 ? Number(p.paidAmount) : (Number(item.amount) || 0);
      }
    });
    return saw ? total : (Number(fallback) || 0);
  }

  return raw.map(r => {
    const paid = monthPaid(r.month, r.paid);
    const net = (r.income || 0) - paid;
    const cov = r.income > 0 ? Math.round((paid / r.income) * 100) : 0;
    return { ...r, paid, net, cov };
  });
}

function reportSnapshot() {
  const loans = activeLoans();
  const totalDebt = loans.reduce((s, l) => s + (Number(loanBalance(l) ?? l.currentBalance) || 0), 0);
  const cash = state.cashEntries.filter(e => !cashEntryIsOffer(e)).reduce((s, e) => s + (Number(e.amount) || 0), 0);
  const monthlyObl = activeObs().reduce((s, o) => s + monthlyEquivalent(o), 0);
  const utils = state.utilities.filter(u => u.active === true || String(u.active).toUpperCase() === 'TRUE');
  const monthlyUtil = utils.reduce((s, u) => s + monthlyUtilAmount(u), 0);
  const monthlyLoad = monthlyObl + monthlyUtil;
  const creditLineObs = activeObs().filter(isCreditLine);
  const availableCredit = creditLineObs.reduce((s, o) => s + (Number(o.loanTotal) || 0), 0);
  return { loans, totalDebt, cash, monthlyLoad, availableCredit, liquid: cash + availableCredit, net: cash - totalDebt };
}

function renderReports() {
  const body = document.getElementById('report-body');
  if (!body) return;
  if (!state.reportData) seedReportData();
  if (!state.reportData && !state.reportLoading) {
    if (state.reportError) {
      body.innerHTML = `${renderBalancePanel()}<div class="report-panel"><div class="report-empty">Could not load the period analysis.<br>Tap <strong>↻ Sync</strong> to retry.</div></div>`;
      return;
    }
    syncReports();
  }
  if (!state.reportData) {
    body.innerHTML = reportsSkeleton();
    return;
  }

  const d = state.reportData;
  const payers = reportPayerOptions();
  const payerBar = payers.length > 1 ? `
    <div class="report-filter-bar rx-toolbar">
      <span class="rfl-label">View as</span>
      <select class="report-payer-select rfl-select" aria-label="Filter reports by payer">
        <option value="all"${state.reportPayer === 'all' ? ' selected' : ''}>Whole household</option>
        ${payers.map(p => `<option value="${escapeHtml(p)}"${state.reportPayer === p ? ' selected' : ''}>${escapeHtml(p)}</option>`).join('')}
      </select>
      ${state.reportPayer !== 'all' ? `<span class="rfl-active-pill">${escapeHtml(state.reportPayer)}</span>` : ''}
      <span class="rx-toolbar-note">${escapeHtml(shortMonLabel((d.months || [])[0] || ''))} – ${escapeHtml(shortMonLabel((d.months || []).slice(-1)[0] || todayMonth()))}</span>
    </div>` : '';

  body.innerHTML = `
    ${payerBar}
    ${renderReportCommand(d)}
    ${renderInsightStrip(d)}
    ${renderBalancePanel()}
    ${renderCashFlowPanel(d)}
    <div class="report-2col">
      ${renderDebtPanel(d)}
      ${renderLoanProjections(d)}
    </div>
    <div class="report-2col">
      ${renderCategoryPanel()}
      ${renderPayerPanel()}
    </div>
    ${renderHealthPanel(d)}
  `;
}

function reportsSkeleton() {
  const card = extra => `<div class="report-panel rx-skel-card ${extra || ''}"><div class="skel skel-title"></div><div class="skel skel-row"></div><div class="skel skel-row"></div><div class="skel skel-row"></div></div>`;
  return `<div class="rx-kpi-grid">${card()}${card()}${card()}${card()}</div>${card('rx-skel-wide')}<div class="report-2col">${card()}${card()}</div>`;
}

function renderReportCommand(d) {
  const snap = reportSnapshot();
  const cf = reportEnrichedCashFlow(d);
  const avgIncome = cf.length ? Math.round(cf.reduce((s, r) => s + (r.income || 0), 0) / cf.length) : 0;
  const avgPaid = cf.length ? Math.round(cf.reduce((s, r) => s + (r.paid || 0), 0) / cf.length) : 0;
  const healthData = d.paymentHealth || [];
  const avgHealth = healthData.length
    ? Math.round(healthData.reduce((s, r) => s + (r.rate || 0), 0) / healthData.length * 10) / 10 : 0;
  const debt = d.debt || [];
  const firstDebt = debt.find(r => Number(r.totalBalance) > 0);
  const lastDebt = [...debt].reverse().find(r => r.totalBalance != null);
  const debtDelta = firstDebt && lastDebt ? Number(lastDebt.totalBalance) - Number(firstDebt.totalBalance) : 0;
  const cover = snap.monthlyLoad > 0 ? Math.round((avgIncome / snap.monthlyLoad) * 100) : 0;
  const runway = snap.monthlyLoad > 0 ? snap.cash / snap.monthlyLoad : null;
  const healthCls = avgHealth >= 80 ? 'is-good' : avgHealth >= 60 ? 'is-warn' : 'is-bad';
  const coverCls = cover >= 120 ? 'is-good' : cover >= 100 ? 'is-warn' : 'is-bad';
  const debtCls = debtDelta < 0 ? 'is-good' : debtDelta > 0 ? 'is-bad' : '';
  const netCls = snap.net >= 0 ? 'is-good' : 'is-bad';

  return `<div class="rx-kpi-grid">
    <article class="rx-kpi ${netCls}">
      <span class="rx-kpi-label">Net position</span>
      <strong>${snap.net >= 0 ? '+' : '−'}${amdCompact(Math.abs(snap.net))}</strong>
      <span class="rx-kpi-sub">${amdCompact(snap.cash)} cash − ${amdCompact(snap.totalDebt)} debt</span>
    </article>
    <article class="rx-kpi ${coverCls}">
      <span class="rx-kpi-label">Income cover</span>
      <strong>${cover}%</strong>
      <span class="rx-kpi-sub">${amdCompact(avgIncome)} avg in vs ${amdCompact(snap.monthlyLoad)} monthly load</span>
    </article>
    <article class="rx-kpi ${debtCls}">
      <span class="rx-kpi-label">Debt over ${state.reportWindow}M</span>
      <strong>${debtDelta === 0 ? 'Flat' : `${debtDelta < 0 ? '▼' : '▲'} ${amdCompact(Math.abs(debtDelta))}`}</strong>
      <span class="rx-kpi-sub">Now ${amdCompact(snap.totalDebt)} · ${snap.loans.length} loans</span>
    </article>
    <article class="rx-kpi ${healthCls}">
      <span class="rx-kpi-label">Payment health</span>
      <strong>${avgHealth}%</strong>
      <span class="rx-kpi-sub">${runway == null ? `${amdCompact(avgPaid)} paid / month` : `${runway >= 24 ? '24+ mo' : runway.toFixed(1) + ' mo'} cash runway`}</span>
    </article>
  </div>`;
}

function renderInsightStrip(d) {
  const snap = reportSnapshot();
  const cf = reportEnrichedCashFlow(d);
  const health = d.paymentHealth || [];
  const items = [];

  const tightMonths = cf.filter(r => r.income > 0 && r.net < 0);
  if (tightMonths.length) {
    items.push({
      tone: 'warn',
      title: `${tightMonths.length} month${tightMonths.length === 1 ? '' : 's'} ran negative`,
      body: `Paid more than came in during ${tightMonths.map(r => shortMonLabel(r.month)).join(', ')}.`
    });
  } else if (cf.some(r => r.income > 0)) {
    items.push({
      tone: 'good',
      title: 'Cash flow stayed non-negative',
      body: 'Every month in this window covered what was marked paid.'
    });
  }

  const missed = health.reduce((s, r) => s + (Number(r.missed) || 0), 0);
  if (missed) {
    items.push({
      tone: 'bad',
      title: `${missed} missed payment${missed === 1 ? '' : 's'}`,
      body: 'Open Payment Health below to see which bills were marked not done.'
    });
  }

  const soon = (d.loanProjections || [])
    .filter(l => l.payoffDate)
    .map(l => {
      const [ty, tm] = todayMonth().split('-').map(Number);
      const [py, pm] = l.payoffDate.split('-').map(Number);
      return { ...l, moLeft: (py * 12 + pm) - (ty * 12 + tm) };
    })
    .filter(l => l.moLeft >= 0)
    .sort((a, b) => a.moLeft - b.moLeft)[0];
  if (soon) {
    items.push({
      tone: soon.moLeft <= 6 ? 'good' : 'info',
      title: `${soon.bank || 'A loan'} finishes ${soon.moLeft === 0 ? 'this month' : `in ${soon.moLeft} mo`}`,
      body: `${amdCompact(soon.balance)} left at ${amdCompact(soon.monthly)} / month.`
    });
  }

  const stale = snap.loans.filter(loan => {
    const balance = loanBalance(loan);
    return balance !== null && balanceSourceMonth(loan) !== todayMonth();
  }).length;
  if (stale) {
    items.push({
      tone: 'warn',
      title: `${stale} loan balance${stale === 1 ? '' : 's'} not updated this month`,
      body: 'Reconcile those balances so debt trend and payoff dates stay honest.'
    });
  }

  if (snap.monthlyLoad > 0 && snap.cash > 0) {
    const months = snap.cash / snap.monthlyLoad;
    items.push({
      tone: months < 2 ? 'bad' : months < 6 ? 'warn' : 'info',
      title: months < 1 ? 'Less than a month of cash on hand' : `${months >= 24 ? '24+' : months.toFixed(1)} months of cash runway`,
      body: `${amdCompact(snap.cash)} cash against ${amdCompact(snap.monthlyLoad)} recurring load.`
    });
  }

  if (!items.length) return '';
  return `<div class="rx-insight-strip">${items.slice(0, 4).map(item => `
    <article class="rx-insight is-${item.tone}">
      <strong>${escapeHtml(item.title)}</strong>
      <span>${escapeHtml(item.body)}</span>
    </article>`).join('')}</div>`;
}

function renderCashFlowChart(rows) {
  if (!rows.length) return '';
  const w = 640, h = 188, padL = 42, padR = 12, padT = 16, padB = 28;
  const innerW = w - padL - padR;
  const innerH = h - padT - padB;
  const maxVal = reportNiceMax(Math.max(...rows.map(r => Math.max(r.income || 0, r.paid || 0, 0)), 1));
  const groupW = innerW / rows.length;
  const barW = Math.max(6, Math.min(16, groupW * 0.28));
  const ticks = reportAxisTicks(maxVal);
  const y = v => padT + innerH - (maxVal ? (v / maxVal) * innerH : 0);
  const netPts = rows.map((r, i) => {
    const x = padL + groupW * i + groupW / 2;
    return `${x},${y(Math.max(0, r.income || 0))}`;
  }).join(' ');

  const bars = rows.map((r, i) => {
    const cx = padL + groupW * i + groupW / 2;
    const incH = maxVal ? ((r.income || 0) / maxVal) * innerH : 0;
    const paidH = maxVal ? ((r.paid || 0) / maxVal) * innerH : 0;
    const net = r.net || 0;
    return `<g>
      <rect class="rx-bar rx-bar-income" x="${cx - barW - 2}" y="${y(r.income || 0)}" width="${barW}" height="${incH}" rx="3">
        <title>${shortMonLabel(r.month)} income ${amd(r.income || 0)}</title>
      </rect>
      <rect class="rx-bar rx-bar-paid" x="${cx + 2}" y="${y(r.paid || 0)}" width="${barW}" height="${paidH}" rx="3">
        <title>${shortMonLabel(r.month)} paid ${amd(r.paid || 0)}</title>
      </rect>
      <circle class="rx-net-dot ${net >= 0 ? 'is-pos' : 'is-neg'}" cx="${cx}" cy="${y(Math.max(0, r.income || 0))}" r="3"></circle>
      <text class="rx-x" x="${cx}" y="${h - 8}" text-anchor="middle">${escapeHtml(shortMonLabel(r.month))}</text>
    </g>`;
  }).join('');

  const grid = ticks.map(t => `<g>
    <line class="rx-grid" x1="${padL}" x2="${w - padR}" y1="${y(t)}" y2="${y(t)}"></line>
    <text class="rx-y" x="${padL - 6}" y="${y(t) + 3}" text-anchor="end">${t ? amdCompact(t) : '0'}</text>
  </g>`).join('');

  return `<svg class="rx-chart" viewBox="0 0 ${w} ${h}" role="img" aria-label="Income versus paid by month">
    ${grid}
    <polyline class="rx-net-line" points="${netPts}" fill="none"></polyline>
    ${bars}
  </svg>
  <div class="rx-legend">
    <span><i class="rx-swatch is-income"></i>Income</span>
    <span><i class="rx-swatch is-paid"></i>Paid</span>
    <span><i class="rx-swatch is-net"></i>Income peak</span>
  </div>`;
}

function renderDebtChart(rows) {
  const usable = rows.filter(r => r.totalBalance != null);
  if (usable.length < 2) return '';
  const w = 560, h = 168, padL = 42, padR = 12, padT = 14, padB = 26;
  const innerW = w - padL - padR;
  const innerH = h - padT - padB;
  const maxVal = reportNiceMax(Math.max(...usable.map(r => Number(r.totalBalance) || 0), 1));
  const step = usable.length === 1 ? innerW : innerW / (usable.length - 1);
  const pts = usable.map((r, i) => {
    const x = padL + step * i;
    const y = padT + innerH - ((Number(r.totalBalance) || 0) / maxVal) * innerH;
    return { x, y, r };
  });
  const line = pts.map(p => `${p.x},${p.y}`).join(' ');
  const area = `${padL},${padT + innerH} ${line} ${pts[pts.length - 1].x},${padT + innerH}`;
  const ticks = reportAxisTicks(maxVal, 3);
  const grid = ticks.map(t => {
    const y = padT + innerH - (maxVal ? (t / maxVal) * innerH : 0);
    return `<line class="rx-grid" x1="${padL}" x2="${w - padR}" y1="${y}" y2="${y}"></line>
      <text class="rx-y" x="${padL - 6}" y="${y + 3}" text-anchor="end">${t ? amdCompact(t) : '0'}</text>`;
  }).join('');
  const labels = pts.map(p => `<text class="rx-x" x="${p.x}" y="${h - 8}" text-anchor="middle">${escapeHtml(shortMonLabel(p.r.month))}</text>`).join('');
  const dots = pts.map(p => `<circle class="rx-debt-dot" cx="${p.x}" cy="${p.y}" r="3.5"><title>${shortMonLabel(p.r.month)} ${amd(p.r.totalBalance)}</title></circle>`).join('');
  return `<svg class="rx-chart" viewBox="0 0 ${w} ${h}" role="img" aria-label="Total remaining debt by month">
    <defs><linearGradient id="rxDebtFill" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#6366f1" stop-opacity="0.35"/>
      <stop offset="100%" stop-color="#6366f1" stop-opacity="0.02"/>
    </linearGradient></defs>
    ${grid}
    <polygon points="${area}" fill="url(#rxDebtFill)"></polygon>
    <polyline class="rx-debt-line" points="${line}" fill="none"></polyline>
    ${dots}${labels}
  </svg>`;
}

function renderCashFlowPanel(d) {
  const raw = d.cashFlow || [];
  if (!raw.length) return `<div class="report-panel"><div class="report-empty">No income data yet — add income records to generate cash flow analysis.</div></div>`;

  const enriched = reportEnrichedCashFlow(d);
  const sorted = sortRows(enriched, state.reportCfSort);
  let totIncome = 0, totPaid = 0;
  enriched.forEach(r => { totIncome += r.income; totPaid += r.paid; });
  const totNet = totIncome - totPaid, totPos = totNet >= 0;
  const totCov = totIncome > 0 ? Math.round((totPaid / totIncome) * 100) : 0;
  const totCovCol = totCov < 60 ? 'var(--color-success)' : totCov < 80 ? 'var(--color-warning)' : 'var(--color-danger)';
  const s = state.reportCfSort;

  const bodyRows = sorted.map(r => {
    const net = r.net, pos = net >= 0;
    const covCol = r.cov < 60 ? 'var(--color-success)' : r.cov < 80 ? 'var(--color-warning)' : 'var(--color-danger)';
    return `<tr>
      <td class="cf-month">${shortMonLabel(r.month)}</td>
      <td class="cf-num">${r.income ? amdCompact(r.income) : '<span class="cf-zero">—</span>'}</td>
      <td class="cf-num">${r.paid ? amdCompact(r.paid) : '<span class="cf-zero">—</span>'}</td>
      <td class="cf-num ${pos ? 'cf-pos' : 'cf-neg'}">${pos ? '+' : '−'}${amdCompact(Math.abs(net))}</td>
      <td class="cf-cov">
        <div class="cf-bar-wrap"><div class="cf-bar" style="width:${Math.min(r.cov, 100)}%;background:${covCol}"></div></div>
        <span class="cf-pct">${r.cov}%</span>
      </td>
    </tr>`;
  }).join('');

  return `<div class="report-panel rx-panel">
    <div class="report-panel-header">
      <div class="rp-title">
        <svg class="rp-icon" viewBox="0 0 20 20"><path d="M3 15h14M3 10h14M3 5h10"/></svg>
        Cash flow
      </div>
      <div class="rp-header-right">
        <div class="rp-badge">${raw.length} months</div>
        <div class="rp-badge ${totPos ? 'is-good' : 'is-bad'}">${totPos ? '+' : '−'}${amdCompact(Math.abs(totNet))} net</div>
      </div>
    </div>
    <div class="report-panel-body rp-pad rx-chart-wrap">
      ${renderCashFlowChart(enriched)}
    </div>
    <div class="report-panel-body">
      <table class="report-table">
        <thead><tr>
          ${sortTh('Month', 'month', 'cf', s)}
          ${sortTh('Income', 'income', 'cf', s, 'cf-num')}
          ${sortTh('Paid out', 'paid', 'cf', s, 'cf-num')}
          ${sortTh('Net', 'net', 'cf', s, 'cf-num')}
          ${sortTh('Of income', 'cov', 'cf', s, 'cf-cov-head')}
        </tr></thead>
        <tbody>${bodyRows}</tbody>
        <tfoot><tr>
          <td class="cf-month rp-total">Total</td>
          <td class="cf-num rp-total">${amdCompact(totIncome)}</td>
          <td class="cf-num rp-total">${amdCompact(totPaid)}</td>
          <td class="cf-num rp-total ${totPos ? 'cf-pos' : 'cf-neg'}">${totPos ? '+' : '−'}${amdCompact(Math.abs(totNet))}</td>
          <td class="cf-cov rp-total">
            <div class="cf-bar-wrap"><div class="cf-bar" style="width:${Math.min(totCov, 100)}%;background:${totCovCol}"></div></div>
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
      else deltaHtml = `<span class="debt-neutral">Unchanged</span>`;
    }
    return `<tr>
      <td class="cf-month">${shortMonLabel(r.month)}</td>
      <td class="cf-num"><strong>${r.totalBalance ? amdCompact(r.totalBalance) : '—'}</strong></td>
      <td>${deltaHtml}</td>
    </tr>`;
  }).join('');
  return `<div class="report-panel rp-flex rx-panel">
    <div class="report-panel-header">
      <div class="rp-title">
        <svg class="rp-icon" viewBox="0 0 20 20"><path d="M3 17V7l7-4 7 4v10M8 17v-5h4v5"/></svg>
        Debt trend
      </div>
    </div>
    <div class="report-panel-body rp-pad rx-chart-wrap">${renderDebtChart(raw)}</div>
    <div class="report-panel-body">
      <table class="report-table">
        <thead><tr>
          ${sortTh('Month', 'month', 'debt', s)}
          ${sortTh('Balance', 'totalBalance', 'debt', s, 'cf-num')}
          ${sortTh('Change', 'delta', 'debt', s)}
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
    if (lsCol === 'bank') return (a.bank || '').localeCompare(b.bank || '') * lsMult;
    if (lsCol === 'payer') return (a.payer || '').localeCompare(b.payer || '') * lsMult;
    return 0;
  });

  const lsOpts = [
    ['payoff-asc', 'Payoff ↑'], ['payoff-desc', 'Payoff ↓'],
    ['balance-desc', 'Balance ↓'], ['balance-asc', 'Balance ↑'],
    ['bank-asc', 'Name A–Z'], ['payer-asc', 'Payer A–Z']
  ].map(([v, l]) => `<option value="${v}"${state.reportLoanSort === v ? ' selected' : ''}>${l}</option>`).join('');

  const dated = loans.filter(l => l.payoffDate).map(l => {
    const [ty, tm] = todayMonth().split('-').map(Number);
    const [py, pm] = l.payoffDate.split('-').map(Number);
    return { ...l, moLeft: (py * 12 + pm) - (ty * 12 + tm) };
  });
  const maxMo = Math.max(6, ...dated.map(l => l.moLeft), 1);

  const items = loans.map(loan => {
    let payoffHtml;
    let moLeft = null;
    if (loan.payoffDate) {
      const [y, mo] = loan.payoffDate.split('-');
      const label = new Date(+y, +mo - 1, 1).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
      const found = dated.find(x => x.id === loan.id);
      moLeft = found ? found.moLeft : 0;
      const urgCls = moLeft <= 6 ? 'payoff-urgent' : moLeft <= 18 ? 'payoff-soon' : 'payoff-ok';
      payoffHtml = `<div class="payoff-date ${urgCls}">${escapeHtml(label)}</div><div class="payoff-months">${moLeft} mo left</div>`;
    } else {
      payoffHtml = `<div class="payoff-variable">No fixed payoff</div>`;
    }
    const pct = moLeft == null ? 0 : Math.max(4, Math.min(100, Math.round((1 - moLeft / maxMo) * 100)));
    return `<div class="loan-proj-row">
      <div class="loan-proj-info">
        <div class="loan-proj-name">${escapeHtml(loan.bank || loan.id)}</div>
        <div class="loan-proj-payer">${escapeHtml(loan.payer)}${loan.monthly ? ` · ${amdCompact(loan.monthly)}/mo` : ''}</div>
        ${moLeft != null ? `<div class="rx-mini-track"><span style="width:${pct}%"></span></div>` : ''}
      </div>
      <div class="loan-proj-right">
        <div class="loan-proj-balance">${amdCompact(loan.balance)}</div>
        <div class="loan-proj-payoff">${payoffHtml}</div>
      </div>
    </div>`;
  }).join('');

  return `<div class="report-panel rp-flex rx-panel">
    <div class="report-panel-header">
      <div class="rp-title">
        <svg class="rp-icon" viewBox="0 0 20 20"><path d="M10 2a8 8 0 1 0 0 16A8 8 0 0 0 10 2Zm0 4v4l3 3"/></svg>
        Payoff runway
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
    ['month-asc', 'Month ↑'], ['month-desc', 'Month ↓'],
    ['rate-desc', 'Health ↓'], ['rate-asc', 'Health ↑'],
    ['missed-desc', 'Missed ↓']
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
    : '<div class="report-empty-ok">No payments marked missed in this window.</div>';
  const avg = Math.round(raw.reduce((s, r) => s + (r.rate || 0), 0) / raw.length);
  return `<div class="report-panel rx-panel">
    <div class="report-panel-header">
      <div class="rp-title">
        <svg class="rp-icon" viewBox="0 0 20 20"><path d="M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16Zm-1.5-5 5-5-1.5-1.5-3.5 3.5-1.5-1.5L7 11l1.5 2Z"/></svg>
        Payment health
      </div>
      <div class="rp-header-right">
        <span class="rp-badge">${avg}% avg</span>
        <select class="panel-sort-select health-sort-select">${hsOpts}</select>
      </div>
    </div>
    <div class="report-panel-body health-layout">
      <div class="health-bars">${barsHtml}</div>
      <div class="health-missed">
        <div class="health-missed-title">Missed in this window</div>
        ${missedHtml}
      </div>
    </div>
  </div>`;
}

function renderBalancePanel() {
  const loans = activeLoans();
  const totalDebt = loans.reduce((s, l) => s + (Number(loanBalance(l) ?? l.currentBalance) || 0), 0);
  const cashOnlyEntries = state.cashEntries.filter(e => !cashEntryIsOffer(e));
  const offerEntries = state.cashEntries.filter(e => cashEntryIsOffer(e));
  const approvedOffers = offerEntries.filter(cashEntryIsApproved);
  const pendingOffers = offerEntries.filter(e => !cashEntryIsApproved(e));
  const cash = cashOnlyEntries.reduce((s, e) => s + (Number(e.amount) || 0), 0);
  const netPos = cash - totalDebt;
  const netIsPos = netPos >= 0;
  const creditLineObs = activeObs().filter(isCreditLine);
  const availableCredit = creditLineObs.reduce((s, o) => s + (Number(o.loanTotal) || 0), 0);
  const liquidFunds = cash + availableCredit;
  const approvedOfferTotal = approvedOffers.reduce((s, e) => s + (Number(e.amount) || 0), 0);
  const pendingOfferTotal = pendingOffers.reduce((s, e) => s + (Number(e.amount) || 0), 0);
  const stack = Math.max(cash + totalDebt, 1);
  const cashPct = Math.round((cash / stack) * 100);
  const debtPct = Math.round((totalDebt / stack) * 100);

  const cashDetail = cashOnlyEntries.length
    ? cashOnlyEntries.map(e => `<span class="bs-cash-item">${escapeHtml(e.place)}: ${amdCompact(Number(e.amount))}</span>`).join('')
    : `<button class="bs-link-btn" onclick="switchTab('cash')">Add cash →</button>`;
  const creditDetail = creditLineObs.map(o =>
    `<span class="bs-cash-item">${escapeHtml(o.bank)}: ${amdCompact(Number(o.loanTotal))}</span>`
  ).join('');

  return `<div class="report-panel bs-panel rx-panel">
    <div class="report-panel-header">
      <div class="rp-title">
        <svg class="rp-icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="2" y="5" width="16" height="11" rx="2"/><path d="M2 9h16M6 13h2"/></svg>
        Financial position
      </div>
      <button class="rp-badge bs-manage-btn" onclick="switchTab('cash')">Manage cash →</button>
    </div>
    <div class="report-panel-body rp-pad">
      <div class="bs-headline">
        <div class="bs-headline-col">
          <span class="bs-headline-label">Net position</span>
          <span class="bs-headline-value ${netIsPos ? 'bs-net-pos' : 'bs-net-neg'}">${netIsPos ? '+' : '−'}${amdCompact(Math.abs(netPos))}</span>
          <span class="bs-headline-sub">${amdCompact(cash)} cash − ${amdCompact(totalDebt)} debt</span>
        </div>
        <div class="bs-headline-col bs-headline-col-secondary">
          <span class="bs-headline-label">Liquid funds</span>
          <span class="bs-headline-value bs-headline-value-sm">${amdCompact(liquidFunds)}</span>
          <span class="bs-headline-sub">cash + undrawn credit lines</span>
        </div>
        <div class="rx-stack" aria-hidden="true">
          <span class="rx-stack-cash" style="width:${cashPct}%"></span>
          <span class="rx-stack-debt" style="width:${debtPct}%"></span>
        </div>
      </div>
      <div class="bs-section-divider"></div>
      <div class="bs-cols">
        <div class="bs-col">
          <div class="bs-col-label bs-col-label-asset">Assets</div>
          <div class="bs-row"><span class="bs-label">Cash on hand</span><span class="bs-value">${amdCompact(cash)}</span></div>
          <div class="bs-cash-breakdown">${cashDetail}</div>
          ${availableCredit > 0 ? `
          <div class="bs-row"><span class="bs-label">Available credit lines</span><span class="bs-value bs-credit">${amdCompact(availableCredit)}</span></div>
          <div class="bs-cash-breakdown">${creditDetail}</div>
          <div class="bs-row-note">Existing lines, not yet drawn</div>` : ''}
        </div>
        <div class="bs-col">
          <div class="bs-col-label bs-col-label-liability">Liabilities</div>
          <div class="bs-row"><span class="bs-label">Total debt</span><span class="bs-value bs-debt">${amdCompact(totalDebt)}</span></div>
          <div class="bs-row-note">${loans.length} active loan${loans.length !== 1 ? 's' : ''}</div>
        </div>
      </div>
      <div class="bs-section-divider"></div>
      <div class="bs-offers-head">
        <span class="bs-section-label" style="padding:0">Loan offers</span>
        <span class="bs-offers-note">not counted in position above</span>
      </div>
      ${offerEntries.length ? `
      <div class="bs-offer-chips">
        ${approvedOffers.length ? `<button class="bs-offer-chip is-approved" onclick="switchTab('offers')">Approved <strong>${amdCompact(approvedOfferTotal)}</strong></button>` : ''}
        ${pendingOffers.length ? `<button class="bs-offer-chip is-pending" onclick="switchTab('offers')">Pending <strong>${amdCompact(pendingOfferTotal)}</strong></button>` : ''}
      </div>` : `<button class="bs-link-btn" onclick="switchTab('offers')">Add loan offer →</button>`}
    </div>
  </div>`;
}

function renderCategoryPanel() {
  const active = activeObs();
  const utils = state.utilities.filter(u => u.active === true || String(u.active).toUpperCase() === 'TRUE');
  if (!active.length && !utils.length) return '';

  const byCategory = {};
  const catMeta = {
    loan: { label: 'Loans', color: '#6366f1' },
    personal: { label: 'Personal', color: '#d97706' },
    credit: { label: 'Credit', color: '#dc4c5d' },
    utility: { label: 'Utilities', color: '#16a36a' }
  };
  active.forEach(o => {
    const cat = String(o.category || 'other').toLowerCase().trim();
    if (!byCategory[cat]) byCategory[cat] = { ...(catMeta[cat] || { label: cat.charAt(0).toUpperCase() + cat.slice(1), color: '#64748b' }), count: 0, total: 0 };
    byCategory[cat].count++;
    byCategory[cat].total += monthlyEquivalent(o);
  });
  if (utils.length) {
    if (!byCategory.utility) byCategory.utility = { ...catMeta.utility, count: 0, total: 0 };
    utils.forEach(u => { byCategory.utility.count++; byCategory.utility.total += monthlyUtilAmount(u); });
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

  return `<div class="report-panel rx-panel">
    <div class="report-panel-header">
      <div class="rp-title">
        <svg class="rp-icon" viewBox="0 0 20 20"><path d="M3 5h14M3 9h10M3 13h6"/></svg>
        Monthly load by type
      </div>
      <div class="rp-badge">${amdCompact(grandTotal)}/mo</div>
    </div>
    <div class="report-panel-body rp-pad"><div class="cat-list">${rows}</div></div>
  </div>`;
}

function renderPayerPanel() {
  const all = activeObs();
  const utils = state.utilities.filter(u => u.active === true || String(u.active).toUpperCase() === 'TRUE');
  const colors = ['#4f7cff', '#7c3aed', '#0891b2', '#dc2626', '#d97706'];
  const byPayer = {};
  all.forEach(o => {
    const p = String(o.payer || '').trim(); if (!p) return;
    if (!byPayer[p]) byPayer[p] = { count: 0, total: 0 };
    byPayer[p].count++; byPayer[p].total += monthlyEquivalent(o);
  });
  utils.forEach(u => {
    const p = String(u.payer || '').trim(); if (!p) return;
    if (!byPayer[p]) byPayer[p] = { count: 0, total: 0 };
    byPayer[p].count++; byPayer[p].total += monthlyUtilAmount(u);
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

  return `<div class="report-panel rx-panel">
    <div class="report-panel-header">
      <div class="rp-title">
        <svg class="rp-icon" viewBox="0 0 20 20"><path d="M13 6a3 3 0 1 1-6 0 3 3 0 0 1 6 0ZM5 18a5 5 0 0 1 10 0"/></svg>
        Monthly load by payer
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
  initCollapsibleHeaders();
  ensureUiUnlocked();
  window.addEventListener('focus', ensureUiUnlocked);
  window.addEventListener('pageshow', ensureUiUnlocked);
  wireBankPickers(document);
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

  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      if (document.body.classList.contains('filter-drawer-open')) closeFilterDrawer();
      else ensureUiUnlocked();
    }
  });

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).catch(() => {});
  q('payment-quick-search').addEventListener('input', event => {
    state.search = event.target.value.trim();
    q('schedule-search').value = state.search;
    renderSchedule();
  });
  q('payment-quick-sort').addEventListener('change', event => {
    [state.paymentSortField, state.paymentSortDirection] = event.target.value.split(':');
    syncPaymentControls();
    renderSchedule();
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') toggleMobileNav(false);
    if (event.key !== 'Tab' || !document.body.classList.contains('filter-drawer-open')) return;
    const focusable = [...q('filter-drawer').querySelectorAll('button, input, select')].filter(el => !el.disabled && el.getClientRects().length);
    const first = focusable[0], last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  });
  document.addEventListener('click', event => {
    if (!event.target.closest('#mobile-menu, .mobile-more')) toggleMobileNav(false);
  });
  window.addEventListener('online', () => revalidateMonth(state.month, true));
  window.addEventListener('offline', () => setSyncStatus('error', 'Offline. Showing saved data'));

  // Tab nav
  document.querySelectorAll('.sidebar-nav a').forEach(a => {
    a.addEventListener('click', e => { e.preventDefault(); switchTab(a.dataset.tab); });
  });

  // Clicking the dimmed backdrop of an open Add/Edit modal closes it, same as
  // the Cancel / × button -- so an accidental click outside the dialog can't
  // leave it stuck open and blocking the page.
  document.addEventListener('click', e => {
    if (e.target.classList && e.target.classList.contains('modal-backdrop')) {
      e.target.classList.add('hidden');
    }
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

  const paymentControls = {
    'schedule-search': 'search',
    'payment-type': 'paymentType',
    'payment-status': 'statusFilter',
    'payment-category': 'paymentCategory',
    'payment-bank': 'paymentBank',
    'payment-frequency': 'paymentFrequency',
    'payment-balance-status': 'paymentBalanceStatus',
    'payment-due-min': 'paymentDueMin',
    'payment-due-max': 'paymentDueMax',
    'payment-amount-min': 'paymentAmountMin',
    'payment-amount-max': 'paymentAmountMax',
    'payment-debt-min': 'paymentDebtMin',
    'payment-debt-max': 'paymentDebtMax',
    'payment-sort-field': 'paymentSortField',
    'payment-sort-direction': 'paymentSortDirection'
  };
  Object.entries(paymentControls).forEach(([id, stateKey]) => {
    const control = q(id);
    const eventName = control.matches('input') ? 'input' : 'change';
    control.addEventListener(eventName, event => {
      state[stateKey] = event.target.value.trim();
      if (id === 'payment-status') syncShowCompletedToggle();
      renderSchedule();
    });
  });
  q('show-completed').addEventListener('change', event => {
    state.statusFilter = event.target.checked ? 'all' : 'unresolved';
    q('payment-status').value = state.statusFilter;
    renderSchedule();
  });
  q('payment-clear-filters').addEventListener('click', clearPaymentFilters);

  const obligationControls = {
    'obligation-search': 'obligationSearch',
    'obligation-type': 'obligationType',
    'obligation-payer': 'obligationPayer',
    'obligation-category': 'obligationCategory',
    'obligation-bank': 'obligationBank',
    'obligation-frequency': 'obligationFrequency',
    'obligation-payment-status': 'obligationPaymentStatus',
    'obligation-balance-status': 'obligationBalanceStatus',
    'obligation-due-min': 'obligationDueMin',
    'obligation-due-max': 'obligationDueMax',
    'obligation-amount-min': 'obligationAmountMin',
    'obligation-amount-max': 'obligationAmountMax',
    'obligation-debt-min': 'obligationDebtMin',
    'obligation-debt-max': 'obligationDebtMax',
    'obligation-sort-field': 'obligationSortField',
    'obligation-sort-direction': 'obligationSortDirection'
  };
  Object.entries(obligationControls).forEach(([id, stateKey]) => {
    const control = q(id);
    const eventName = control.matches('input') ? 'input' : 'change';
    control.addEventListener(eventName, event => {
      state[stateKey] = event.target.value.trim();
      renderLoans();
    });
  });
  q('obligation-clear-filters').addEventListener('click', clearObligationFilters);

  const cashControls = {
    'cash-type': 'cashFilter',
    'cash-payer': 'cashPayerFilter',
    'cash-place': 'cashPlaceFilter',
    'cash-sort': 'cashSort'
  };
  Object.entries(cashControls).forEach(([id, stateKey]) => {
    const control = q(id);
    if (!control) return;
    control.addEventListener('change', event => {
      state[stateKey] = event.target.value;
      renderCash();
    });
  });
  const cashClear = q('cash-clear-filters');
  if (cashClear) cashClear.addEventListener('click', clearCashFilters);

  const offerControls = {
    'offer-status': 'offerStatusFilter',
    'offer-type': 'offerFilter',
    'offer-payer': 'offerPayerFilter',
    'offer-place': 'offerPlaceFilter',
    'offer-sort': 'offerSort'
  };
  Object.entries(offerControls).forEach(([id, stateKey]) => {
    const control = q(id);
    if (!control) return;
    control.addEventListener('change', event => {
      state[stateKey] = event.target.value;
      renderOffers();
    });
  });
  const offerClear = q('offer-clear-filters');
  if (offerClear) offerClear.addEventListener('click', clearOfferFilters);


  const reconControls = {
    'recon-search': 'reconSearch',
    'recon-bank': 'reconBank',
    'recon-payer': 'reconPayer',
    'recon-sort-field': 'reconSortField',
    'recon-sort-direction': 'reconSortDirection'
  };
  Object.entries(reconControls).forEach(([id, stateKey]) => {
    const control = q(id);
    if (!control) return;
    control.addEventListener(control.tagName === 'SELECT' ? 'change' : 'input', event => {
      state[stateKey] = event.target.value.trim();
      renderReconcile();
    });
  });
  const reconShowDone = q('recon-show-done');
  if (reconShowDone) {
    reconShowDone.addEventListener('change', event => {
      state.reconShowDone = event.target.checked;
      renderReconcile();
    });
  }
  const reconClear = q('recon-clear-filters');
  if (reconClear) reconClear.addEventListener('click', clearReconFilters);

  q('income-sort').addEventListener('change', event => {
    state.incomeSort = event.target.value;
    renderIncome();
  });
  q('income-search').addEventListener('input', event => {
    state.incomeSearch = event.target.value.trim();
    renderIncomeTab();
  });
  q('income-source-filter').addEventListener('change', event => {
    state.incomeSourceFilter = event.target.value;
    renderIncomeTab();
  });
  q('income-date-from').addEventListener('change', event => {
    state.incomeDateFrom = event.target.value;
    renderIncomeTab();
  });
  q('income-date-to').addEventListener('change', event => {
    state.incomeDateTo = event.target.value;
    renderIncomeTab();
  });
  q('income-clear-filters').addEventListener('click', clearIncomeFilters);
  q('income-add-modal').addEventListener('click', event => {
    if (event.target === event.currentTarget) closeIncomeModal();
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
    if (state.tab === 'reports') updateUrlForTab('reports', String(win));
    state.reportData = null;
    state.reportLoading = false;
    state.reportError = false;
    if (state.tab === 'reports') syncReports(false);
  });

  document.getElementById('btn-sync-reports').addEventListener('click', () => {
    state.reportLoading = false;
    state.reportError = false;
    if (state.tab === 'reports') syncReports(true);
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

  // Restore the tab (and, for Reports, the period sub-tab) from the URL so a
  // direct link or a page refresh lands back on the same view instead of
  // always starting on Payments.
  {
    const { tab: initialTab, sub: initialSub } = parseRoute();
    if (initialTab === 'reports' && [3, 6, 12, 24].includes(Number(initialSub))) {
      state.reportWindow = Number(initialSub);
      document.querySelectorAll('#report-period-tabs .rp-tab').forEach(t =>
        t.classList.toggle('active', Number(t.dataset.window) === state.reportWindow)
      );
    }
    activateTab(initialTab || 'schedule');
    updateUrlForTab(state.tab, state.tab === 'reports' ? String(state.reportWindow) : '');
  }

  window.addEventListener('hashchange', () => {
    ensureUiUnlocked();
    const { tab: nextTab, sub: nextSub } = parseRoute();
    if (!nextTab) return;
    const nextWin = nextTab === 'reports' && [3, 6, 12, 24].includes(Number(nextSub)) ? Number(nextSub) : state.reportWindow;
    if (nextTab === state.tab && nextWin === state.reportWindow) return;
    if (nextTab === 'reports' && nextWin !== state.reportWindow) {
      state.reportWindow = nextWin;
      document.querySelectorAll('#report-period-tabs .rp-tab').forEach(t =>
        t.classList.toggle('active', Number(t.dataset.window) === nextWin)
      );
      state.reportData = null;
      state.reportLoading = false;
      state.reportError = false;
    }
    activateTab(nextTab);
    renderCurrentTab();
  });

  // Load data
  if (!API_URL || API_URL.includes('YOUR_')) {
    showError('Open config.js and paste your Apps Script URL into API_URL.');
    showLoading(false);
    // Show placeholder data so the UI is visible
    state.obligations = [];
    state.payments = {};
    state.income = [];
    loadedMonth = state.month;
    document.body.classList.remove('month-pending');
    render();
  } else {
    const cached = readCachedMonth(state.month);
    if (cached) {
      state.monthCache[state.month] = cached;
      applyAllData(cached);
      revalidateMonth(state.month);
    } else {
      fetchAll();
    }
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (document.body.classList.contains('is-loading')) return;
    if (!q('loan-edit-modal').classList.contains('hidden')) return;
    if (state.reportLoading) return;
    revalidateMonth(state.month);
  });
});

function changeMonth(month) {
  if (state.month === month) return;
  state.month = month;
  const cached = state.monthCache[month] || readCachedMonth(month);
  if (cached) {
    state.monthCache[month] = cached;
    applyAllData(cached);
  } else {
    document.body.classList.add('month-pending');
    updateMonthLabels();
  }
  revalidateMonth(month);
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

// ================================================================
// Filter Drawer
// ================================================================
const FILTER_TABS = ['payment', 'obligation', 'recon', 'cash', 'offer'];

function activeCashFilterCount() {
  return [
    state.cashFilter && state.cashFilter !== 'all',
    state.cashPayerFilter && state.cashPayerFilter !== 'all',
    state.cashPlaceFilter && state.cashPlaceFilter !== 'all'
  ].filter(Boolean).length;
}

function clearCashFilters() {
  state.cashFilter = 'all';
  state.cashPayerFilter = 'all';
  state.cashPlaceFilter = 'all';
  renderCash();
}

function activeOfferFilterCount() {
  return [
    state.offerFilter && state.offerFilter !== 'all',
    state.offerPayerFilter && state.offerPayerFilter !== 'all',
    state.offerPlaceFilter && state.offerPlaceFilter !== 'all',
    state.offerStatusFilter && state.offerStatusFilter !== 'all'
  ].filter(Boolean).length;
}

function clearOfferFilters() {
  state.offerFilter = 'all';
  state.offerPayerFilter = 'all';
  state.offerPlaceFilter = 'all';
  state.offerStatusFilter = 'all';
  renderOffers();
}


function openFilterDrawer(tab) {
  filterReturnFocus = document.activeElement;
  FILTER_TABS.forEach(t => {
    const body = document.getElementById(`drawer-${t}-filters`);
    const clear = q(`${t}-clear-filters`);
    if (body) body.classList.toggle('hidden', t !== tab);
    if (clear) clear.classList.toggle('hidden', t !== tab);
  });

  const resultsEl = document.getElementById('filter-results-count');
  if (resultsEl) {
    const src = q(`${tab}-results-count`);
    resultsEl.textContent = src ? src.textContent : '';
  }

  const drawer = q('filter-drawer');
  document.body.classList.add('filter-drawer-open');
  if (drawer) drawer.inert = false;

  // Rebuild bank logo pickers for selects currently shown
  document.querySelectorAll('.filter-drawer-body:not(.hidden) select').forEach(sel => {
    if (isBankFilterSelect(sel.id)) syncBankPicker(sel.id);
  });

  try {
    const closeBtn = drawer && drawer.querySelector('.filter-drawer-close');
    if (closeBtn) closeBtn.focus();
  } catch (_) { /* focus can fail; never leave UI locked forever */ }
}

function closeFilterDrawer() {
  document.body.classList.remove('filter-drawer-open');
  const appEl = document.querySelector('.app');
  if (appEl) {
    appEl.inert = false;
    appEl.removeAttribute('inert');
  }
  const drawer = q('filter-drawer');
  if (drawer) drawer.inert = true;
  try { filterReturnFocus?.focus(); } catch (_) {}
}

function updateFilterBadge(tab, count) {
  const badge = document.getElementById(`${tab}-filter-badge`);
  const btn   = document.getElementById(`${tab}-filter-btn`);
  if (badge) {
    badge.textContent = count || '';
    badge.classList.toggle('hidden', !count);
  }
  if (btn) btn.classList.toggle('has-filters', count > 0);
}
