// ================================================================
// Finance Manager — Google Apps Script Backend
// Paste into script.google.com, run setup(), then deploy as:
//   Execute as: Me  |  Access: Anyone
// ================================================================

var SS_ID = '14tjp5lUfjZL9RTNMz8eCoxFOogbGSj-Op0C4WI7UNTY';

function doGet(e) {
  var action = (e && e.parameter && e.parameter.action) ? e.parameter.action : 'all';
  var ss = SpreadsheetApp.openById(SS_ID);
  var result;

  try {
    if (action === 'all') {
      result = {
        obligations: sheetToJson(ss, 'Obligations'),
        payments:    sheetToJson(ss, 'Payments'),
        income:      sheetToJson(ss, 'Income')
      };

    } else if (action === 'setPayment') {
      var key  = e.parameter.key;
      var paid = e.parameter.paid === 'true';
      upsertRow(ss, 'Payments', 'key', key, { key: key, paid: paid });
      result = { success: true };

    } else if (action === 'addIncome') {
      var id    = 'inc-' + Date.now();
      var sheet = ss.getSheetByName('Income');
      sheet.appendRow([id, e.parameter.date, Number(e.parameter.amount), e.parameter.stream, e.parameter.note || '']);
      result = { success: true, id: id };

    } else if (action === 'updateBalance') {
      var obs  = ss.getSheetByName('Obligations');
      var data = obs.getDataRange().getValues();
      var hdrs = data[0].map(function(h) { return String(h).trim(); });
      var idCol  = hdrs.indexOf('id');
      var balCol = hdrs.indexOf('currentBalance');
      for (var r = 1; r < data.length; r++) {
        if (String(data[r][idCol]) === String(e.parameter.id)) {
          obs.getRange(r + 1, balCol + 1).setValue(Number(e.parameter.balance));
          break;
        }
      }
      result = { success: true };

    } else {
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
  var sheet = ss.getSheetByName(name);
  if (!sheet) return [];
  var values = sheet.getDataRange().getValues();
  if (values.length < 2) return [];
  var headers = values[0].map(function(h) { return String(h).trim(); });
  return values.slice(1).map(function(row) {
    var obj = {};
    headers.forEach(function(h, i) { obj[h] = row[i]; });
    return obj;
  });
}

function upsertRow(ss, sheetName, keyField, keyValue, newRow) {
  var sheet   = ss.getSheetByName(sheetName);
  var data    = sheet.getDataRange().getValues();
  var headers = data[0].map(function(h) { return String(h).trim(); });
  var keyCol  = headers.indexOf(keyField);

  for (var i = 1; i < data.length; i++) {
    if (String(data[i][keyCol]) === String(keyValue)) {
      var rowData = headers.map(function(h) { return newRow[h] !== undefined ? newRow[h] : ''; });
      sheet.getRange(i + 1, 1, 1, headers.length).setValues([rowData]);
      return;
    }
  }
  sheet.appendRow(headers.map(function(h) { return newRow[h] !== undefined ? newRow[h] : ''; }));
}

// ----------------------------------------------------------------
// Run ONCE: creates sheets and seeds all 82 obligations
// ----------------------------------------------------------------
function setup() {
  var ss = SpreadsheetApp.openById(SS_ID);

  // --- Create / reset sheets ---
  var sheetDefs = [
    { name: 'Obligations', headers: ['id','payer','bank','category','amount','dueDay','currentBalance','loanTotal','contractNumber','active','startDate'] },
    { name: 'Payments',    headers: ['key','paid'] },
    { name: 'Income',      headers: ['id','date','amount','stream','note'] }
  ];

  sheetDefs.forEach(function(def) {
    var s = ss.getSheetByName(def.name);
    if (!s) s = ss.insertSheet(def.name);
    s.clear();
    s.setFrozenRows(1);
  });

  // Set contractNumber column (I) to plain text BEFORE any data is written
  // so Google Sheets never auto-converts values to numbers
  var ob = ss.getSheetByName('Obligations');
  ob.getRange('I:I').setNumberFormat('@');
  SpreadsheetApp.flush();

  // Write headers now (after format is committed)
  sheetDefs.forEach(function(def) {
    ss.getSheetByName(def.name).appendRow(def.headers);
  });
  SpreadsheetApp.flush();

  // --- Seed obligations ---
  // Columns: id, payer, bank, category, amount, dueDay, currentBalance, loanTotal, contractNumber, active, startDate
  // currentBalance = '' means "not yet verified / still to check"
  // startDate = 'YYYY-MM' (loan creation month) or '' if unknown

  var rows = [
    ['ob-001','Hovhannes','Unibank','loan',20000,1,570000,600000,'241400148490L004',true,'2026-03'],
    ['ob-002','Alvard','Inekobank','loan',7000,1,241000,264582,'205025219473L027',true,'2025-12'],
    ['ob-003','Alvard','Inekobank','loan',6000,3,128000,200000,'205025219473L022',true,''],
    ['ob-004','Alvard','Inekobank','loan',5000,3,123000,155000,'2050252194737024',true,''],
    ['ob-005','Hovhannes','Unibank','loan',20000,4,65000,600000,'241400148490L003',true,''],
    ['ob-006','Karine','Inekobank','loan',20000,5,175000,577000,'205009102232L015',true,''],
    ['ob-007','Home','Home Rent','personal',85000,5,'','','',true,''],
    ['ob-008','Grigor','ACBA Bank','loan',60000,5,1138000,1900000,'220050024334L004',true,''],
    ['ob-009','Hovhannes','Inekobank','loan',7500,5,147000,210000,'205055868553L063',true,''],
    ['ob-010','Karine','Inekobank','loan',44000,5,952000,1376000,'205009102232L036',true,''],
    ['ob-011','Alvard','Inekobank','loan',13000,6,515000,537926,'205025219473L029',true,''],
    ['ob-012','Grigor','Converse Bank','loan',23000,7,'',580000,'L06970 011598737',true,''],
    ['ob-013','Hovhannes','Inekobank','loan',22000,7,295000,510850,'205055868553L064',true,''],
    ['ob-014','Karine','Inekobank','loan',4000,7,23000,82600,'205009102232L028',true,''],
    ['ob-015','Karine','Inekobank','loan',3000,7,4000,65870,'205009102232L029',true,''],
    ['ob-016','Karine','Inekobank','loan',5500,7,107000,153000,'205009102232L030',true,''],
    ['ob-017','Karine','Inekobank','loan',31000,8,789000,959000,'205009102232L034',true,''],
    ['ob-018','Karine','Inekobank','loan',25000,8,565000,719600,'205009102232L035',true,''],
    ['ob-019','Karine','Inekobank','loan',5000,8,90000,102000,'205009102232L040',true,'2026-02'],
    ['ob-020','Karine','Inekobank','loan',20000,9,77000,524000,'205009102232L014',true,''],
    ['ob-021','Alvard','Converse Bank','loan',12000,9,'',270000,'A01768 AR0498235',true,'2025-12'],
    ['ob-022','Karine','Inekobank','loan',23000,9,868000,941336,'205009102232L038',true,'2025-12'],
    ['ob-023','Plus 1','Armenikum','business',930000,10,'','','',true,''],
    ['ob-024','Karine','VTB Armenia','loan',10000,11,173000,282000,'160485731881L002',true,''],
    ['ob-025','Karine','Inekobank','loan',24000,11,368000,612000,'205009102232L032',true,''],
    ['ob-026','Karine','Inekobank','loan',16000,11,482000,571000,'205009102232L033',true,''],
    ['ob-027','Hovhannes','ID Bank','loan',9000,11,86000,105314,'118000626572L020',true,'2026-04'],
    ['ob-028','Hovhannes','ID Bank','loan',11000,11,118000,200000,'118000626572L003',true,''],
    ['ob-029','Alvard','Inekobank','loan',5000,11,129000,148722,'205025219473L028',true,'2026-02'],
    ['ob-030','Alvard','Inekobank','loan',30000,12,346000,1000000,'205025219473L013',true,''],
    ['ob-031','Karine','Inekobank','loan',31000,12,747000,992407,'205009102232L037',true,''],
    ['ob-032','Alvard','Inekobank','loan',4000,13,105000,129000,'205025219473L025',true,''],
    ['ob-033','Alvard','Converse Bank','loan',6000,13,'',100000,'L89213 AR0498235',true,''],
    ['ob-034','Alvard','Inekobank','loan',19000,13,656000,733970,'205025219473L026',true,''],
    ['ob-035','Alvard','Unibank','loan',20000,14,464000,630000,'241010032969L004',true,''],
    ['ob-036','Plus 1','Service Fees','business',421000,15,'','','',true,''],
    ['ob-037','Karine','Inekobank','loan',18000,15,347000,500000,'205009102232L027',true,''],
    ['ob-038','Business','Bar Association','business',5000,15,'','','',true,''],
    ['ob-039','Business','ICC','business',10000,15,'','','',true,''],
    ['ob-040','Hovhannes','Converse Bank','loan',38000,15,'',1000000,'L07280 009987561',true,''],
    ['ob-041','Alvard','Inekobank','loan',4000,15,19000,101000,'205025219473L023',true,''],
    ['ob-042','Hovhannes','VTB Armenia','loan',14000,15,406000,470000,'160482758382L010',true,'2025-08'],
    ['ob-043','Alvard','Inekobank','loan',15000,16,442000,489000,'205025219473L030',true,'2026-03'],
    ['ob-044','Hovhannes','ID Bank','loan',21000,16,181000,243290,'118000626572L013',true,''],
    ['ob-045','Hovhannes','Inekobank','loan',18000,17,464000,583931,'205055868553L065',true,''],
    ['ob-046','Hovhannes','ID Bank','loan',10000,17,'',85310,'118000626572L015',true,'2026-03'],
    ['ob-047','Hovhannes','ID Bank','loan',3500,17,'',38058,'118000626572L016',true,'2026-03'],
    ['ob-048','Karine','Inekobank','loan',7000,18,137000,201000,'205009102232L031',true,''],
    ['ob-049','Hovhannes','ID Bank','loan',21000,18,'',152400,'118000626572L017',true,'2026-03'],
    ['ob-050','Alvard','Converse Bank','loan',25000,18,'',620000,'A23722 AR0498235',true,'2026-03'],
    ['ob-051','Plus 1','Taxes','business',54000,19,'','','',true,''],
    ['ob-052','Home','Utilities','personal',128800,20,'','','',true,''],
    ['ob-053','Karine','Ardshininbank','loan',10000,20,0,400000,'247460420539L001',true,''],
    ['ob-054','Hovhannes','Ardshininbank','loan',20000,20,0,500000,'247002700646L005',true,''],
    ['ob-055','Hovhannes','VTB Armenia','loan',10000,20,119000,418000,'160482758382L009',true,''],
    ['ob-056','Plus 1','ACBA Bank','loan',240000,20,8295000,8680000,'220554307037L005',true,'2026-03'],
    ['ob-057','Plus 1','ACBA Bank','loan',46000,20,799000,1300000,'220554307037L004',true,''],
    ['ob-058','Hovhannes','AMIO Bank','loan',52000,20,'',2000000,'',true,''],
    ['ob-059','Karine','Inekobank','loan',20000,21,59000,525000,'205009102232L013',true,''],
    ['ob-060','Hovhannes','Ardshininbank','loan',10000,21,104000,350000,'247002700646L003',true,''],
    ['ob-061','Hovhannes','Inekobank','loan',3500,21,115000,136680,'205055868553L066',true,'2026-01'],
    ['ob-062','Karine','Inekobank','loan',80000,21,2976000,3157000,'205009102232L039',true,'2026-01'],
    ['ob-063','Alvard','Converse Bank','loan',10000,23,'',224000,'C39212 AR0498235',true,''],
    ['ob-064','Grigor','Unibank','loan',22000,25,'',600000,'241010036226L002',true,''],
    ['ob-065','Grigor','Unibank','loan',30000,25,'',731000,'241010036226L001',true,''],
    ['ob-066','Grigor','Ardshininbank','loan',15000,25,283000,400000,'247004702939L002',true,''],
    ['ob-067','Hovhannes','Ardshininbank','loan',6000,25,140000,186970,'247002700646L006',true,''],
    ['ob-068','Grigor','Ardshininbank','loan',6000,25,119000,186970,'247004702939L003',true,''],
    ['ob-069','Hovhannes','Converse Bank','loan',10000,25,'',220000,'L68365 009987561',true,''],
    ['ob-070','Hovhannes','Ardshininbank','loan',3000,25,128000,150185,'247002700646L007',true,''],
    ['ob-071','Karine','Ardshininbank','loan',20000,25,573000,600000,'247460420539L003',true,'2025-12'],
    ['ob-072','Alvard','Ardshininbank','loan',12000,25,'',400000,'247500269987L005',true,'2026-02'],
    ['ob-073','Karine','ID Bank','loan',6000,29,'',100000,'118008125809L001',true,''],
    ['ob-074','Plus 1','Office Rent','business',2460500,30,'','','',true,''],
    ['ob-075','GPS','GPS Service','business',28000,30,'','','',true,''],
    // 7 obligations added from full Excel data
    ['ob-076','Grigor','ID Bank','loan',0,15,'',20000,'payment due Jun 2026',true,'2025-12'],
    ['ob-077','Plus 1','Payroll','business',0,30,'','','',true,''],
    ['ob-078','Alvard','Inekobank /Credit Line/','loan',0,30,'',1000000,'2050252194737003',true,''],
    ['ob-079','Hovhannes','Inekobank /Credit Line/','loan',0,30,0,500000,'2050558685537000',true,''],
    ['ob-080','Karine','Inekobank /Credit Line/','loan',0,30,0,100000,'2050091022327003',true,''],
    ['ob-081','Plus 1','ACBA Bank','loan',0,0,1000000,1000000,'',true,''],
    ['ob-082','Hovhannes','Karine Avetisyan','personal',0,0,2000500,'','',true,'']
  ];

  ob.getRange(2, 1, rows.length, rows[0].length).setValues(rows);
  SpreadsheetApp.flush();
  Logger.log('Setup complete: ' + rows.length + ' obligations seeded.');
}
