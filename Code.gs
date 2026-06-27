// Finance Manager - continuous Google Sheets backend.
// Existing Obligations data is never seeded or cleared by this script.

var SS_ID = '14tjp5lUfjZL9RTNMz8eCoxFOogbGSj-Op0C4WI7UNTY';

var SCHEMAS = {
  Obligations: [
    'id', 'payer', 'bank', 'category', 'amount', 'dueDay',
    'currentBalance', 'loanTotal', 'contractNumber', 'active', 'startDate',
    'balanceUpdatedMonth', 'completedAt', 'updatedAt', 'frequency'
  ],
  Payments: ['key', 'paid', 'completedAt', 'updatedAt', 'status', 'paidAmount', 'month'],
  Income: ['id', 'date', 'amount', 'stream', 'note', 'createdAt', 'updatedAt'],
  Loans: [
    'snapshotKey', 'month', 'obligationId', 'payer', 'bank', 'amount', 'dueDay',
    'currentBalance', 'loanTotal', 'contractNumber', 'balanceSourceMonth',
    'completed', 'completedAt', 'snapshotAt', 'updatedAt'
  ],
  Utilities: ['id', 'name', 'payer', 'provider', 'abonentNumber', 'amount', 'type', 'dueDay', 'active', 'personalExpense']
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
        utilities: sheetToJson(ss, 'Utilities'),
        cash: Number(PropertiesService.getScriptProperties().getProperty('availableCash')) || 0,
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
    } else if (action === 'addObligation') {
      result = withLock(function() {
        return addObligation(ss, params);
      });
    } else if (action === 'addUtility') {
      result = withLock(function() {
        return addUtility(ss, params);
      });
    } else if (action === 'updateUtility') {
      result = withLock(function() {
        return updateUtility(ss, params);
      });
    } else if (action === 'deleteObligation') {
      result = withLock(function() {
        return deleteObligation(ss, params);
      });
    } else if (action === 'deleteUtility') {
      result = withLock(function() {
        return deleteUtility(ss, params);
      });
    } else if (action === 'setCash') {
      var cashAmt = Number(params.amount);
      if (!isFinite(cashAmt) || cashAmt < 0) throw new Error('Invalid cash amount');
      PropertiesService.getScriptProperties().setProperty('availableCash', String(cashAmt));
      result = { success: true, cash: cashAmt };
    } else if (action === 'getReportData') {
      result = getReportData(ss, params);
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
  var paidAmount = (params.paidAmount !== undefined && params.paidAmount !== '')
    ? Number(params.paidAmount) : '';

  var keyParts = key.split('__');
  var month = (keyParts.length === 2 && validMonth(keyParts[1])) ? keyParts[1] : '';

  var now = new Date();
  var nowIso = now.toISOString();
  var resolved = paid || status === 'partial';
  upsertObject(ss.getSheetByName('Payments'), 'key', key, {
    key: key,
    paid: paid,
    completedAt: resolved ? now : '',
    updatedAt: now,
    status: status,
    paidAmount: paidAmount,
    month: month
  });
  return { success: true, paid: paid, status: status, completedAt: resolved ? nowIso : '', paidAmount: paidAmount };
}

function normalizePaymentStatus(status, paid) {
  var value = String(status || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (!value) value = paid === 'true' ? 'paid' : 'unpaid';
  var allowed = {
    paid: true,
    unpaid: true,
    partial: true,
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
    category: String(params.category || existing.category || 'personal').trim(),
    amount: amount,
    dueDay: dueDay,
    currentBalance: currentBalance,
    loanTotal: loanTotal,
    contractNumber: String(params.contractNumber || '').trim().slice(0, 120),
    startDate: startDate,
    frequency: String(params.frequency || 'monthly').trim(),
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

function addObligation(ss, params) {
  var payer = String(params.payer || '').trim();
  var bank = String(params.bank || '').trim().slice(0, 120);
  var category = String(params.category || 'personal').trim();
  var amount = Number(params.amount) || 0;
  var dueDay = Math.round(Number(params.dueDay) || 0);
  var startDate = String(params.startDate || '');
  var frequency = String(params.frequency || 'monthly').trim();

  if (!bank) throw new Error('Bank/Payee name is required');
  if (!payer) throw new Error('Payer is required');
  if (amount < 0) throw new Error('Invalid amount');
  if (dueDay < 0 || dueDay > 31) throw new Error('Invalid due day');

  var newId = 'ob-' + Date.now();
  var now = isoNow();
  var row = SCHEMAS.Obligations.map(function(col) {
    switch (col) {
      case 'id': return newId;
      case 'payer': return payer;
      case 'bank': return bank;
      case 'category': return category;
      case 'amount': return amount;
      case 'dueDay': return dueDay;
      case 'currentBalance': return '';
      case 'loanTotal': return '';
      case 'contractNumber': return '';
      case 'active': return true;
      case 'startDate': return startDate;
      case 'balanceUpdatedMonth': return '';
      case 'completedAt': return '';
      case 'updatedAt': return now;
      case 'frequency': return frequency;
      default: return '';
    }
  });
  ss.getSheetByName('Obligations').appendRow(row);
  return { ok: true, id: newId };
}

function addUtility(ss, params) {
  var name = String(params.name || '').trim().slice(0, 80);
  var payer = String(params.payer || '').trim();
  if (!name) throw new Error('Utility name is required');
  if (!payer) throw new Error('Payer is required');
  var id = 'util-' + Date.now();
  var row = SCHEMAS.Utilities.map(function(col) {
    switch (col) {
      case 'id': return id;
      case 'name': return name;
      case 'payer': return payer;
      case 'provider': return String(params.provider || '').trim().slice(0, 120);
      case 'abonentNumber': return String(params.abonentNumber || '').trim().slice(0, 60);
      case 'amount': return Number(params.amount) || 0;
      case 'type': return String(params.type || 'variable').trim();
      case 'dueDay': return Math.round(Number(params.dueDay) || 0);
      case 'active': return true;
      case 'personalExpense': return params.personalExpense === 'true' || params.personalExpense === true;
      default: return '';
    }
  });
  ss.getSheetByName('Utilities').appendRow(row);
  return { ok: true, id: id };
}

function deleteObligation(ss, params) {
  var id = String(params.id || '');
  if (!id) throw new Error('Obligation id is required');
  updateObjectByKey(ss.getSheetByName('Obligations'), 'id', id, {
    active: false,
    updatedAt: isoNow()
  });
  return { ok: true };
}

function deleteUtility(ss, params) {
  var id = String(params.id || '');
  if (!id) throw new Error('Utility id is required');
  updateObjectByKey(ss.getSheetByName('Utilities'), 'id', id, {
    active: false
  });
  return { ok: true };
}

function updateUtility(ss, params) {
  var id = String(params.id || '');
  if (!id) throw new Error('Utility id is required');
  updateObjectByKey(ss.getSheetByName('Utilities'), 'id', id, {
    name: String(params.name || '').trim().slice(0, 80),
    payer: String(params.payer || '').trim(),
    provider: String(params.provider || '').trim().slice(0, 120),
    abonentNumber: String(params.abonentNumber || '').trim().slice(0, 60),
    amount: Number(params.amount) || 0,
    type: String(params.type || 'variable').trim(),
    dueDay: Math.round(Number(params.dueDay) || 0),
    active: params.active === 'true' || params.active === true,
    personalExpense: params.personalExpense === 'true' || params.personalExpense === true
  });
  return { ok: true };
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

  var utilities = ss.getSheetByName('Utilities');
  if (utilities && utilities.getLastRow() > 1) {
    var abonentCol = SCHEMAS.Utilities.indexOf('abonentNumber') + 1;
    var utilRows = Math.max(utilities.getLastRow() - 1, 1);
    utilities.getRange(2, abonentCol, utilRows, 1).setNumberFormat('@');
  }

  // Backfill month column for existing Payments rows that have a key but no month
  backfillPaymentMonths(ss);
}

function backfillPaymentMonths(ss) {
  var sheet = ss.getSheetByName('Payments');
  if (!sheet || sheet.getLastRow() < 2) return;
  var headers = SCHEMAS.Payments;
  var keyCol = headers.indexOf('key');
  var monthCol = headers.indexOf('month');
  var completedAtCol = headers.indexOf('completedAt');
  var updatedAtCol = headers.indexOf('updatedAt');
  if (monthCol < 0) return;

  var numRows = sheet.getLastRow() - 1;
  var range = sheet.getRange(2, 1, numRows, headers.length);
  var data = range.getValues();
  var changed = false;

  data.forEach(function(row) {
    // Backfill month from key
    if (row[monthCol] === '' || row[monthCol] === null || row[monthCol] === undefined) {
      var key = String(row[keyCol] || '');
      var parts = key.split('__');
      if (parts.length === 2 && validMonth(parts[1])) {
        row[monthCol] = parts[1];
        changed = true;
      }
    }

    // Convert completedAt ISO string → real Sheets Date
    if (completedAtCol >= 0 && typeof row[completedAtCol] === 'string' && row[completedAtCol].length > 0) {
      var d = new Date(row[completedAtCol]);
      if (!isNaN(d.getTime())) { row[completedAtCol] = d; changed = true; }
    }

    // Convert updatedAt ISO string → real Sheets Date
    if (updatedAtCol >= 0 && typeof row[updatedAtCol] === 'string' && row[updatedAtCol].length > 0) {
      var d2 = new Date(row[updatedAtCol]);
      if (!isNaN(d2.getTime())) { row[updatedAtCol] = d2; changed = true; }
    }
  });

  // One batch write — much faster than per-row setValue calls
  if (changed) range.setValues(data);
}

function looksLikeDataRow(sheetName, firstCell) {
  if (!firstCell) return false;
  if (sheetName === 'Obligations') return /^ob-/i.test(firstCell);
  if (sheetName === 'Payments') return /__\d{4}-\d{2}$/.test(firstCell);
  if (sheetName === 'Income') return /^inc-/i.test(firstCell);
  if (sheetName === 'Loans') return /^\d{4}-\d{2}__/.test(firstCell);
  if (sheetName === 'Utilities') return /^util-/i.test(firstCell);
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

function shiftMonthGs(m, delta) {
  var parts = m.split('-').map(Number);
  var d = new Date(parts[0], parts[1] - 1 + delta, 1);
  return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2);
}

function getReportData(ss, params) {
  var toMonth = validMonth(params.toMonth) ? params.toMonth : currentMonth();
  var windowSize = Math.min(Math.max(parseInt(params.window) || 6, 1), 24);
  var filterPayer = String(params.payer || '').trim();
  var fromMonth = shiftMonthGs(toMonth, -(windowSize - 1));

  var months = [];
  var m = fromMonth;
  while (m <= toMonth) { months.push(m); m = shiftMonthGs(m, 1); }

  var payments   = sheetToJson(ss, 'Payments');
  var obligations = sheetToJson(ss, 'Obligations');
  var utilities  = sheetToJson(ss, 'Utilities');
  var income     = sheetToJson(ss, 'Income');
  var loans      = sheetToJson(ss, 'Loans');

  // Collect all unique payers for the filter dropdown
  var payerSet = {};
  obligations.forEach(function(o) { if (isActive(o) && o.payer) payerSet[String(o.payer)] = true; });
  utilities.forEach(function(u) { if (isActive(u) && u.payer) payerSet[String(u.payer)] = true; });
  var allPayers = Object.keys(payerSet).sort();

  var activeObs = obligations.filter(function(o) {
    if (!isActive(o)) return false;
    return !filterPayer || String(o.payer || '').trim() === filterPayer;
  });
  var activePersonalUtils = utilities.filter(function(u) {
    if (!isActive(u)) return false;
    if (!(u.personalExpense === true || String(u.personalExpense) === 'true')) return false;
    return !filterPayer || String(u.payer || '').trim() === filterPayer;
  });
  var activeLoans = activeObs.filter(isLoan);

  // Build allowed-ID set for payment filtering when payer is selected
  var allowedIds = null;
  if (filterPayer) {
    allowedIds = {};
    activeObs.forEach(function(o) { allowedIds[String(o.id)] = true; });
    activePersonalUtils.forEach(function(u) { allowedIds[String(u.id)] = true; });
  }

  var paymentsByKey = {};
  payments.forEach(function(p) { paymentsByKey[String(p.key)] = p; });

  var loansByMonth = {};
  loans.forEach(function(l) {
    if (filterPayer && String(l.payer || '').trim() !== filterPayer) return;
    var mo = String(l.month || '');
    if (!loansByMonth[mo]) loansByMonth[mo] = [];
    loansByMonth[mo].push(l);
  });

  var cashFlow = [];
  var debtArr = [];
  var paymentHealth = [];

  months.forEach(function(mo) {
    var monthIncome = income.reduce(function(sum, row) {
      return String(row.date || '').slice(0, 7) === mo ? sum + (Number(row.amount) || 0) : sum;
    }, 0);

    var monthPaid = payments.reduce(function(sum, row) {
      var rowMonth = String(row.month || '');
      if (!rowMonth) {
        var pts = String(row.key || '').split('__');
        rowMonth = pts.length === 2 ? pts[1] : '';
      }
      if (rowMonth !== mo) return sum;
      if (allowedIds !== null) {
        var keyId = String(row.key || '').split('__')[0];
        if (!allowedIds[keyId]) return sum;
      }
      var p = row.paid === true || String(row.paid).toUpperCase() === 'TRUE';
      var partial = String(row.status || '').toLowerCase() === 'partial';
      return (p || partial) ? sum + (Number(row.paidAmount) || 0) : sum;
    }, 0);

    cashFlow.push({ month: mo, income: monthIncome, paid: monthPaid, net: monthIncome - monthPaid });

    var snapshots = loansByMonth[mo] || [];
    var totalDebt = snapshots.length
      ? snapshots.reduce(function(s, snap) { var b = Number(snap.currentBalance); return s + (isNaN(b) ? 0 : b); }, 0)
      : (mo === toMonth ? activeLoans.reduce(function(s, l) { var b = Number(l.currentBalance); return s + (isNaN(b) ? 0 : b); }, 0) : 0);
    debtArr.push({ month: mo, totalBalance: totalDebt });

    var monthlyObs = activeObs.filter(function(o) {
      var freq = String(o.frequency || 'monthly').toLowerCase().trim();
      if (!freq || freq === 'monthly') return true;
      if (freq === 'one_time') return String(o.startDate || '').slice(0, 7) === mo;
      if (freq === 'quarterly') {
        var start = String(o.startDate || '').slice(0, 7);
        if (!start) return true;
        var sy = parseInt(start.split('-')[0]), sm = parseInt(start.split('-')[1]);
        var cy = parseInt(mo.split('-')[0]),   cm = parseInt(mo.split('-')[1]);
        var diff = (cy * 12 + cm) - (sy * 12 + sm);
        return diff >= 0 && diff % 3 === 0;
      }
      return true;
    });

    var paidCount = 0, partialCount = 0, missedItems = [];
    function countItem(id, name, payer) {
      var p = paymentsByKey[id + '__' + mo];
      var status = p ? String(p.status || '').toLowerCase() : 'unpaid';
      if (!status && p && (p.paid === true || String(p.paid).toUpperCase() === 'TRUE')) status = 'paid';
      if (status === 'paid') { paidCount++; }
      else if (status === 'partial') { paidCount++; partialCount++; }
      else if (status === 'not_done') { missedItems.push({ name: String(name || id), payer: String(payer || '') }); }
    }
    monthlyObs.forEach(function(o) { countItem(o.id, o.bank, o.payer); });
    activePersonalUtils.forEach(function(u) { countItem(u.id, u.name, u.payer); });

    var total = monthlyObs.length + activePersonalUtils.length;
    paymentHealth.push({
      month: mo, total: total, paid: paidCount, partial: partialCount,
      missed: missedItems.length, missedItems: missedItems,
      rate: total > 0 ? Math.round((paidCount / total) * 1000) / 10 : 0
    });
  });

  for (var i = 1; i < debtArr.length; i++) debtArr[i].delta = debtArr[i].totalBalance - debtArr[i - 1].totalBalance;
  if (debtArr.length > 0) debtArr[0].delta = null;

  var loanProjections = activeLoans.map(function(loan) {
    var balance = Number(loan.currentBalance) || 0;
    var monthly = Number(loan.amount) || 0;
    var payoffDate = (monthly > 0 && balance > 0) ? shiftMonthGs(currentMonth(), Math.ceil(balance / monthly)) : null;
    return { id: loan.id, bank: String(loan.bank || ''), payer: String(loan.payer || ''), balance: balance, monthly: monthly, payoffDate: payoffDate };
  });

  return {
    months: months,
    cashFlow: cashFlow,
    debt: debtArr,
    paymentHealth: paymentHealth,
    loanProjections: loanProjections,
    payers: allPayers,
    activeFilter: filterPayer || null
  };
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

// Run in Apps Script editor to see what's in the Loans sheet and why.
function diagnoseLoanHistory() {
  var ss = SpreadsheetApp.openById(SS_ID);
  var sheet = ss.getSheetByName('Loans');
  if (!sheet || sheet.getLastRow() < 2) { Logger.log('Loans sheet is empty.'); return; }

  var headers = SCHEMAS.Loans;
  var values = sheet.getRange(2, 1, sheet.getLastRow() - 1, headers.length).getValues();

  var byMonth = {}, byKey = {}, dupeKeys = [];
  values.forEach(function(row) {
    var key = String(row[headers.indexOf('snapshotKey')]);
    var month = String(row[headers.indexOf('month')]);
    byMonth[month] = (byMonth[month] || 0) + 1;
    if (byKey[key]) dupeKeys.push(key);
    byKey[key] = true;
  });

  Logger.log('Total rows: ' + values.length);
  Logger.log('Rows by month: ' + JSON.stringify(byMonth));
  Logger.log('Duplicate snapshotKeys: ' + dupeKeys.length + (dupeKeys.length ? ' — ' + dupeKeys.slice(0,5).join(', ') : ''));
}

// Run in Apps Script editor to remove duplicate rows and keep only the
// two most recent months. Loans for past months are not needed in the app.
function cleanupLoanHistory() {
  var ss = SpreadsheetApp.openById(SS_ID);
  var sheet = ss.getSheetByName('Loans');
  if (!sheet || sheet.getLastRow() < 2) { Logger.log('Nothing to clean.'); return; }

  var headers = SCHEMAS.Loans;
  var values = sheet.getRange(2, 1, sheet.getLastRow() - 1, headers.length).getValues();

  var current = currentMonth();
  var prev = Utilities.formatDate(
    new Date(Number(current.split('-')[0]), Number(current.split('-')[1]) - 2, 1),
    Session.getScriptTimeZone(), 'yyyy-MM'
  );

  // Keep only rows where month >= prev (last month + current month)
  // AND no duplicate snapshotKey (keep last occurrence)
  var seen = {};
  var kept = [];
  for (var i = values.length - 1; i >= 0; i--) {
    var key = String(values[i][headers.indexOf('snapshotKey')]);
    var month = String(values[i][headers.indexOf('month')]);
    if (month < prev) continue;      // too old
    if (seen[key]) continue;         // duplicate — already kept a newer one
    seen[key] = true;
    kept.unshift(values[i]);
  }

  // Rewrite the sheet
  sheet.getRange(2, 1, sheet.getLastRow() - 1, headers.length).clearContent();
  if (kept.length) {
    sheet.getRange(2, 1, kept.length, headers.length).setValues(kept);
  }
  Logger.log('Cleaned. Kept ' + kept.length + ' of ' + values.length + ' rows.');
}

// Run ONCE in Apps Script editor to rename Inekobank → Inecobank in all sheets.
function fixBankName() {
  var ss = SpreadsheetApp.openById(SS_ID);
  var fixed = 0;

  ['Obligations', 'Loans'].forEach(function(sheetName) {
    var sheet = ss.getSheetByName(sheetName);
    if (!sheet || sheet.getLastRow() < 2) return;
    var headers = SCHEMAS[sheetName];
    var bankCol = headers.indexOf('bank') + 1;
    if (bankCol < 1) return;

    var range = sheet.getRange(2, bankCol, sheet.getLastRow() - 1, 1);
    var values = range.getValues();
    values.forEach(function(row, i) {
      var old = String(row[0]);
      var updated = old.replace(/Inekobank/gi, 'Inecobank');
      if (updated !== old) { values[i][0] = updated; fixed++; }
    });
    range.setValues(values);
  });

  Logger.log('fixBankName: updated ' + fixed + ' cells.');
  return 'Done — ' + fixed + ' cells updated.';
}
