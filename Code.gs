// ================================================================
// Finance Manager — Google Apps Script Backend
// Paste this into script.google.com, set SS_ID, run setupSheets()
// then deploy as Web App: Execute as Me, Access: Anyone
// ================================================================

const SS_ID = 'YOUR_GOOGLE_SHEET_ID_HERE'; // ← paste your Sheet ID

function doGet(e) {
  const action = (e && e.parameter && e.parameter.action) || 'all';
  const ss = SpreadsheetApp.openById(SS_ID);
  let result;

  try {
    switch (action) {

      case 'all':
        result = {
          obligations: sheetToJson(ss, 'Obligations'),
          payments:    sheetToJson(ss, 'Payments'),
          income:      sheetToJson(ss, 'Income')
        };
        break;

      case 'setPayment': {
        const key  = e.parameter.key;
        const paid = e.parameter.paid === 'true';
        upsertRow(ss, 'Payments', 'key', key, { key, paid });
        result = { success: true };
        break;
      }

      case 'addIncome': {
        const id    = 'inc-' + Date.now();
        const sheet = ss.getSheetByName('Income');
        sheet.appendRow([id, e.parameter.date, Number(e.parameter.amount), e.parameter.stream, e.parameter.note || '']);
        result = { success: true, id };
        break;
      }

      case 'updateBalance': {
        const sheet   = ss.getSheetByName('Obligations');
        const data    = sheet.getDataRange().getValues();
        const headers = data[0].map(h => String(h).trim());
        const idCol   = headers.indexOf('id');
        const balCol  = headers.indexOf('currentBalance');
        for (let i = 1; i < data.length; i++) {
          if (String(data[i][idCol]) === String(e.parameter.id)) {
            sheet.getRange(i + 1, balCol + 1).setValue(Number(e.parameter.balance));
            break;
          }
        }
        result = { success: true };
        break;
      }

      default:
        result = { error: 'Unknown action: ' + action };
    }
  } catch (err) {
    result = { error: err.toString() };
  }

  return ContentService
    .createTextOutput(JSON.stringify(result))
    .setMimeType(ContentService.MimeType.JSON);
}

// ----------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------
function sheetToJson(ss, name) {
  const sheet = ss.getSheetByName(name);
  if (!sheet) return [];
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return [];
  const headers = values[0].map(h => String(h).trim());
  return values.slice(1).map(row => {
    const obj = {};
    headers.forEach((h, i) => { obj[h] = row[i]; });
    return obj;
  });
}

function upsertRow(ss, sheetName, keyField, keyValue, newRow) {
  const sheet   = ss.getSheetByName(sheetName);
  const data    = sheet.getDataRange().getValues();
  const headers = data[0].map(h => String(h).trim());
  const keyCol  = headers.indexOf(keyField);

  for (let i = 1; i < data.length; i++) {
    if (String(data[i][keyCol]) === String(keyValue)) {
      const rowData = headers.map(h => newRow[h] !== undefined ? newRow[h] : '');
      sheet.getRange(i + 1, 1, 1, headers.length).setValues([rowData]);
      return;
    }
  }
  sheet.appendRow(headers.map(h => newRow[h] !== undefined ? newRow[h] : ''));
}

// ----------------------------------------------------------------
// Run ONCE: creates the three sheets with correct headers
// ----------------------------------------------------------------
function setupSheets() {
  const ss = SpreadsheetApp.openById(SS_ID);

  function ensureSheet(name, headers) {
    let sheet = ss.getSheetByName(name);
    if (!sheet) sheet = ss.insertSheet(name);
    sheet.clearContents();
    sheet.appendRow(headers);
    sheet.setFrozenRows(1);
    return sheet;
  }

  ensureSheet('Obligations', ['id','payer','bank','category','amount','dueDay','currentBalance','loanTotal','contractNumber','active']);
  ensureSheet('Payments',    ['key','paid']);
  ensureSheet('Income',      ['id','date','amount','stream','note']);

  SpreadsheetApp.flush();
  Logger.log('Sheets created. Now run seedObligations().');
}

// ----------------------------------------------------------------
// Run ONCE after setupSheets(): seeds all 75 obligations
// ----------------------------------------------------------------
function seedObligations() {
  const ss    = SpreadsheetApp.openById(SS_ID);
  const sheet = ss.getSheetByName('Obligations');

  // [id, payer, bank, category, amount, dueDay, currentBalance, loanTotal, contractNumber, active]
  const rows = [
    ['ob-001','Hovhannes','Unibank','loan',20000,1,570000,600000,'241400148490L004',true],
    ['ob-002','Alvard','Inekobank','loan',7000,1,241000,264582,'205025219473L027',true],
    ['ob-003','Alvard','Inekobank','loan',6000,3,128000,200000,'205025219473L022',true],
    ['ob-004','Alvard','Inekobank','loan',5000,3,123000,155000,'2050252194737024',true],
    ['ob-005','Hovhannes','Unibank','loan',20000,4,65000,600000,'241400148490L003',true],
    ['ob-006','Karine','Inekobank','loan',20000,5,175000,577000,'205009102232L015',true],
    ['ob-007','Home','Home Rent','personal',85000,5,'','','',true],
    ['ob-008','Grigor','ACBA Bank','loan',60000,5,1138000,1900000,'220050024334L004',true],
    ['ob-009','Hovhannes','Inekobank','loan',7500,5,147000,210000,'205055868553L063',true],
    ['ob-010','Karine','Inekobank','loan',44000,5,952000,1376000,'205009102232L036',true],
    ['ob-011','Alvard','Inekobank','loan',13000,6,515000,537926,'205025219473L029',true],
    ['ob-012','Grigor','Converse Bank','loan',23000,7,'',580000,'L06970 011598737',true],
    ['ob-013','Hovhannes','Inekobank','loan',22000,7,295000,510850,'205055868553L064',true],
    ['ob-014','Karine','Inekobank','loan',4000,7,23000,82600,'205009102232L028',true],
    ['ob-015','Karine','Inekobank','loan',3000,7,4000,65870,'205009102232L029',true],
    ['ob-016','Karine','Inekobank','loan',5500,7,107000,153000,'205009102232L030',true],
    ['ob-017','Karine','Inekobank','loan',31000,8,789000,959000,'205009102232L034',true],
    ['ob-018','Karine','Inekobank','loan',25000,8,565000,719600,'205009102232L035',true],
    ['ob-019','Karine','Inekobank','loan',5000,8,90000,102000,'205009102232L040',true],
    ['ob-020','Karine','Inekobank','loan',20000,9,77000,524000,'205009102232L014',true],
    ['ob-021','Alvard','Converse Bank','loan',12000,9,'',270000,'A01768 AR0498235',true],
    ['ob-022','Karine','Inekobank','loan',23000,9,868000,941336,'205009102232L038',true],
    ['ob-023','Plus 1','Armenikum','business',930000,10,'','','',true],
    ['ob-024','Karine','VTB Armenia','loan',10000,11,173000,282000,'160485731881L002',true],
    ['ob-025','Karine','Inekobank','loan',24000,11,368000,612000,'205009102232L032',true],
    ['ob-026','Karine','Inekobank','loan',16000,11,482000,571000,'205009102232L033',true],
    ['ob-027','Hovhannes','ID Bank','loan',9000,11,86000,105314,'118000626572L020',true],
    ['ob-028','Hovhannes','ID Bank','loan',11000,11,118000,200000,'118000626572L003',true],
    ['ob-029','Alvard','Inekobank','loan',5000,11,129000,148722,'205025219473L028',true],
    ['ob-030','Alvard','Inekobank','loan',30000,12,346000,1000000,'205025219473L013',true],
    ['ob-031','Karine','Inekobank','loan',31000,12,747000,992407,'205009102232L037',true],
    ['ob-032','Alvard','Inekobank','loan',4000,13,105000,129000,'205025219473L025',true],
    ['ob-033','Alvard','Converse Bank','loan',6000,13,'',100000,'L89213 AR0498235',true],
    ['ob-034','Alvard','Inekobank','loan',19000,13,656000,733970,'205025219473L026',true],
    ['ob-035','Alvard','Unibank','loan',20000,14,464000,630000,'241010032969L004',true],
    ['ob-036','Plus 1','Service Fees','business',421000,15,'','','',true],
    ['ob-037','Karine','Inekobank','loan',18000,15,347000,500000,'205009102232L027',true],
    ['ob-038','Business','Bar Association','business',5000,15,'','','',true],
    ['ob-039','Business','ICC','business',10000,15,'','','',true],
    ['ob-040','Hovhannes','Converse Bank','loan',38000,15,'',1000000,'L07280 009987561',true],
    ['ob-041','Alvard','Inekobank','loan',4000,15,19000,101000,'205025219473L023',true],
    ['ob-042','Hovhannes','VTB Armenia','loan',14000,15,406000,470000,'160482758382L010',true],
    ['ob-043','Alvard','Inekobank','loan',15000,16,442000,489000,'205025219473L030',true],
    ['ob-044','Hovhannes','ID Bank','loan',21000,16,181000,243290,'118000626572L013',true],
    ['ob-045','Hovhannes','Inekobank','loan',18000,17,464000,583931,'205055868553L065',true],
    ['ob-046','Hovhannes','ID Bank','loan',10000,17,'',85310,'118000626572L015',true],
    ['ob-047','Hovhannes','ID Bank','loan',3500,17,'',38058,'118000626572L016',true],
    ['ob-048','Karine','Inekobank','loan',7000,18,137000,201000,'205009102232L031',true],
    ['ob-049','Hovhannes','ID Bank','loan',21000,18,'',152400,'118000626572L017',true],
    ['ob-050','Alvard','Converse Bank','loan',25000,18,'',620000,'A23722 AR0498235',true],
    ['ob-051','Plus 1','Taxes','business',54000,19,'','','',true],
    ['ob-052','Home','Utilities','personal',128800,20,'','','',true],
    ['ob-053','Karine','Ardshininbank','loan',10000,20,0,400000,'247460420539L001',true],
    ['ob-054','Hovhannes','Ardshininbank','loan',20000,20,0,500000,'247002700646L005',true],
    ['ob-055','Hovhannes','VTB Armenia','loan',10000,20,119000,418000,'160482758382L009',true],
    ['ob-056','Plus 1','ACBA Bank','loan',240000,20,8295000,8680000,'220554307037L005',true],
    ['ob-057','Plus 1','ACBA Bank','loan',46000,20,799000,1300000,'220554307037L004',true],
    ['ob-058','Hovhannes','AMIO Bank','loan',52000,20,'',2000000,'',true],
    ['ob-059','Karine','Inekobank','loan',20000,21,59000,525000,'205009102232L013',true],
    ['ob-060','Hovhannes','Ardshininbank','loan',10000,21,104000,350000,'247002700646L003',true],
    ['ob-061','Hovhannes','Inekobank','loan',3500,21,115000,136680,'205055868553L066',true],
    ['ob-062','Karine','Inekobank','loan',80000,21,2976000,3157000,'205009102232L039',true],
    ['ob-063','Alvard','Converse Bank','loan',10000,23,'',224000,'C39212 AR0498235',true],
    ['ob-064','Grigor','Unibank','loan',22000,25,'',600000,'241010036226L002',true],
    ['ob-065','Grigor','Unibank','loan',30000,25,'',731000,'241010036226L001',true],
    ['ob-066','Grigor','Ardshininbank','loan',15000,25,283000,400000,'247004702939L002',true],
    ['ob-067','Hovhannes','Ardshininbank','loan',6000,25,140000,186970,'247002700646L006',true],
    ['ob-068','Grigor','Ardshininbank','loan',6000,25,119000,186970,'247004702939L003',true],
    ['ob-069','Hovhannes','Converse Bank','loan',10000,25,'',220000,'L68365 009987561',true],
    ['ob-070','Hovhannes','Ardshininbank','loan',3000,25,128000,150185,'247002700646L007',true],
    ['ob-071','Karine','Ardshininbank','loan',20000,25,573000,600000,'247460420539L003',true],
    ['ob-072','Alvard','Ardshininbank','loan',12000,25,'',400000,'247500269987L005',true],
    ['ob-073','Karine','ID Bank','loan',6000,29,'',100000,'118008125809L001',true],
    ['ob-074','Plus 1','Office Rent','business',2460500,30,'','','',true],
    ['ob-075','GPS','Service','business',28000,30,'','','',true],
  ];

  rows.forEach(row => sheet.appendRow(row));
  SpreadsheetApp.flush();
  Logger.log('Seeded ' + rows.length + ' obligations.');
}
