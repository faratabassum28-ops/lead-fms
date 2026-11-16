/**
 * New Order FMS  ->  Lead FMS   (bookings connector)
 * ------------------------------------------------------------------
 * Paste this into the "New Order FMS" Google Sheet (Extensions -> Apps Script). Every NEW booking in the tab below
 * is picked up by the website within a minute and becomes a PAID lead that starts in FU1, due now.
 * Bookings that were already in the sheet when you connected are ignored (history).
 *
 * SETUP (once, ~2 minutes)
 *  1. Extensions -> Apps Script. Delete what is there and paste this whole file. Press Save.
 *  2. Choose the function  checkBookingTab  and press Run (allow access when asked). It shows the columns it found.
 *  3. Run  setupBookingSync  once (allow access again): new rows are then pushed to the website within seconds.
 *  4. Deploy -> New deployment -> type "Web app".   Execute as: Me    Who has access: Anyone
 *     Press Deploy and copy the "Web app URL".
 *  5. In the website:  Settings -> New bookings -> paste that URL -> Save -> Test connection.
 *
 * If you change this file later: Deploy -> Manage deployments -> edit -> New version.
 */

var SECRET_KEY = "__SECRET_KEY__";   // filled in for you by the website's "Copy booking script" button
var SYNC_URL   = "__SYNC_URL__";     // the website's address for "a booking just arrived" (also filled in)
var TAB_NAME   = "All New Booking";  // the tab that holds the bookings (type its name exactly)
var TIME_ZONE  = "Asia/Kolkata";

// [name sent to the website, how to recognise the header]
var COLUMNS = [
  ["Timestamp", /timestamp|date|time/], ["Name", /name/], ["Email", /email/], ["Phone", /phone|mobile|whatsapp/],
  ["Program", /program|workshop|course/], ["Amount", /amount|price/], ["Paid Through", /paid.*through|through|method|mode/]
];

/* ---------------------------------------------------------------- web app */

function doGet(e) {
  try {
    check_(e.parameter.token);
    var out = readBookings_(e.parameter.since ? Number(e.parameter.since) : 0);
    return json_({ ok: true, tab: TAB_NAME, rows: out });
  } catch (err) {
    return json_({ ok: false, error: String(err.message || err) });
  }
}

function check_(token) {
  if (!SECRET_KEY || SECRET_KEY.indexOf("__") === 0) throw new Error("Secret key not set in the script");
  if (token !== SECRET_KEY) throw new Error("Wrong secret key");
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

/* ------------------------------------------------------------------- read */

function tab_() {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(TAB_NAME);
  if (!sh) throw new Error('Tab "' + TAB_NAME + '" not found — fix TAB_NAME at the top of the script');
  return sh;
}

// the header may be on row 1..5: the first row that has both a "phone" and a "name" cell
function header_(sh) {
  var rows = Math.min(sh.getLastRow(), 5), cols = sh.getLastColumn();
  var top = sh.getRange(1, 1, rows, cols).getValues();
  for (var i = 0; i < top.length; i++) {
    var head = top[i].map(function (h) { return String(h).trim().toLowerCase(); });
    if (head.some(function (h) { return /phone|mobile/.test(h); }) && head.some(function (h) { return /name/.test(h); })) return { hi: i, head: head };
  }
  throw new Error('No header row with "Name" and "Phone" in the first 5 rows of "' + TAB_NAME + '"');
}

// a timestamp cell as milliseconds: a real date, or text like "05/10/2024 11:00:00" (India time)
function ms_(t) {
  if (t instanceof Date) return t.getTime();
  var m = String(t).trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ ,]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  return m ? Date.UTC(+m[3], +m[2] - 1, +m[1], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)) - 330 * 60000 : NaN;
}

function findCol_(head, re) { for (var i = 0; i < head.length; i++) if (re.test(head[i])) return i; return -1; }

// dates are sent as dd/MM/yyyy HH:mm:ss in India time, whatever the sheet's own locale is
function cell_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, TIME_ZONE, "dd/MM/yyyy HH:mm:ss");
  return v === null || v === undefined ? "" : String(v);
}

// header + the bookings made since `sinceMs` (0 = all). Rows are only read from the bottom up and stop once they are older,
// so a sheet with thousands of old orders stays fast.
function readBookings_(sinceMs) {
  var sh = tab_(), h = header_(sh), last = sh.getLastRow();
  // take each header once, in the order of the COLUMNS list (so "Name" can never be the "Email" column, etc.)
  var used = {};
  var idx = COLUMNS.map(function (c, k) {
    for (var i = 0; i < h.head.length; i++) if (!used[i] && c[1].test(h.head[i]) && (k !== 1 || !/user|email/.test(h.head[i]))) { used[i] = true; return i; }
    return -1;
  });
  var out = [COLUMNS.map(function (c) { return c[0]; })];
  if (last <= h.hi + 1) return out;
  var vals = sh.getRange(h.hi + 2, 1, last - h.hi - 1, sh.getLastColumn()).getValues();
  var collected = [];
  for (var r = vals.length - 1; r >= 0; r--) {
    var row = vals[r], phone = idx[3] < 0 ? "" : String(row[idx[3]]).replace(/\D/g, "");
    if (phone.length < 10) continue;
    var t = idx[0] < 0 ? null : row[idx[0]];
    var tm = ms_(t);
    if (sinceMs && !isNaN(tm) && tm < sinceMs) continue;   // older booking: skip (not "break": the sheet may not be sorted)
    collected.push(idx.map(function (i) { return i < 0 ? "" : cell_(row[i]); }));
  }
  collected.reverse();
  return out.concat(collected);
}

/* ------------------------------------------------------- one-time set-up */

// Shows which tab and columns the website will read.
function checkBookingTab() {
  var msg;
  try {
    var sh = tab_(), h = header_(sh);
    var found = COLUMNS.map(function (c) {
      var i = findCol_(h.head, c[1]);
      return c[0] + " -> " + (i < 0 ? "NOT FOUND" : '"' + String(sh.getRange(h.hi + 1, i + 1).getValue()) + '" (column ' + (i + 1) + ")");
    });
    msg = 'Tab "' + TAB_NAME + '" — ' + Math.max(sh.getLastRow() - h.hi - 1, 0) + " rows\n\n" + found.join("\n");
  } catch (err) { msg = "Problem: " + err.message; }
  SpreadsheetApp.getUi().alert(msg);
}

/* ------------------------------------------------------- instant sync */

// Tell the website "a booking may have arrived". Never throws: its own 1-minute check is the safety net.
function notifyWebsite_() {
  if (!SYNC_URL || SYNC_URL.indexOf("__") === 0) return "SYNC_URL is not set — use the website's “Copy booking script” button again";
  try {
    var res = UrlFetchApp.fetch(SYNC_URL + "?token=" + encodeURIComponent(SECRET_KEY), { method: "post", muteHttpExceptions: true, followRedirects: true });
    var code = res.getResponseCode();
    return code === 200 ? "ok" : "website answered HTTP " + code + ": " + String(res.getContentText()).slice(0, 120);
  } catch (err) { return "could not reach the website: " + err.message; }
}

function onBookingChange_(e) { notifyWebsite_(); }

// Run ONCE: installs the "row added" trigger.
function setupBookingSync() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === "onBookingChange_") ScriptApp.deleteTrigger(t);   // re-running never stacks duplicates
  });
  ScriptApp.newTrigger("onBookingChange_").forSpreadsheet(ss).onChange().create();
  if (ss.getFormUrl()) ScriptApp.newTrigger("onBookingChange_").forSpreadsheet(ss).onFormSubmit().create();
  var r = notifyWebsite_();
  SpreadsheetApp.getUi().alert(r === "ok"
    ? "Booking sync is ON ✅\nNew bookings now reach the website within seconds (and it also checks every minute)."
    : "Trigger installed, but the website did not answer yet:\n" + r + "\n\nThe website still checks every minute by itself. Check the secret key in Settings, then run setupBookingSync again.");
}

function testWebsitePing() {
  SpreadsheetApp.getUi().alert("Website answer: " + notifyWebsite_());
}
