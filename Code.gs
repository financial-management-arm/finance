// Finance Manager - continuous Google Sheets backend.
// Existing Obligations data is never seeded or cleared by this script.

var SS_ID = '14tjp5lUfjZL9RTNMz8eCoxFOogbGSj-Op0C4WI7UNTY';

var SCHEMAS = {
  Obligations: [
    'id', 'payer', 'bank', 'category', 'amount', 'dueDay',
    'currentBalance', 'loanTotal', 'contractNumber', 'active', 'startDate',
    'balanceUpdatedMonth', 'completedAt', 'updatedAt'
  ],
  Payments: ['key', 'paid', 'completedAt', 'updatedAt', 'status'],
  Income: ['id', 'date', 'amount', 'stream', 'note', 'createdAt', 'updatedAt'],
  Loans: [
    'snapshotKey', 'month', 'obligationId', 'payer', 'bank', 'amount', 'dueDay',
    'currentBalance', 'loanTotal', 'contractNumber', 'balanceSourceMonth',
    'completed', 'completedAt', 'snapshotAt', 'updatedAt'
  ]
};

function doGet(e) {
  var params = (e && e.parameter) || {};
  var action = params.action || 'all';
  var month = validMonth(params.month) ? params.month : currentMonth();
  var ss = SpreadsheetApp.openById(SS_ID);
  var result;

  try {
    ensureSchema(ss);

    if (action === 'all') {
      withLock(function() {
        ensureMonthlyLoanSnapshot(ss, month);
      });
      result = {
        obligations: sheetToJson(ss, 'Obligations'),
        payments: sheetToJson(ss, 'Payments'),
        income: sheetToJson(ss, 'Income'),
        loanHistory: sheetToJson(ss, 'Loans'),
        serverMonth: month,
        syncedAt: isoNow()
      };
    } else if (action === 'setPayment') {
      result = withLock(function() {
        return setPayment(ss, params);
      });
    } else if (action === 'addIncome') {
      result = withLock(function() {
        return addIncome(ss, params);
      });
    } else if (action === 'updateBalance') {
      result = withLock(function() {
        return updateBalance(ss, params, month);
      });
    } else if (action === 'updateLoan') {
      result = withLock(function() {
        return updateLoan(ss, params, month);
      });
    } else if (action === 'completeLoan') {
      result = withLock(function() {
        return completeLoan(ss, params, month);
      });
    } else if (action === 'repairSchema') {
      ensureSchema(ss);
      result = { success: true, sheets: Object.keys(SCHEMAS), repairedAt: isoNow() };
    } else {
      result = { error: 'Unknown action: ' + action };
    }
  } catch (err) {
    result = { error: err && err.message ? err.message : String(err) };
  }

  return ContentService
    .createTextOutput(JSON.stringify(result))
    .setMimeType(ContentService.MimeType.JSON);
}

function setPayment(ss, params) {
  var key = String(params.key || '');
  var status = normalizePaymentStatus(params.status, params.paid);
  var paid = status === 'paid';
  if (!key || key.length > 100) throw new Error('Invalid payment key');

  var now = isoNow();
  upsertObject(ss.getSheetByName('Payments'), 'key', key, {
    key: key,
    paid: paid,
    completedAt: paid ? now : '',
    updatedAt: now,
    status: status
  });
  return { success: true, paid: paid, status: status, completedAt: paid ? now : '' };
}

function normalizePaymentStatus(status, paid) {
  var value = String(status || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (!value) value = paid === 'true' ? 'paid' : 'unpaid';
  var allowed = {
    paid: true,
    unpaid: true,
    not_done: true,
    no_need: true
  };
  if (!allowed[value]) throw new Error('Invalid payment status');
  return value;
}

function addIncome(ss, params) {
  var amount = Number(params.amount);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(params.date || '')) throw new Error('Invalid income date');
  if (!isFinite(amount) || amount <= 0) throw new Error('Income amount must be positive');

  var now = isoNow();
  var row = {
    id: 'inc-' + Date.now(),
    date: params.date,
    amount: amount,
    stream: String(params.stream || 'other').slice(0, 60),
    note: String(params.note || '').slice(0, 250),
    createdAt: now,
    updatedAt: now
  };
  appendObject(ss.getSheetByName('Income'), row);
  return { success: true, id: row.id, createdAt: now };
}

function updateBalance(ss, params, month) {
  var balance = Number(params.balance);
  if (!isFinite(balance) || balance < 0) throw new Error('Invalid balance');
  var id = String(params.id || '');
  if (!id) throw new Error('Obligation id is required');

  updateObjectByKey(ss.getSheetByName('Obligations'), 'id', id, {
    currentBalance: balance,
    balanceUpdatedMonth: month,
    updatedAt: isoNow()
  });
  syncCurrentSnapshot(ss, id, month);
  return { success: true, balanceUpdatedMonth: month };
}

function updateLoan(ss, params, month) {
  var id = String(params.id || '');
  if (!id) throw new Error('Loan id is required');

  var amount = Number(params.amount);
  var dueDay = Number(params.dueDay);
  var currentBalance = params.currentBalance === '' ? '' : Number(params.currentBalance);
  var loanTotal = params.loanTotal === '' ? '' : Number(params.loanTotal);
  var startDate = String(params.startDate || '');

  if (!isFinite(amount) || amount < 0) throw new Error('Invalid monthly payment');
  if (!isFinite(dueDay) || dueDay < 0 || dueDay > 31) throw new Error('Invalid due day');
  if (currentBalance !== '' && (!isFinite(currentBalance) || currentBalance < 0)) throw new Error('Invalid balance');
  if (loanTotal !== '' && (!isFinite(loanTotal) || loanTotal < 0)) throw new Error('Invalid loan total');
  if (startDate && !validMonth(startDate)) throw new Error('Invalid start month');

  var existing = findObjectByKey(ss.getSheetByName('Obligations'), 'id', id);
  if (!existing) throw new Error('Loan not found');
  var balanceChanged = String(existing.currentBalance) !== String(currentBalance);

  updateObjectByKey(ss.getSheetByName('Obligations'), 'id', id, {
    bank: String(params.bank || '').trim().slice(0, 120),
    amount: amount,
    dueDay: dueDay,
    currentBalance: currentBalance,
    loanTotal: loanTotal,
    contractNumber: String(params.contractNumber || '').trim().slice(0, 120),
    startDate: startDate,
    balanceUpdatedMonth: balanceChanged ? month : existing.balanceUpdatedMonth,
    updatedAt: isoNow()
  });
  syncCurrentSnapshot(ss, id, month);
  return {
    success: true,
    balanceUpdatedMonth: balanceChanged ? month : existing.balanceUpdatedMonth
  };
}

function completeLoan(ss, params, month) {
  var id = String(params.id || '');
  if (!id) throw new Error('Loan id is required');
  var now = isoNow();
  var existing = findObjectByKey(ss.getSheetByName('Obligations'), 'id', id);
  if (!existing) throw new Error('Loan not found');

  updateObjectByKey(ss.getSheetByName('Obligations'), 'id', id, {
    currentBalance: 0,
    active: false,
    balanceUpdatedMonth: month,
    completedAt: now,
    updatedAt: now
  });

  var snapshotKey = month + '__' + id;
  upsertObject(ss.getSheetByName('Loans'), 'snapshotKey', snapshotKey, {
    snapshotKey: snapshotKey,
    month: month,
    obligationId: id,
    payer: existing.payer,
    bank: existing.bank,
    amount: existing.amount,
    dueDay: existing.dueDay,
    loanTotal: existing.loanTotal,
    contractNumber: existing.contractNumber,
    completed: true,
    completedAt: now,
    currentBalance: 0,
    balanceSourceMonth: month,
    updatedAt: now
  }, true);
  removeFutureLoanSnapshots(ss, id, month);

  return { success: true, completedAt: now };
}

// Creates one immutable monthly row per active loan. Existing rows are not
// overwritten here; edits are synchronized explicitly by syncCurrentSnapshot.
function ensureMonthlyLoanSnapshot(ss, month) {
  if (month < currentMonth()) return;
  var obligations = sheetToJson(ss, 'Obligations');
  var historySheet = ss.getSheetByName('Loans');
  var history = sheetToJson(ss, 'Loans');
  var existing = {};
  history.forEach(function(row) { existing[String(row.snapshotKey)] = true; });

  var now = isoNow();
  var rows = [];
  obligations.forEach(function(o) {
    if (!isLoan(o) || !isActive(o) || o.completedAt) return;
    var key = month + '__' + o.id;
    if (existing[key]) return;
    rows.push({
      snapshotKey: key,
      month: month,
      obligationId: o.id,
      payer: o.payer,
      bank: o.bank,
      amount: o.amount,
      dueDay: o.dueDay,
      currentBalance: o.currentBalance,
      loanTotal: o.loanTotal,
      contractNumber: o.contractNumber,
      balanceSourceMonth: o.balanceUpdatedMonth || '',
      completed: false,
      completedAt: '',
      snapshotAt: now,
      updatedAt: now
    });
  });
  appendObjects(historySheet, rows);
}

function removeFutureLoanSnapshots(ss, id, month) {
  var sheet = ss.getSheetByName('Loans');
  var headers = SCHEMAS.Loans;
  var values = sheet.getDataRange().getValues();
  var monthCol = headers.indexOf('month');
  var idCol = headers.indexOf('obligationId');
  for (var row = values.length - 1; row >= 1; row--) {
    if (String(values[row][idCol]) === String(id) && String(values[row][monthCol]) > month) {
      sheet.deleteRow(row + 1);
    }
  }
}

function syncCurrentSnapshot(ss, id, month) {
  ensureMonthlyLoanSnapshot(ss, month);
  var obligation = findObjectByKey(ss.getSheetByName('Obligations'), 'id', id);
  if (!obligation || !isLoan(obligation)) return;

  var key = month + '__' + id;
  upsertObject(ss.getSheetByName('Loans'), 'snapshotKey', key, {
    snapshotKey: key,
    month: month,
    obligationId: obligation.id,
    payer: obligation.payer,
    bank: obligation.bank,
    amount: obligation.amount,
    dueDay: obligation.dueDay,
    currentBalance: obligation.currentBalance,
    loanTotal: obligation.loanTotal,
    contractNumber: obligation.contractNumber,
    balanceSourceMonth: obligation.balanceUpdatedMonth || '',
    completed: !isActive(obligation),
    completedAt: obligation.completedAt || '',
    snapshotAt: isoNow(),
    updatedAt: isoNow()
  });
}

// Safe to run manually, but every API request also runs it automatically.
function setup() {
  var ss = SpreadsheetApp.openById(SS_ID);
  ensureSchema(ss);
  ensureMonthlyLoanSnapshot(ss, currentMonth());
  ensureMaintenanceTrigger();
  return 'Schema checked. Existing obligation data was preserved.';
}

// Keeps app data synchronized when loan fields are edited directly in Sheets.
function onEdit(e) {
  if (!e || !e.range) return;
  var sheet = e.range.getSheet();
  if (sheet.getName() !== 'Obligations') return;
  if (e.range.getRow() === 1) {
    ensureSchema(e.source);
    return;
  }

  var headers = SCHEMAS.Obligations;
  var editedHeader = headers[e.range.getColumn() - 1];
  var tracked = [
    'payer', 'bank', 'category', 'amount', 'dueDay', 'currentBalance',
    'loanTotal', 'contractNumber', 'active', 'startDate'
  ];
  if (tracked.indexOf(editedHeader) < 0) return;

  var id = String(sheet.getRange(e.range.getRow(), headers.indexOf('id') + 1).getValue() || '');
  if (!id) return;
  var month = currentMonth();
  var updates = { updatedAt: isoNow() };
  if (editedHeader === 'currentBalance') updates.balanceUpdatedMonth = month;
  updateObjectByKey(sheet, 'id', id, updates);

  var obligation = findObjectByKey(sheet, 'id', id);
  if (obligation && isLoan(obligation)) {
    syncCurrentSnapshot(e.source, id, month);
    if (!isActive(obligation)) removeFutureLoanSnapshots(e.source, id, month);
  }
}

function onStructureChange(e) {
  var ss = e && e.source ? e.source : SpreadsheetApp.openById(SS_ID);
  ensureSchema(ss);
}

function ensureMaintenanceTrigger() {
  var exists = ScriptApp.getProjectTriggers().some(function(trigger) {
    return trigger.getHandlerFunction() === 'onStructureChange';
  });
  if (!exists) {
    ScriptApp.newTrigger('onStructureChange')
      .forSpreadsheet(SS_ID)
      .onChange()
      .create();
  }
}

function ensureSchema(ss) {
  Object.keys(SCHEMAS).forEach(function(name) {
    var headers = SCHEMAS[name];
    var sheet = ss.getSheetByName(name);
    if (!sheet) sheet = ss.insertSheet(name);

    if (sheet.getLastRow() > 0) {
      var firstCell = String(sheet.getRange(1, 1).getValue() || '');
      if (looksLikeDataRow(name, firstCell)) sheet.insertRowBefore(1);
    }
    if (sheet.getMaxColumns() < headers.length) {
      sheet.insertColumnsAfter(sheet.getMaxColumns(), headers.length - sheet.getMaxColumns());
    }
    var currentHeaders = sheet.getRange(1, 1, 1, headers.length).getValues()[0]
      .map(function(value) { return String(value || '').trim(); });
    if (currentHeaders.join('|') !== headers.join('|')) {
      sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    }
    sheet.setFrozenRows(1);
  });

  var obligations = ss.getSheetByName('Obligations');
  var contractCol = SCHEMAS.Obligations.indexOf('contractNumber') + 1;
  var contractRows = Math.max(obligations.getLastRow() - 1, 1);
  obligations.getRange(2, contractCol, contractRows, 1).setNumberFormat('@');
}

function looksLikeDataRow(sheetName, firstCell) {
  if (!firstCell) return false;
  if (sheetName === 'Obligations') return /^ob-/i.test(firstCell);
  if (sheetName === 'Payments') return /__\d{4}-\d{2}$/.test(firstCell);
  if (sheetName === 'Income') return /^inc-/i.test(firstCell);
  if (sheetName === 'Loans') return /^\d{4}-\d{2}__/.test(firstCell);
  return false;
}

function sheetToJson(ss, name) {
  var sheet = ss.getSheetByName(name);
  if (!sheet || sheet.getLastRow() < 2) return [];
  var headers = SCHEMAS[name] || sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  var values = sheet.getRange(2, 1, sheet.getLastRow() - 1, headers.length).getValues();
  return values.filter(function(row) {
    return row.some(function(value) { return value !== ''; });
  }).map(function(row) {
    var obj = {};
    headers.forEach(function(header, index) { obj[header] = row[index]; });
    return obj;
  });
}

function appendObject(sheet, object) {
  appendObjects(sheet, [object]);
}

function appendObjects(sheet, objects) {
  if (!objects.length) return;
  var headers = SCHEMAS[sheet.getName()];
  var rows = objects.map(function(object) {
    return headers.map(function(header) {
      return object[header] !== undefined ? object[header] : '';
    });
  });
  sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, headers.length).setValues(rows);
}

function upsertObject(sheet, keyField, keyValue, object, preserveExisting) {
  var headers = SCHEMAS[sheet.getName()];
  var data = sheet.getDataRange().getValues();
  var keyCol = headers.indexOf(keyField);
  for (var row = 1; row < data.length; row++) {
    if (String(data[row][keyCol]) === String(keyValue)) {
      var merged = {};
      headers.forEach(function(header, index) {
        merged[header] = preserveExisting ? data[row][index] : '';
      });
      Object.keys(object).forEach(function(key) { merged[key] = object[key]; });
      sheet.getRange(row + 1, 1, 1, headers.length).setValues([
        headers.map(function(header) { return merged[header] !== undefined ? merged[header] : ''; })
      ]);
      return;
    }
  }
  appendObject(sheet, object);
}

function updateObjectByKey(sheet, keyField, keyValue, updates) {
  var headers = SCHEMAS[sheet.getName()];
  var data = sheet.getDataRange().getValues();
  var keyCol = headers.indexOf(keyField);
  for (var row = 1; row < data.length; row++) {
    if (String(data[row][keyCol]) === String(keyValue)) {
      var rowValues = data[row].slice(0, headers.length);
      Object.keys(updates).forEach(function(field) {
        var col = headers.indexOf(field);
        if (col >= 0) rowValues[col] = updates[field];
      });
      sheet.getRange(row + 1, 1, 1, headers.length).setValues([rowValues]);
      return;
    }
  }
  throw new Error(sheet.getName() + ' row not found: ' + keyValue);
}

function findObjectByKey(sheet, keyField, keyValue) {
  var headers = SCHEMAS[sheet.getName()];
  var data = sheet.getDataRange().getValues();
  var keyCol = headers.indexOf(keyField);
  for (var row = 1; row < data.length; row++) {
    if (String(data[row][keyCol]) === String(keyValue)) {
      var object = {};
      headers.forEach(function(header, index) { object[header] = data[row][index]; });
      return object;
    }
  }
  return null;
}

function isLoan(obligation) {
  return String(obligation.category).toLowerCase() === 'loan' ||
    Number(obligation.loanTotal) > 0 || Number(obligation.currentBalance) > 0;
}

function isActive(obligation) {
  return obligation.active === true || String(obligation.active).toUpperCase() === 'TRUE';
}

function validMonth(value) {
  return /^\d{4}-\d{2}$/.test(String(value || ''));
}

function currentMonth() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM');
}

function isoNow() {
  return new Date().toISOString();
}

function withLock(callback) {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    return callback();
  } finally {
    lock.releaseLock();
  }
}
