/**
 * Lead FMS  <->  Google Sheet connector  (reads ALL tabs)
 * ------------------------------------------------------------------
 * The person who works on the sheet every morning types ONLY these columns:
 *     Timestamp | Lead Name | Lead Email | Lead Phone | UTW Date | Assigned To | Workshop Name | WhatsApp Link
 * (Workshop Name = the workshop this lead came for. Type a NEW name and the website shows a filter for it.)
 * (WhatsApp Link = the WhatsApp group/link for that lead. Added ONLY when leads are assigned each morning.)
 * The website reads those rows from EVERY lead tab of this file (new leads appear for the callers).
 * When a caller updates a lead on the website, this script fills in:
 *     Level | Profession | City
 * on the same row, in whichever tab that lead is in.
 *
 * Pabbly Connect fills one more column by itself:
 *     Msg Sent    (so the same lead never gets the WhatsApp message twice)
 *
 * INSTANT SYNC: run  setupInstantSync  once. Every new row then reaches the website within seconds (and gets its Timestamp).
 *
 * WHICH TABS ARE READ
 *  - Every tab that has a header row containing "Lead Phone" and "Lead Name" (columns can be in any order).
 *  - A tab whose name starts with an underscore (_Archive, _Notes, _Links ...) is IGNORED.
 *  - Hidden tabs and tabs without those headers are ignored.
 *  - To read just one tab, type its name in ONLY_TAB below.
 *
 * SETUP (once, ~3 minutes)
 *  1. In the Google Sheet:  Extensions -> Apps Script.  Delete what is there and paste this whole file.
 *  2. Press Save, then choose the function  setupSheet  and press Run (allow access when asked).
 *     It adds headers to empty tabs, adds the missing columns (Workshop Name, WhatsApp Link, Level, Profession,
 *     City, Msg Sent) to every lead tab, greys out the three website columns, and keeps the Timestamp automatic.
 *  3. Deploy -> New deployment -> type "Web app".
 *        Execute as:      Me
 *        Who has access:  Anyone
 *     Press Deploy and copy the "Web app URL".
 *  4. In the website:  Settings -> Google Sheet -> paste that URL -> Save -> Test connection.
 *
 *  Adding a new tab later: right-click an existing tab -> Duplicate (keeps the headers), clear the old rows, rename it.
 *  A brand-new empty tab: run  setupSheet  once more. Not sure which tabs are read? Run  checkTabs.
 *  If you change this file later: Deploy -> Manage deployments -> edit -> New version.
 */

var SECRET_KEY = "__SECRET_KEY__";   // filled in for you by the website's "Copy Apps Script" button
var SYNC_URL   = "__SYNC_URL__";     // the website's address for "a row just arrived" (also filled in by the button)
var ONLY_TAB   = "";                 // leave empty = read every lead tab; or type one tab's name
var TIME_ZONE  = "Asia/Kolkata";

var WEBSITE_COLUMNS    = ["Level", "Profession", "City"];
var TYPED_COLUMNS      = ["Workshop Name", "WhatsApp Link"];   // typed by the morning person; setupSheet adds the header when a tab has none
var AUTOMATION_COLUMNS = ["Msg Sent"];                         // filled by Pabbly Connect; the website ignores it

// the columns the website understands: [name sent to the website, how to recognise the header]
var COLUMNS = [
  ["Timestamp", /timestamp/], ["Lead Name", /^(?!.*workshop).*name/], ["Lead Email", /email/], ["Lead Phone", /phone/],
  ["UTW Date", /utw|start.*date/],                                   // "UTW Date" or "Workshop Start Date"
  ["Assigned To", /assigned/],
  ["Workshop Name", /^workshop(?!.*(date|start|link))/],             // NOT "Workshop Start Date"
  ["WhatsApp Link", /whatsapp.*link/],
  ["Level", /^level/], ["Profession", /profession/], ["City", /city/],
  ["Msg Sent", /msg.*sent/], ["Call Status", /call.*status/]         // read so the website never re-sends a message Pabbly already sent
];

/* ---------------------------------------------------------------- web app */

// the website asks: "give me all rows"
function doGet(e) {
  try {
    check_(e.parameter.token);
    return json_({ ok: true, rows: readRows_() });
  } catch (err) {
    return json_({ ok: false, error: String(err.message || err) });
  }
}

// the website says: "write Level / Profession / City for these phone numbers"
function doPost(e) {
  var lock = LockService.getScriptLock();
  try {
    var body = JSON.parse(e.postData.contents);
    check_(body.token);
    lock.waitLock(20000);
    return json_(Object.assign({ ok: true }, writeBack_(body.updates || [])));
  } catch (err) {
    return json_({ ok: false, error: String(err.message || err) });
  } finally {
    try { lock.releaseLock(); } catch (x) {}
  }
}

function check_(token) {
  if (!SECRET_KEY || SECRET_KEY.indexOf("__") === 0) throw new Error("Secret key not set in the script");
  if (token !== SECRET_KEY) throw new Error("Wrong secret key");
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

/* ------------------------------------------------------------- finding tabs */

function skipTab_(sh) {
  var name = sh.getName();
  return name.charAt(0) === "_" || sh.isSheetHidden() || (ONLY_TAB !== "" && name !== ONLY_TAB);
}

// a lead tab = a header row (within the first 15 rows) that has both "phone" and "name"
function inspect_(sh) {
  var rows = Math.min(sh.getLastRow(), 15), cols = sh.getLastColumn();
  if (rows < 1 || cols < 1) return null;
  var top = sh.getRange(1, 1, rows, cols).getValues();
  for (var i = 0; i < top.length; i++) {
    var head = top[i].map(function (h) { return String(h).trim().toLowerCase(); });
    if (head.some(function (h) { return /phone/.test(h); }) && head.some(function (h) { return /name/.test(h); })) {
      return { sheet: sh, hi: i, head: head };
    }
  }
  return null;
}

function leadTabs_() {
  var out = [];
  SpreadsheetApp.getActiveSpreadsheet().getSheets().forEach(function (sh) {
    if (skipTab_(sh)) return;
    var info = inspect_(sh);
    if (info) out.push(info);
  });
  return out;
}

function findCol_(head, re) {
  for (var i = 0; i < head.length; i++) if (re.test(head[i])) return i;
  return -1;
}

// dates are sent as dd/MM/yyyy [HH:mm:ss] in India time, whatever the sheet's own locale is
function cell_(v) {
  if (v instanceof Date) {
    var midnight = Utilities.formatDate(v, TIME_ZONE, "HH:mm:ss") === "00:00:00";
    return Utilities.formatDate(v, TIME_ZONE, midnight ? "dd/MM/yyyy" : "dd/MM/yyyy HH:mm:ss");
  }
  return v === null || v === undefined ? "" : String(v);
}

/* ------------------------------------------------------------------- read */

// One combined table for the website: a fixed header + every lead row of every lead tab,
// re-ordered by header name so tabs may have their columns in a different order.
function readRows_() {
  var out = [COLUMNS.map(function (c) { return c[0]; })];
  leadTabs_().forEach(function (t) {
    var sh = t.sheet, last = sh.getLastRow();
    if (last <= t.hi + 1) return;
    var idx = COLUMNS.map(function (c) { return findCol_(t.head, c[1]); });
    var vals = sh.getRange(t.hi + 2, 1, last - t.hi - 1, sh.getLastColumn()).getValues();
    vals.forEach(function (r) {
      if (String(r[idx[3]]).trim() === "") return;                 // no phone = not a lead row
      out.push(idx.map(function (i) { return i < 0 ? "" : cell_(r[i]); }));
    });
  });
  return out;
}

/* ------------------------------------------------------------- write-back */

function last10_(v) { return String(v || "").replace(/\D/g, "").slice(-10); }

function writeBack_(updates) {
  var wanted = {};
  updates.forEach(function (u) { var p = last10_(u.phone); if (p) wanted[p] = u; });
  var found = {};

  leadTabs_().forEach(function (t) {
    var sh = t.sheet, last = sh.getLastRow(), head = t.head.slice();
    if (last <= t.hi + 1) return;
    var n = last - t.hi - 1, phoneCol = findCol_(head, /phone/);
    var phones = sh.getRange(t.hi + 2, phoneCol + 1, n, 1).getValues();

    // every row of this tab that holds one of the wanted numbers
    var rowsOf = {}, any = false;
    for (var i = 0; i < n; i++) {
      var p = last10_(phones[i][0]);
      if (p && wanted[p]) { (rowsOf[p] = rowsOf[p] || []).push(i); found[p] = true; any = true; }
    }
    if (!any) return;

    WEBSITE_COLUMNS.forEach(function (name) {
      var key = name.toLowerCase(), c = head.indexOf(key);
      if (c < 0) {                                                  // this tab has no such column yet: add it
        c = head.length; head.push(key);
        if (c + 1 > sh.getMaxColumns()) sh.insertColumnAfter(sh.getMaxColumns());
        sh.getRange(t.hi + 1, c + 1).setValue(name).setFontWeight("bold");
      }
      var range = sh.getRange(t.hi + 2, c + 1, n, 1), vals = range.getValues(), changed = false;
      Object.keys(rowsOf).forEach(function (p) {
        var v = wanted[p][key];
        if (v === undefined || v === null || String(v) === "") return;   // never blank out a cell
        rowsOf[p].forEach(function (ri) { if (String(vals[ri][0]) !== String(v)) { vals[ri][0] = v; changed = true; } });
      });
      if (changed) range.setValues(vals);
    });

    // Call Status ("Connected") and Msg Sent ("Sent 15/11/2026 18:30") — only into columns this tab has, and only into EMPTY cells,
    // so nothing a person typed is ever overwritten. (A script write never fires the Pabbly trigger; Msg Sent also stops it.)
    [["callStatus", /call.*status/], ["msgSent", /msg.*sent/]].forEach(function (x) {
      var c = findCol_(head, x[1]);
      if (c < 0) return;
      var range = sh.getRange(t.hi + 2, c + 1, n, 1), vals = range.getValues(), changed = false;
      Object.keys(rowsOf).forEach(function (p) {
        var v = wanted[p][x[0]];
        if (!v) return;
        rowsOf[p].forEach(function (ri) { if (String(vals[ri][0]).trim() === "") { vals[ri][0] = v; changed = true; } });
      });
      if (changed) range.setValues(vals);
    });
  });

  SpreadsheetApp.flush();
  var missing = Object.keys(wanted).filter(function (p) { return !found[p]; });
  return { updated: Object.keys(found).length, missing: missing };
}

/* ------------------------------------------------------ one-time set-up */

var PROTECT_NOTE = "Filled by the website";

function prepareTab_(info) {
  var sh = info.sheet, hi = info.hi, head = info.head.slice();

  // make sure Workshop Name / WhatsApp Link / Level / Profession / City exist
  TYPED_COLUMNS.concat(WEBSITE_COLUMNS).forEach(function (name) {
    if (!head.some(function (h) { return h.indexOf(name.toLowerCase().split(" ")[0]) === 0 || h === name.toLowerCase(); })) {
      var c = head.length; head.push(name.toLowerCase());
      if (c + 1 > sh.getMaxColumns()) sh.insertColumnAfter(sh.getMaxColumns());
      sh.getRange(hi + 1, c + 1).setValue(name);
    }
  });

  // make sure the Pabbly column (Msg Sent) exists
  AUTOMATION_COLUMNS.forEach(function (name) {
    if (head.indexOf(name.toLowerCase()) < 0) {
      var c = head.length; head.push(name.toLowerCase());
      if (c + 1 > sh.getMaxColumns()) sh.insertColumnAfter(sh.getMaxColumns());
      sh.getRange(hi + 1, c + 1).setValue(name);
    }
  });

  sh.getRange(hi + 1, 1, 1, head.length).setFontWeight("bold");
  if (hi === 0) sh.setFrozenRows(1);

  sh.getProtections(SpreadsheetApp.ProtectionType.RANGE).forEach(function (p) {   // re-running never stacks duplicates
    if (p.getDescription() === PROTECT_NOTE) p.remove();
  });
  WEBSITE_COLUMNS.forEach(function (name) {                           // grey + warn: these are filled by the website
    var c = head.indexOf(name.toLowerCase()) + 1, rows = Math.max(sh.getMaxRows() - hi, 2);
    sh.getRange(hi + 1, c, rows, 1).setBackground("#eef1f5");
    sh.getRange(hi + 1, c).setNote("Filled in automatically from the website. No need to type here.");
    sh.getRange(hi + 2, c, Math.max(rows - 1, 1), 1).protect().setDescription(PROTECT_NOTE).setWarningOnly(true);
  });
  AUTOMATION_COLUMNS.forEach(function (name) {                        // grey + note: filled by Pabbly
    var c = head.indexOf(name.toLowerCase()) + 1, rows = Math.max(sh.getMaxRows() - hi, 2);
    sh.getRange(hi + 1, c, rows, 1).setBackground("#eef1f5");
    sh.getRange(hi + 1, c).setNote("Filled in automatically by Pabbly after the WhatsApp message is sent. No need to type here.");
  });
}

function setupSheet() {
  var done = [];
  SpreadsheetApp.getActiveSpreadsheet().getSheets().forEach(function (sh) {
    if (skipTab_(sh)) return;
    var info = inspect_(sh);
    if (!info) {
      if (sh.getDataRange().getValues().join("").trim() !== "") return;     // has other content: not a lead tab
      var hdr = COLUMNS.map(function (c) { return c[0]; });                 // empty tab -> write the headers
      sh.getRange(1, 1, 1, hdr.length).setValues([hdr]);
      info = inspect_(sh);
      if (!info) return;
    }
    prepareTab_(info);
    done.push(sh.getName());
  });
  SpreadsheetApp.getUi().alert(done.length
    ? "Done ✅  Set up these tabs: " + done.join(", ") + "\n\nNow deploy this script as a Web app (see the steps at the top of the file)."
    : "No lead tab found. A lead tab needs a header row with 'Lead Name' and 'Lead Phone'.");
}

// Shows which tabs the website will read and which are ignored (and why).
function checkTabs() {
  var read = [], skipped = [];
  SpreadsheetApp.getActiveSpreadsheet().getSheets().forEach(function (sh) {
    var name = sh.getName();
    if (name.charAt(0) === "_") return skipped.push(name + "  (starts with _)");
    if (sh.isSheetHidden()) return skipped.push(name + "  (hidden)");
    if (ONLY_TAB !== "" && name !== ONLY_TAB) return skipped.push(name + "  (ONLY_TAB is set)");
    var info = inspect_(sh);
    if (!info) return skipped.push(name + "  (no 'Lead Name' + 'Lead Phone' header row)");
    read.push(name + "  (" + Math.max(sh.getLastRow() - info.hi - 1, 0) + " rows)");
  });
  SpreadsheetApp.getUi().alert("READ by the website:\n" + (read.join("\n") || "none") + "\n\nIGNORED:\n" + (skipped.join("\n") || "none"));
}

/* ----------------------------------------------------------- timestamps */

// Fill the Timestamp of every row in r1..r2 that has a phone but no timestamp yet.
function stampRows_(sh, r1, r2, phoneCol, tsCol) {
  var n = r2 - r1 + 1;
  var phones = sh.getRange(r1, phoneCol, n, 1).getValues();
  var stamps = sh.getRange(r1, tsCol, n, 1);
  var vals = stamps.getValues(), now = new Date(), changed = false;
  for (var i = 0; i < n; i++) {
    if (String(phones[i][0]).trim() !== "" && String(vals[i][0]).trim() === "") { vals[i][0] = now; changed = true; }
  }
  if (changed) stamps.setValues(vals).setNumberFormat("dd/MM/yyyy HH:mm:ss");   // real dates: read correctly in any sheet locale
}

// Simple trigger (runs by itself): when Lead Phone is typed or pasted (one cell or many rows) in any lead tab,
// rows with a phone but an empty Timestamp get the current date and time.
function onEdit(e) {
  try {
    var sh = e.range.getSheet();
    if (skipTab_(sh)) return;
    var info = inspect_(sh);
    if (!info) return;
    var phoneCol = findCol_(info.head, /phone/) + 1, tsCol = findCol_(info.head, /timestamp/) + 1;
    if (!phoneCol || !tsCol) return;
    var c1 = e.range.getColumn(), c2 = c1 + e.range.getNumColumns() - 1;
    if (phoneCol < c1 || phoneCol > c2) return;                       // the edit did not touch the phone column
    var r1 = Math.max(e.range.getRow(), info.hi + 2), r2 = e.range.getRow() + e.range.getNumRows() - 1;
    if (r2 >= r1) stampRows_(sh, r1, r2, phoneCol, tsCol);
  } catch (err) {}
}

// Stamp every lead tab (no pop-up) — used by the instant-sync trigger.
function stampAll_() {
  leadTabs_().forEach(function (t) {
    var last = t.sheet.getLastRow(), phoneCol = findCol_(t.head, /phone/) + 1, tsCol = findCol_(t.head, /timestamp/) + 1;
    if (last >= t.hi + 2 && phoneCol && tsCol) stampRows_(t.sheet, t.hi + 2, last, phoneCol, tsCol);
  });
}

// Run once by hand to stamp rows (in all lead tabs) that were added without a Timestamp.
function fillMissingTimestamps() {
  stampAll_();
  SpreadsheetApp.getUi().alert("Timestamps filled ✅");
}

/* ------------------------------------------------------- instant sync */

// Tell the website "something changed" so it imports right away. Never throws: if the website is asleep or busy,
// its own 1-minute check picks the rows up anyway.
function notifyWebsite_() {
  if (!SYNC_URL || SYNC_URL.indexOf("__") === 0) return "SYNC_URL is not set — use the website's “Copy Apps Script” button again";
  try {
    var res = UrlFetchApp.fetch(SYNC_URL + "?token=" + encodeURIComponent(SECRET_KEY), { method: "post", muteHttpExceptions: true, followRedirects: true });
    var code = res.getResponseCode();
    return code === 200 ? "ok" : "website answered HTTP " + code + ": " + String(res.getContentText()).slice(0, 120);
  } catch (err) { return "could not reach the website: " + err.message; }
}

// Runs by itself (installable trigger) whenever rows are added, pasted, edited or submitted from a form.
function onSheetChange_(e) {
  var lock = LockService.getScriptLock();
  try {
    if (!lock.tryLock(10000)) { notifyWebsite_(); return; }
    try { stampAll_(); } catch (x) {}
    SpreadsheetApp.flush();
  } finally { try { lock.releaseLock(); } catch (y) {} }
  notifyWebsite_();
}

// Run ONCE (and again only if you ever change the website address): installs the "row added" trigger.
function setupInstantSync() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === "onSheetChange_") ScriptApp.deleteTrigger(t);   // re-running never stacks duplicates
  });
  ScriptApp.newTrigger("onSheetChange_").forSpreadsheet(ss).onChange().create();     // typed, pasted, rows added, API / Zapier
  if (ss.getFormUrl()) ScriptApp.newTrigger("onSheetChange_").forSpreadsheet(ss).onFormSubmit().create();   // Google Form responses
  var r = notifyWebsite_();
  SpreadsheetApp.getUi().alert(r === "ok"
    ? "Instant sync is ON ✅\nNew rows now reach the website within seconds."
    : "Triggers installed, but the website did not answer yet:\n" + r + "\n\nCheck the secret key in Settings and that the website is running, then run setupInstantSync again.");
}

// Run by hand to test: pings the website and shows the answer.
function testWebsitePing() {
  SpreadsheetApp.getUi().alert("Website answer: " + notifyWebsite_());
}

/**
 * ADD "Call Status" TO EVERY LEAD TAB
 * ------------------------------------------------------------------
 * Paste this at the END of your existing Apps Script file (below fillMissingTimestamps),
 * Save, then choose  addCallStatus  and press Run.
 *
 * For every lead tab (same tabs the website reads) it:
 *   - adds a "Call Status" header as the LAST column (skips if the tab already has one)
 *   - adds a dropdown (Connected / Not Connected / Busy) for all rows below the header
 *   - tells you if a tab has "Call Status" but it is NOT the last column
 *
 * It uses leadTabs_() and findCol_() from your existing script, so tabs starting with "_",
 * hidden tabs and tabs without Lead Name + Lead Phone headers are skipped.
 */

var CALL_STATUS_HEADER  = "Call Status";
var CALL_STATUS_OPTIONS = ["Connected", "Not Connected", "Busy"];

function addCallStatus() {
  var added = [], already = [], notLast = [];

  leadTabs_().forEach(function (t) {
    var sh = t.sheet, hi = t.hi;
    var headRow = sh.getRange(hi + 1, 1, 1, sh.getLastColumn()).getValues()[0];

    // position of the last non-empty header cell
    var lastHead = 0;
    for (var i = 0; i < headRow.length; i++) {
      if (String(headRow[i]).trim() !== "") lastHead = i + 1;
    }

    var existing = findCol_(headRow.map(function (h) { return String(h).trim().toLowerCase(); }), /call.*status/);
    var col;

    if (existing >= 0) {
      col = existing + 1;
      if (col === lastHead) already.push(sh.getName());
      else notLast.push(sh.getName() + "  (Call Status is in column " + col + ", last column is " + lastHead + ")");
    } else {
      col = lastHead + 1;
      if (col > sh.getMaxColumns()) sh.insertColumnAfter(sh.getMaxColumns());
      sh.getRange(hi + 1, col).setValue(CALL_STATUS_HEADER).setFontWeight("bold");
      added.push(sh.getName());
    }

    // dropdown for every row under the header
    var rows = Math.max(sh.getMaxRows() - hi - 1, 1);
    var rule = SpreadsheetApp.newDataValidation()
      .requireValueInList(CALL_STATUS_OPTIONS, true)
      .setAllowInvalid(false)
      .build();
    sh.getRange(hi + 2, col, rows, 1).setDataValidation(rule);
  });

  SpreadsheetApp.flush();
  SpreadsheetApp.getUi().alert(
    "Call Status\n\n" +
    "ADDED:\n"            + (added.join("\n")   || "none") + "\n\n" +
    "ALREADY THERE:\n"    + (already.join("\n") || "none") + "\n\n" +
    "NOT THE LAST COLUMN (fix by hand):\n" + (notLast.join("\n") || "none")
  );
}
/**
 * SEND ROW TO PABBLY WHEN "Call Status" = Connected   (replaces the Pabbly Google Sheets add-on)
 * ------------------------------------------------------------------
 * Paste this at the END of your existing Apps Script file. Then:
 *   1. Put the Pabbly Webhook URL in PABBLY_URL below (copy it with the copy icon in the Pabbly trigger panel).
 *   2. In Pabbly, open the trigger and click "Capture Webhook Response" (it must say "Waiting...").
 *   3. In Apps Script run  testPabbly  (allow access when asked). A sample row should appear in Pabbly.
 *   4. Run  setupPabblyTrigger  once (allow access). From now on every edit of Call Status sends the row.
 *   5. Turn OFF "Send On Event" in the Pabbly add-on, otherwise Pabbly receives every row twice.
 *
 * It sends the row only when ALL are true:
 *   - the edited cell is in the Call Status column of a lead tab, and its value is "Connected"
 *   - WhatsApp Link is not empty
 *   - Msg Sent is empty
 * After Pabbly accepts the row (HTTP 2xx) it writes "Sent dd/MM/yyyy HH:mm" into Msg Sent,
 * so you do NOT need an "Update Spreadsheet Row" step in Pabbly.
 *
 * Fields sent to Pabbly: every column by its header name (Lead Name, Lead Phone, WhatsApp Link, ...)
 * plus  sheet_name  and  row_number.
 */

var PABBLY_URL = "";   // optional: only if you still use the Pabbly route. Empty = that route is off (the website sends the WhatsApp itself).

function onCallStatusEdit(e) {
  if (!PABBLY_URL) return;
  try {
    var r = e.range, sh = r.getSheet();
    if (skipTab_(sh)) return;
    var info = inspect_(sh);
    if (!info) return;

    var csCol = findCol_(info.head, /call.*status/);
    if (csCol < 0) return;
    if (r.getNumRows() !== 1 || r.getNumColumns() !== 1 || r.getColumn() !== csCol + 1) return;   // only one Call Status cell

    var row = r.getRow();
    if (row <= info.hi + 1) return;                                                                 // header row
    if (String(r.getValue()).trim().toLowerCase() !== "connected") return;

    var lastCol = sh.getLastColumn();
    var headers = sh.getRange(info.hi + 1, 1, 1, lastCol).getValues()[0];
    var vals = sh.getRange(row, 1, 1, lastCol).getValues()[0];

    var linkIdx = findCol_(info.head, /whatsapp.*link/);
    var sentIdx = findCol_(info.head, /msg.*sent/);
    if (linkIdx < 0 || String(vals[linkIdx]).trim() === "") return;                                 // no link: no message
    if (sentIdx >= 0 && String(vals[sentIdx]).trim() !== "") return;                                // already sent

    var payload = { sheet_name: sh.getName(), row_number: row };
    headers.forEach(function (h, i) {
      if (String(h).trim() !== "") payload[String(h).trim()] = cell_(vals[i]);
    });

    var res = UrlFetchApp.fetch(PABBLY_URL, {
      method: "post",
      contentType: "application/json",
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });
    var code = res.getResponseCode();

    if (code >= 200 && code < 300 && sentIdx >= 0) {
      sh.getRange(row, sentIdx + 1).setValue("Sent " + Utilities.formatDate(new Date(), TIME_ZONE, "dd/MM/yyyy HH:mm"));
    } else if (code < 200 || code >= 300) {
      console.error("Pabbly returned " + code + ": " + res.getContentText());
    }
  } catch (err) {
    console.error("onCallStatusEdit: " + err);
  }
}

// Run ONCE: creates the trigger that calls onCallStatusEdit on every edit.
function setupPabblyTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === "onCallStatusEdit") ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger("onCallStatusEdit").forSpreadsheet(SpreadsheetApp.getActiveSpreadsheet()).onEdit().create();
  SpreadsheetApp.getUi().alert("Done ✅  Setting Call Status to Connected now sends the row to Pabbly.");
}

// Sends one sample row so Pabbly can capture the field names. Start "Capture Webhook Response" in Pabbly first.
function testPabbly() {
  if (!PABBLY_URL) { SpreadsheetApp.getUi().alert("PABBLY_URL is empty."); return; }
  var sample = {
    sheet_name: "Sheet1", row_number: 5, "Timestamp": "07/11/2026 10:00:00", "Lead Name": "Test Lead",
    "Lead Email": "test@example.com", "Lead Phone": "9999999999", "UTW Date": "12/11/2026",
    "Assigned To": "Fara", "Workshop Name": "Test Workshop", "WhatsApp Link": "https://chat.whatsapp.com/TEST",
    "Level": "", "Profession": "", "City": "", "Msg Sent": "", "Call Status": "Connected"
  };
  var res = UrlFetchApp.fetch(PABBLY_URL, {
    method: "post", contentType: "application/json", payload: JSON.stringify(sample), muteHttpExceptions: true
  });
  SpreadsheetApp.getUi().alert("Pabbly answered: HTTP " + res.getResponseCode() + "\n\n" + res.getContentText().slice(0, 300));
}