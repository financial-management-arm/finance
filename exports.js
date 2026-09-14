'use strict';

const exportLibraries = new Map();
const FINANCE_EXPORT_COLUMNS = [
  ['month', 'Month', 12], ['payer', 'Payer', 28], ['bank', 'Bank', 26],
  ['balance', 'Remaining balance (AMD)', 24], ['day', 'Payment day', 14],
  ['amount', 'Monthly payment (AMD)', 24], ['code', 'Loan code', 36],
  ['initial', 'Initial amount (AMD)', 23], ['source', 'Balance as of', 15],
  ['category', 'Category', 18], ['frequency', 'Frequency', 16],
  ['paymentStatus', 'Payment status', 18], ['reconciled', 'Reconciled', 14],
  ['id', 'Record ID', 22], ['draft', 'Unsaved draft (AMD)', 24], ['saveState', 'Save state', 16]
];

function financeExportSnapshot(view) {
  if (!['obligations', 'reconcile'].includes(view)) throw new Error('Unknown export view');
  let visible;
  if (view === 'reconcile') visible = filteredReconLoans();
  else {
    const sorted = sortObligations(filterObligations(activeObs()));
    visible = [...sorted.filter(isLoanRecord), ...sorted.filter(o => !isLoanRecord(o))];
  }
  const numeric = value => value === null || value === undefined || value === '' || !Number.isFinite(Number(value)) ? '' : Number(value);
  return { title: view === 'reconcile' ? 'Reconcile' : 'Obligations', month: state.month,
    rows: visible.map(o => {
      const draft = reconDrafts.get(pkey(o.id, state.month));
      return {
        month: state.month, payer: String(o.payer || ''), bank: String(o.bank || ''),
        balance: isLoanRecord(o) ? numeric(loanBalance(o)) : '', day: numeric(o.dueDay),
        amount: numeric(o.amount), code: String(o.contractNumber || '').replace(/#/g, '').trim(),
        initial: numeric(o.loanTotal), source: isLoanRecord(o) ? balanceSourceMonth(o) : '',
        category: String(o.category || ''), frequency: String(o.frequency || 'monthly'),
        paymentStatus: paymentStatus(o.id), reconciled: balanceReadMonth(o) === state.month ? 'Yes' : 'No',
        id: String(o.id || ''), draft: draft ? numeric(draft.value) : '', saveState: draft?.status || 'Saved'
      };
    }) };
}

function exportTextCell(value, separator) {
  let text = String(value ?? '');
  if (typeof value === 'string' && /^[\s]*[=+@-]/.test(text)) text = "'" + text;
  if (separator === '\t') return text.replace(/[\t\r\n]/g, ' ');
  return '"' + text.replace(/"/g, '""') + '"';
}

function loadExportLibrary(name, file) {
  if (window[name]) return Promise.resolve(window[name]);
  if (!exportLibraries.has(name)) {
    const promise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = file;
      script.onload = () => window[name] ? resolve(window[name]) : reject(new Error('Export library did not load'));
      script.onerror = () => { script.remove(); reject(new Error('Could not load export tools. Reconnect and retry.')); };
      document.head.append(script);
    }).catch(error => { exportLibraries.delete(name); throw error; });
    exportLibraries.set(name, promise);
  }
  return exportLibraries.get(name);
}

async function financeExcel(snapshot) {
  const Excel = await loadExportLibrary('ExcelJS', 'vendor/exceljs.min.js');
  const workbook = new Excel.Workbook();
  workbook.creator = 'Finances';
  workbook.title = `${snapshot.title} - ${snapshot.month}`;
  const sheet = workbook.addWorksheet(snapshot.title, { views: [{ state: 'frozen', ySplit: 1 }] });
  sheet.columns = FINANCE_EXPORT_COLUMNS.map(([key, header, width]) => ({ key, header, width }));
  sheet.addRows(snapshot.rows);
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: snapshot.rows.length + 1, column: FINANCE_EXPORT_COLUMNS.length } };
  sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF163D50' } };
  sheet.getRow(1).height = 32;
  sheet.getRow(1).alignment = { vertical: 'middle', wrapText: true };
  ['code', 'id', 'month', 'source'].forEach(key => { sheet.getColumn(key).numFmt = '@'; });
  ['balance', 'amount', 'initial', 'draft'].forEach(key => { sheet.getColumn(key).numFmt = '#,##0.##'; });
  return workbook.xlsx.writeBuffer();
}

async function financePdf(snapshot) {
  const { PDFDocument } = await loadExportLibrary('PDFLib', 'vendor/pdf-lib.min.js');
  const fontkit = await loadExportLibrary('fontkit', 'vendor/fontkit.min.js');
  const pdf = await PDFDocument.create();
  pdf.setTitle(`${snapshot.title} - ${snapshot.month}`);
  pdf.setAuthor('Finances');
  pdf.registerFontkit(fontkit);
  const fonts = await Promise.all(['notosansarmenian', 'notosans'].map(async name => {
    const response = await fetch(`vendor/${name}.ttf`);
    if (!response.ok) throw new Error('Could not load PDF fonts. Reconnect and retry.');
    const font = await pdf.embedFont(await response.arrayBuffer(), { subset: true });
    return { font, characters: new Set(font.getCharacterSet()) };
  }));
  const runs = text => {
    const output = [];
    for (const character of String(text ?? '').replace(/[\r\n\t]/g, ' ')) {
      const selected = fonts.find(item => item.characters.has(character.codePointAt(0)));
      if (!selected) throw new Error('A character is unsupported in PDF. Use the Excel or text export for this record.');
      const last = output[output.length - 1];
      if (last?.font === selected.font) last.text += character;
      else output.push({ font: selected.font, text: character });
    }
    return output;
  };
  const widthOf = (text, size = 10) => runs(text).reduce((width, run) => width + run.font.widthOfTextAtSize(run.text, size), 0);
  let page, y, pageNumber = 0;
  const draw = (text, x, top, size = 10, color = [0.12, 0.15, 0.18]) => {
    for (const run of runs(text)) {
      page.drawText(run.text, { x, y: 595.28 - top - size, size, font: run.font, color: PDFLib.rgb(...color) });
      x += run.font.widthOfTextAtSize(run.text, size);
    }
  };
  const columns = [
    ['payer', 'Payer', 130], ['bank', 'Bank', 106], ['balance', 'Remaining AMD', 84],
    ['day', 'Day', 30], ['amount', 'Monthly AMD', 78], ['code', 'Loan code', 142],
    ['initial', 'Initial AMD', 82], ['source', 'Balance as of', 82]
  ];
  const wrap = (value, width, size = 10) => {
    const lines = []; let line = '';
    for (const char of String(value ?? '')) {
      if (char === '\n' || widthOf(line + char, size) > width) { lines.push(line); line = char === '\n' ? '' : char; }
      else line += char;
    }
    lines.push(line);
    return lines;
  };
  const startPage = () => {
    page = pdf.addPage([841.89, 595.28]);
    pageNumber++; y = 92;
    draw(snapshot.title, 24, 18, 19);
    draw(`${snapshot.month} | ${snapshot.rows.length} filtered records | Saved balances in AMD`, 24, 47, 10);
    page.drawRectangle({ x: 24, y: 510, width: 794, height: 20, color: PDFLib.rgb(0.92, 0.95, 0.97) });
    let x = 24;
    columns.forEach(([, label, width]) => { draw(label, x + 3, 68, 9); x += width; });
    draw(`Finances | Page ${pageNumber} | Drafts are not saved balances.`, 24, 576, 8);
  };
  startPage();
  for (const row of snapshot.rows) {
    const cells = columns.map(([key, , width]) => wrap(row[key], width - 6));
    const metadata = `ID: ${row.id} | ${row.category} | ${row.frequency} | Payment: ${row.paymentStatus} | Reconciled: ${row.reconciled}${row.draft !== '' ? ` | UNSAVED DRAFT: ${row.draft} (${row.saveState})` : ''}`;
    const details = wrap(metadata, 780, 8);
    let offset = 0;
    const lineCount = Math.max(...cells.map(lines => lines.length));
    while (offset < lineCount) {
      if (y + 42 > 559) startPage();
      const take = Math.max(1, Math.min(lineCount - offset, Math.floor((559 - y - details.length * 11 - 10) / 14)));
      let x = 24;
      cells.forEach((lines, index) => {
        lines.slice(offset, offset + take).forEach((line, n) => draw(line, x + 3, y + n * 14));
        x += columns[index][2];
      });
      y += take * 14;
      offset += take;
      if (offset === lineCount) {
        details.forEach(line => { draw(line, 27, y, 8, [0.36, 0.36, 0.4]); y += 11; });
        y += 10;
        page.drawLine({ start: { x: 24, y: 599.28 - y }, end: { x: 818, y: 599.28 - y }, color: PDFLib.rgb(0.9, 0.9, 0.92), thickness: 0.5 });
      } else startPage();
    }
  }
  return pdf.save();
}

async function exportFinanceView(view, format, button) {
  const originalLabel = button.textContent;
  button.disabled = true; button.textContent = 'Preparing...';
  try {
    const snapshot = financeExportSnapshot(view);
    if (!snapshot.rows.length) { showToast('No filtered items to export.'); return; }
    let data, type;
    if (format === 'xlsx') {
      data = await financeExcel(snapshot);
      type = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    } else if (format === 'pdf') { data = await financePdf(snapshot); type = 'application/pdf'; }
    else if (format === 'csv' || format === 'txt') {
      const separator = format === 'csv' ? ',' : '\t';
      data = '\uFEFF' + [FINANCE_EXPORT_COLUMNS.map(([, label]) => label), ...snapshot.rows.map(row => FINANCE_EXPORT_COLUMNS.map(([key]) => row[key]))]
        .map(row => row.map(cell => exportTextCell(cell, separator)).join(separator)).join('\r\n');
      type = format === 'csv' ? 'text/csv;charset=utf-8' : 'text/plain;charset=utf-8';
    } else throw new Error('Unsupported export format');
    const url = URL.createObjectURL(new Blob([data], { type }));
    const link = document.createElement('a');
    link.href = url; link.download = `${snapshot.title.toLowerCase()}-${snapshot.month}.${format}`;
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    button.closest('details')?.removeAttribute('open');
  } catch (error) { showError(`Export failed: ${error.message}`); }
  finally { button.disabled = false; button.textContent = originalLabel; }
}
