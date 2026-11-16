/**
 * New Order FMS  ->  Lead FMS   (bookings connector)
 * ------------------------------------------------------------------
 * Add this to the "New Order FMS" Google Sheet's EXISTING Apps Script project as a NEW FILE (Files "+" -> Script -> name it Bookings).
 * Nothing in your other files is touched: every name here starts with "lfms" / "LFMS_" so it can never clash with your own code. Every NEW booking in the tab below
 * is picked up by the website within a minute and becomes a PAID lead that starts in FU1, due now.
 * Bookings that were already in the sheet when you connected are ignored (history).
 *
 * SETUP (once, ~2 minutes)
 *  1. Extensions -> Apps Script -> Files "+" -> Script, name it Bookings, paste this whole file. Press Save. (Do NOT delete your other files.)
 *     Search your other files for  function doGet  (Ctrl+F): if it exists there, tell me before deploying.
 *  2. Choose the function  checkBookingTab  and press Run (allow access when asked). It shows the columns it found.
 *  3. Run  setupBookingSync  once (allow access again): new rows are then pushed to the website within seconds.
 *  4. Deploy -> New deployment -> type "Web app".   Execute as: Me    Who has access: Anyone
 *     Press Deploy and copy the "Web app URL".
 *  5. In the website:  Settings -> New bookings -> paste that URL -> Save -> Test connection.
 *
 * If you change this file later: Deploy -> Manage deployments -> edit -> New version.
 */

var LFMS_KEY = "__SECRET_KEY__";   // filled in for you by the website's "Copy booking script" button
var LFMS_SYNC_URL   = "__SYNC_URL__";     // the website's address for "a booking just arrived" (also filled in)
var LFMS_TAB   = "All New Booking";  // the tab that holds the bookings (type its name exactly)
var LFMS_TZ  = "Asia/Kolkata";

// [name sent to the website, how to recognise the header]
var LFMS_COLUMNS = [
  ["Timestamp", /timestamp|date|time/], ["Name", /name/], ["Email", /email/], ["Phone", /phone|mobile|whatsapp/],
  ["Program", /program|workshop|course/], ["Amount", /amount|price/], ["Paid Through", /paid.*through|through|method|mode/]
];

/* ---------------------------------------------------------------- web app */

function doGet(e) {
  try {
    lfmsCheck_(e.parameter.token);
    var out = lfmsRead_(e.parameter.since ? Number(e.parameter.since) : 0);
    return lfmsJson_({ ok: true, tab: LFMS_TAB, rows: out });
  } catch (err) {
    return lfmsJson_({ ok: false, error: String(err.message || err) });
  }
}

function lfmsCheck_(token) {
  if (!LFMS_KEY || LFMS_KEY.indexOf("__") === 0) throw new Error("Secret key not set in the script");
  if (token !== LFMS_KEY) throw new Error("Wrong secret key");
}

function lfmsJson_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

/* ------------------------------------------------------------------- read */

function lfmsTab_() {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(LFMS_TAB);
  if (!sh) throw new Error('Tab "' + LFMS_TAB + '" not found — fix LFMS_TAB at the top of the script');
  return sh;
}

// the header may be on row 1..5: the first row that has both a "phone" and a "name" cell
function lfmsHeader_(sh) {
  var rows = Math.min(sh.getLastRow(), 5), cols = sh.getLastColumn();
  var top = sh.getRange(1, 1, rows, cols).getValues();
  for (var i = 0; i < top.length; i++) {
    var head = top[i].map(function (h) { return String(h).trim().toLowerCase(); });
    if (head.some(function (h) { return /phone|mobile/.test(h); }) && head.some(function (h) { return /name/.test(h); })) return { hi: i, head: head };
  }
  throw new Error('No header row with "Name" and "Phone" in the first 5 rows of "' + LFMS_TAB + '"');
}

// a timestamp cell as milliseconds: a real date, or text like "05/10/2024 11:00:00" (India time)
function lfmsMs_(t) {
  if (t instanceof Date) return t.getTime();
  var m = String(t).trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ ,]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  return m ? Date.UTC(+m[3], +m[2] - 1, +m[1], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)) - 330 * 60000 : NaN;
}

function lfmsFindCol_(head, re) { for (var i = 0; i < head.length; i++) if (re.test(head[i])) return i; return -1; }

// dates are sent as dd/MM/yyyy HH:mm:ss in India time, whatever the sheet's own locale is
function lfmsCell_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, LFMS_TZ, "dd/MM/yyyy HH:mm:ss");
  return v === null || v === undefined ? "" : String(v);
}

// header + the bookings made since `sinceMs` (0 = all). Rows are only read from the bottom up and stop once they are older,
// so a sheet with thousands of old orders stays fast.
function lfmsRead_(sinceMs) {
  var sh = lfmsTab_(), h = lfmsHeader_(sh), last = sh.getLastRow();
  // take each header once, in the order of the LFMS_COLUMNS list (so "Name" can never be the "Email" column, etc.)
  var used = {};
  var idx = LFMS_COLUMNS.map(function (c, k) {
    for (var i = 0; i < h.head.length; i++) if (!used[i] && c[1].test(h.head[i]) && (k !== 1 || !/user|email/.test(h.head[i]))) { used[i] = true; return i; }
    return -1;
  });
  var out = [LFMS_COLUMNS.map(function (c) { return c[0]; })];
  if (last <= h.hi + 1) return out;
  var vals = sh.getRange(h.hi + 2, 1, last - h.hi - 1, sh.getLastColumn()).getValues();
  var collected = [];
  for (var r = vals.length - 1; r >= 0; r--) {
    var row = vals[r], phone = idx[3] < 0 ? "" : String(row[idx[3]]).replace(/\D/g, "");
    if (phone.length < 10) continue;
    var t = idx[0] < 0 ? null : row[idx[0]];
    var tm = lfmsMs_(t);
    if (sinceMs && !isNaN(tm) && tm < sinceMs) continue;   // older booking: skip (not "break": the sheet may not be sorted)
    collected.push(idx.map(function (i) { return i < 0 ? "" : lfmsCell_(row[i]); }));
  }
  collected.reverse();
  return out.concat(collected);
}

/* ------------------------------------------------------- one-time set-up */

// Shows which tab and columns the website will read.
function checkBookingTab() {
  var msg;
  try {
    var sh = lfmsTab_(), h = lfmsHeader_(sh);
    var found = LFMS_COLUMNS.map(function (c) {
      var i = lfmsFindCol_(h.head, c[1]);
      return c[0] + " -> " + (i < 0 ? "NOT FOUND" : '"' + String(sh.getRange(h.hi + 1, i + 1).getValue()) + '" (column ' + (i + 1) + ")");
    });
    msg = 'Tab "' + LFMS_TAB + '" — ' + Math.max(sh.getLastRow() - h.hi - 1, 0) + " rows\n\n" + found.join("\n");
  } catch (err) { msg = "Problem: " + err.message; }
  SpreadsheetApp.getUi().alert(msg);
}

/* ------------------------------------------------------- instant sync */

// Tell the website "a booking may have arrived". Never throws: its own 1-minute check is the safety net.
function lfmsNotify_() {
  if (!LFMS_SYNC_URL || LFMS_SYNC_URL.indexOf("__") === 0) return "LFMS_SYNC_URL is not set — use the website's “Copy booking script” button again";
  try {
    var res = UrlFetchApp.fetch(LFMS_SYNC_URL + "?token=" + encodeURIComponent(LFMS_KEY), { method: "post", muteHttpExceptions: true, followRedirects: true });
    var code = res.getResponseCode();
    return code === 200 ? "ok" : "website answered HTTP " + code + ": " + String(res.getContentText()).slice(0, 120);
  } catch (err) { return "could not reach the website: " + err.message; }
}

function lfmsOnChange_(e) { lfmsNotify_(); }

// Run ONCE: installs the "row added" trigger.
function setupBookingSync() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === "lfmsOnChange_") ScriptApp.deleteTrigger(t);   // re-running never stacks duplicates
  });
  ScriptApp.newTrigger("lfmsOnChange_").forSpreadsheet(ss).onChange().create();
  if (ss.getFormUrl()) ScriptApp.newTrigger("lfmsOnChange_").forSpreadsheet(ss).onFormSubmit().create();
  var r = lfmsNotify_();
  SpreadsheetApp.getUi().alert(r === "ok"
    ? "Booking sync is ON ✅\nNew bookings now reach the website within seconds (and it also checks every minute)."
    : "Trigger installed, but the website did not answer yet:\n" + r + "\n\nThe website still checks every minute by itself. Check the secret key in Settings, then run setupBookingSync again.");
}

function testBookingPing() {
  SpreadsheetApp.getUi().alert("Website answer: " + lfmsNotify_());
}
