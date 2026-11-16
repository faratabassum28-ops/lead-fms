import http from "node:http";
import assert from "node:assert/strict";
// Flow test (needs a throw-away MongoDB):  FLOW_TEST_MONGO_URI=mongodb://127.0.0.1:27017/lead_flow_test npm run test:flow
// It DROPS that database, so it refuses to run unless the name ends in "_test" or "_e2e".
import { fileURLToPath } from "node:url";
const B = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const URI = process.env.FLOW_TEST_MONGO_URI;
if (!URI || !/(_test|_e2e)(\?|$)/.test(URI)) { console.error("Set FLOW_TEST_MONGO_URI to a throw-away database whose name ends in _test"); process.exit(1); }
const open = (h) => new Promise((r) => { const s = http.createServer(h); s.listen(0, "127.0.0.1", () => r(s)); });

// ---- fake Google sheet (Apps Script web app) ----
const dmy = (d) => { const p = (n) => String(n).padStart(2, "0"); const l = new Date(d.getTime() + 330 * 6e4); return `${p(l.getUTCDate())}/${p(l.getUTCMonth() + 1)}/${l.getUTCFullYear()} ${p(l.getUTCHours())}:${p(l.getUTCMinutes())}:${p(l.getUTCSeconds())}`; };
// the real sheet has "Workshop Start Date" BEFORE "Workshop Name", plus WhatsApp Link / Msg Sent / Call Status (the script maps them to fixed names)
const HEAD = ["Timestamp", "Lead Name", "Lead Email", "Lead Phone", "UTW Date", "Assigned To", "Workshop Name", "Level", "Profession", "City", "WhatsApp Link", "Msg Sent", "Call Status"];
let rows = [HEAD];
const posts = [];
const sheet = await open((req, res) => { res.setHeader("content-type", "application/json");
  if (req.method === "POST") { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { const j = JSON.parse(b); posts.push(j); res.end(JSON.stringify({ ok: true, updated: (j.updates || []).length, missing: [] })); }); return; }
  res.end(JSON.stringify({ ok: true, rows })); });

// ---- fake AiSensy ----
// ---- fake booking sheet (the New Order FMS Apps Script) ----
const BH = ["Timestamp", "Name", "Email", "Phone", "Program", "Amount", "Paid Through"];
let brows = [BH], bmode = "ok"; const bseen = [];
const bsheet = await open((req, res) => { bseen.push(req.url); res.setHeader("content-type", "application/json"); res.end(JSON.stringify(bmode === "ok" ? { ok: true, tab: "All New Booking", rows: brows } : { ok: false, error: "Wrong secret key" })); });
const sent = []; let mode = "ok";
const ai = await open((req, res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
  const j = JSON.parse(b); sent.push(j);
  if (mode === "500") { res.statusCode = 500; return res.end("boom"); }
  if (mode === "false") { res.statusCode = 200; return res.end('{"success":"false","message":"Campaign not live"}'); }
  res.statusCode = 200; res.end('{"success":"true","submitted_message_id":"x"}');
}); });
process.env.AISENSY_ENDPOINT = `http://127.0.0.1:${ai.address().port}/api`;
process.env.AISENSY_API_KEY = "KEY";
process.env.MONGO_URI = URI;

const mongoose = (await import(B + "/node_modules/mongoose/index.js")).default;
await mongoose.connect(process.env.MONGO_URI); await mongoose.connection.dropDatabase();
const S = await import(B + "/utils/leadService.js"), W = await import(B + "/utils/waService.js"), SS = await import(B + "/utils/sheetSync.js");
const { Lead, WaMessage } = await import(B + "/models/Lead.js");
const express = (await import(B + "/node_modules/express/index.js")).default;
const intake = (await import(B + "/routes/intake.js")).default;

let n = 0; const t = async (name, fn) => { try { await fn(); n++; console.log("  ✓", name); } catch (e) { console.log("  ✗", name, "\n    ", e.message); process.exitCode = 1; } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const cfg0 = await S.getCfg();
await S.setCfg({ ...cfg0, sheetUrl: `http://127.0.0.1:${sheet.address().port}/exec`, sheetToken: "TOK123",
  aisensy: { enabled: true, trigger: "status", campaignName: "welcome_live", triggerStatus: "Connected", startText: "Sat 15 Nov 7 PM", communityLink: "https://zoom.us/j/1", onlyPaid: false } });

const now = new Date(), old = new Date(Date.now() - 30 * 864e5);
rows.push([dmy(new Date(now - 5 * 6e4)), "priya sharma", "priya@x.com", "9876543210", "", "Dolly", "Delhi Workshop", "", "", ""]);
rows.push([dmy(old), "old lead", "old@x.com", "9123456780", "", "Dolly", "Delhi Workshop", "", "", ""]);
rows.push(["", "no stamp", "", "9000000001", "", "", "", "", "", ""]);   // blank Timestamp and blank Assigned To

console.log("Sheet -> FMS (FU1)");
let r;
await t("import creates 3 leads", async () => { r = await SS.runSync(); assert.equal(r.added, 3); assert.equal(await Lead.countDocuments(), 3); });
await t("new lead: FU1 is due NOW (not 16:00 / not Monday)", async () => { const l = await Lead.findOne({ phone10: "9876543210" }); const d = Math.abs(l.fus[0].planned - Date.now()); assert.ok(d < 30_000, "FU1 planned " + l.fus[0].planned); assert.ok(l.fus[1].planned > l.fus[0].planned); assert.equal(l.fus.length, 3); assert.equal(l.assignedTo, "Dolly"); });
await t("row with blank timestamp also lands in FU1", async () => { const l = await Lead.findOne({ phone10: "9000000001" }); assert.ok(Math.abs(l.fus[0].planned - Date.now()) < 30_000); });
await t("30-day-old history row keeps its old plan (does not flood FU1)", async () => { const l = await Lead.findOne({ phone10: "9123456780" }); assert.ok(l.fus[0].planned < old.getTime() + 2 * 864e5); });
await t("re-import never duplicates", async () => { r = await SS.runSync(); assert.equal(r.added, 0); assert.equal(await Lead.countDocuments(), 3); });
await t("one bad row does not stop the others", async () => {
  await Lead.updateOne({ phone10: "9876543210" }, { $set: { key: "ZZ" } }); // simulate a key clash on a later row
  rows.push([dmy(new Date()), "A", "", "9111111111", "", "Dolly", "", "", "", ""]); rows.push([dmy(new Date()), "B", "", "9222222222", "", "Dolly", "", "", "", ""]);
  r = await SS.runSync(); assert.equal(r.added, 2); await Lead.updateOne({ phone10: "9876543210" }, { $set: { key: "9876543210" } });
});

console.log("Instant ping from the sheet");
const app = express(); app.use(express.json()); app.use("/api/intake", intake);
const api = await open(app); const U = `http://127.0.0.1:${api.address().port}/api/intake/sheet`;
await t("wrong token refused", async () => assert.equal((await fetch(U + "?token=nope", { method: "POST" })).status, 401));
await t("no token refused", async () => assert.equal((await fetch(U, { method: "POST" })).status, 401));
await t("right token starts an import; the new row appears in seconds", async () => {
  rows.push([dmy(new Date()), "Instant", "", "9333333333", "", "Dolly", "", "", "", ""]);
  const res = await fetch(U + "?token=TOK123", { method: "POST" }); assert.equal(res.status, 200);
  for (let i = 0; i < 40 && !(await Lead.findOne({ phone10: "9333333333" })); i++) await wait(250);
  const l = await Lead.findOne({ phone10: "9333333333" }); assert.ok(l); assert.ok(Math.abs(l.fus[0].planned - Date.now()) < 30_000);
});
await t("50 pings at once -> still no duplicates, no crash", async () => {
  for (let i = 0; i < 5; i++) rows.push([dmy(new Date()), "Bulk" + i, "", "98000000" + String(10 + i), "", "Dolly", "", "", "", ""]);
  await Promise.all(Array.from({ length: 50 }, () => fetch(U + "?token=TOK123", { method: "POST" })));
  await wait(2500); assert.equal(await Lead.countDocuments({ name: /^Bulk/ }), 5);
});

console.log("AiSensy (trigger = a call saved as Connected)");
const lead = await Lead.findOne({ phone10: "9876543210" });
await t("arrival did NOT message anyone in 'status' mode", async () => { await wait(500); assert.equal(sent.length, 0); });
await t("Connected -> exactly one request with 4 params, +91 number", async () => {
  await W.triggerWelcome(lead._id, { callerName: "Dolly", by: "Dolly" });
  assert.equal(sent.length, 1); const b = sent[0];
  assert.deepEqual(b.templateParams, ["Priya", "Dolly", "Sat 15 Nov 7 PM", "https://zoom.us/j/1"]); assert.equal(b.destination, "+919876543210"); assert.equal(b.campaignName, "welcome_live"); assert.equal(b.apiKey, "KEY");
  assert.ok((await Lead.findById(lead._id)).waWelcomeAt); assert.ok(!(await Lead.findById(lead._id)).waPendingAt);
});
await t("second Connected save never sends twice", async () => { const x = await W.triggerWelcome(lead._id, { callerName: "Dolly" }); assert.equal(x.status, "skipped"); assert.equal(sent.length, 1); });
const l2 = await Lead.findOne({ phone10: "9111111111" });
await t("AiSensy down (500) -> failed, logged, kept pending", async () => {
  mode = "500"; const x = await W.triggerWelcome(l2._id, { callerName: "Dolly" }); assert.equal(x.status, "failed");
  const d = await Lead.findById(l2._id); assert.ok(!d.waWelcomeAt); assert.ok(d.waPendingAt); assert.equal(d.waTries, 1);
  assert.equal(await WaMessage.countDocuments({ status: "failed" }), 1);
});
await t("background retry waits (backoff), then delivers once AiSensy is back", async () => {
  mode = "ok"; const before = sent.length; let rr = await W.retryPending(); assert.equal(rr.retried, 0); assert.equal(sent.length, before);
  await Lead.updateOne({ _id: l2._id }, { $set: { waTriedAt: new Date(Date.now() - 3 * 60_000) } });
  rr = await W.retryPending(); assert.equal(rr.retried, 1); assert.equal(sent.length, before + 1);
  const d = await Lead.findById(l2._id); assert.ok(d.waWelcomeAt); assert.ok(!d.waPendingAt);
  rr = await W.retryPending(); assert.equal(rr.retried, 0);
});
const l3 = await Lead.findOne({ phone10: "9222222222" });
await t("HTTP 200 with {success:false} counts as FAILED (not silently 'sent')", async () => {
  mode = "false"; const x = await W.triggerWelcome(l3._id, { callerName: "Dolly" }); assert.equal(x.status, "failed"); assert.match(x.reason, /not live/); assert.ok(!(await Lead.findById(l3._id)).waWelcomeAt); mode = "ok";
});
await t("gives up after 5 failures (no endless retries)", async () => {
  mode = "500"; await Lead.updateOne({ _id: l3._id }, { $set: { waTries: 4, waTriedAt: new Date(Date.now() - 3600_000) } });
  await W.retryPending(); assert.equal((await Lead.findById(l3._id)).waTries, 5); const c = sent.length;
  await Lead.updateOne({ _id: l3._id }, { $set: { waTriedAt: new Date(Date.now() - 3600_000) } }); const rr = await W.retryPending(); assert.equal(rr.retried, 0); assert.equal(sent.length, c); mode = "ok";
});
await t("incomplete settings -> skipped + logged once, sent later when fixed", async () => {
  const c = await S.getCfg(); await S.setCfg({ ...c, aisensy: { ...c.aisensy, communityLink: "" } });
  const l4 = await Lead.findOne({ phone10: "9333333333" }); const b4 = sent.length;
  const x = await W.triggerWelcome(l4._id, { callerName: "Dolly" }); assert.equal(x.status, "skipped"); assert.equal(sent.length, b4);
  const logs = await WaMessage.countDocuments({ status: "skipped" }); await W.retryPending(); await W.retryPending(); assert.equal(await WaMessage.countDocuments({ status: "skipped" }), logs, "retries must not spam the log");
  await S.setCfg({ ...(await S.getCfg()), aisensy: { ...c.aisensy } }); const rr = await W.retryPending(); assert.equal(rr.retried >= 1, true); assert.ok((await Lead.findById(l4._id)).waWelcomeAt);
});
await t("readiness checklist", async () => { const c = await S.getCfg(); assert.deepEqual(W.problems(c), []); assert.ok(W.problems({ ...c, aisensy: { ...c.aisensy, campaignName: "" } }).length >= 1); });

console.log("AiSensy (trigger = a new lead arrives)");
await S.setCfg({ ...(await S.getCfg()), aisensy: { ...(await S.getCfg()).aisensy, trigger: "arrival" } });
await t("new sheet lead is messaged automatically within the run; old history row is NOT", async () => {
  const b = sent.length;
  rows.push([dmy(new Date()), "arrive me", "", "9444444444", "", "Meera", "", "", "", ""]);
  rows.push([dmy(new Date(Date.now() - 20 * 864e5)), "history", "", "9555555555", "", "Meera", "", "", "", ""]);
  await SS.runSync(); await wait(1500);
  const got = sent.slice(b); assert.equal(got.length, 1); assert.equal(got[0].destination, "+919444444444"); assert.equal(got[0].templateParams[1], "Meera");
});
await t("Connected save does not double-send in arrival mode", async () => { const b = sent.length; const l5 = await Lead.findOne({ phone10: "9444444444" }); const x = await W.triggerWelcome(l5._id, { callerName: "Meera" }); assert.equal(x.status, "skipped"); assert.equal(sent.length, b); });

console.log("Same person, new sheet row (re-enquiry) -> FU1 again");
await S.setCfg({ ...(await S.getCfg()), bookingUrl: "", aisensy: { ...(await S.getCfg()).aisensy, enabled: false } });
await t("a NEW row for a phone that is already a lead brings it back to FU1, due now", async () => {
  const ex = await Lead.findOne({ phone10: "9000000001" }); ex.fus.forEach((f) => { f.actual = new Date(); f.status = "Connected"; }); ex.markModified("fus"); ex.waWelcomeAt = new Date(); await ex.save();
  rows.push([dmy(new Date()), "Ravi", "", "9000000001", "", "Dolly", "test workshop", "", "", "", "", "", ""]);
  const r = await SS.runSync(); assert.equal(r.again, 1); assert.equal(r.added, 0);
  const l = await Lead.findOne({ phone10: "9000000001" }); assert.ok(Math.abs(l.fus[0].planned - Date.now()) < 30_000, "FU1 not due now"); assert.ok(!l.fus[0].actual); assert.equal(l.fus.length, 3);
  assert.equal(l.name, "Ravi"); assert.equal(l.workshop, "test workshop"); assert.ok(!l.waWelcomeAt); assert.ok(l.trail.some((x) => /Enquired again/.test(x.text)));
});
await t("re-reading the same row every minute does NOT restart it again", async () => {
  const l1 = await Lead.findOne({ phone10: "9000000001" }); l1.fus[0].actual = new Date(); l1.fus[0].status = "DNP"; l1.markModified("fus"); await l1.save();
  const r = await SS.runSync(); assert.equal(r.again, 0); assert.ok((await Lead.findOne({ phone10: "9000000001" })).fus[0].actual);
});
await t("an old row for an existing lead never restarts it (no flood after deploy)", async () => {
  rows.push([dmy(new Date(Date.now() - 3 * 864e5)), "Old Again", "", "9000000001", "", "Dolly", "", "", "", "", "", "", ""]);
  const r = await SS.runSync(); assert.equal(r.again, 0);
});

console.log("New bookings -> FU1");
const BM = await import(B + "/utils/bookingSync.js");
const brow = (minsAgo, name, phone, prog = "Tarot - Mastery", amt = "11,999", via = "Razorpay", email = "") => [dmy(new Date(Date.now() - minsAgo * 6e4)), name, email, phone, prog, amt, via];
await S.setCfg({ ...(await S.getCfg()), bookingUrl: `http://127.0.0.1:${bsheet.address().port}/exec`, bookingFrom: "", aisensy: { ...(await S.getCfg()).aisensy, enabled: false } });
brows.push(brow(60 * 24 * 400, "Ancient Order", "9000000777")); // history: must never import
await t("first run only ARMS the import — thousands of old orders never flood in", async () => {
  const r = await BM.syncBookings(); assert.equal(r.armed, true); assert.ok((await S.getCfg()).bookingFrom); assert.equal(await Lead.countDocuments({ source: "booking" }), 0);
});
await t("a booking made after connecting becomes a PAID lead in FU1, due now", async () => {
  await S.setCfg({ ...(await S.getCfg()), bookingFrom: new Date(Date.now() - 3600_000).toISOString() });
  brows.push(brow(5, "Rumneek Arora", "9910630650"));
  const r = await BM.syncBookings(); assert.equal(r.added, 1);
  const l = await Lead.findOne({ phone10: "9910630650" }); assert.equal(l.source, "booking"); assert.equal(l.paid, true); assert.equal(l.paidAmount, 11999); assert.equal(l.workshop, "Tarot - Mastery"); assert.equal(l.payMethod, "Razorpay");
  assert.ok(Math.abs(l.fus[0].planned - Date.now()) < 30_000, "FU1 not due now"); assert.equal(l.fus.length, 3);
  assert.equal(await Lead.countDocuments({ phone10: "9000000777" }), 0);
});
await t("the same booking is never applied twice (1-minute re-read)", async () => { const r = await BM.syncBookings(); assert.equal(r.added, 0); assert.equal(await Lead.countDocuments({ phone10: "9910630650" }), 1); assert.equal((await Lead.findOne({ phone10: "9910630650" })).paidAmount, 11999); });
await t("91-prefixed phone, 6000 amount, new person", async () => { brows.push(brow(2, "Hiral Patel", "919769363794", "Tarot - Diploma", "6999")); const r = await BM.syncBookings(); assert.equal(r.added, 1); const l = await Lead.findOne({ phone10: "9769363794" }); assert.equal(l.paidAmount, 6999); assert.equal(l.workshop, "Tarot - Diploma"); });
await t("an existing lead who books is marked Paid and pulled to FU1 (no duplicate)", async () => {
  const ex = await Lead.findOne({ phone10: "9876543210" }); ex.fus[0].planned = new Date(Date.now() + 5 * 864e5); ex.fus[0].actual = undefined; ex.markModified("fus"); await ex.save();
  const n = await Lead.countDocuments(); brows.push(brow(1, "Priya S", "9876543210", "Tarot - Mastery", "6000", "UPI"));
  const r = await BM.syncBookings(); assert.equal(r.matched, 1); assert.equal(r.added, 0); assert.equal(await Lead.countDocuments(), n);
  const l = await Lead.findOne({ phone10: "9876543210" }); assert.equal(l.paid, true); assert.equal(l.paidAmount, 6000); assert.ok(Math.abs(l.fus[0].planned - Date.now()) < 30_000, "FU1 not pulled to now"); assert.ok(l.trail.some((x) => /Booking received/.test(x.text)));
});
await t("a lead whose FU1 is already done keeps it (only marked Paid)", async () => {
  const ex = await Lead.findOne({ phone10: "9111111111" }); ex.fus[0].actual = new Date(); ex.fus[0].status = "Connected"; ex.markModified("fus"); const planned = +ex.fus[0].planned; await ex.save();
  brows.push(brow(1, "A", "9111111111", "Tarot", "6000")); await BM.syncBookings(); const l = await Lead.findOne({ phone10: "9111111111" }); assert.equal(l.paid, true); assert.equal(+l.fus[0].planned, planned);
});
await t("the script is asked only for recent rows (fast with thousands of old orders)", async () => assert.ok(bseen.some((u) => /since=\d+/.test(u))));
await t("a failing booking sheet is reported, not crashed; the next minute recovers", async () => {
  bmode = "bad"; await assert.rejects(() => BM.syncBookings(), /secret key/); const st = await BM.bookingStatus(); assert.equal(st.ok, false);
  bmode = "ok"; brows.push(brow(0, "After Outage", "9777777777")); const r = await BM.syncBookings(); assert.equal(r.added, 1); assert.equal((await BM.bookingStatus()).ok, true);
});
await t("runSync imports leads AND bookings together; a lead-sheet failure does not block bookings", async () => {
  brows.push(brow(0, "Together", "9888880001")); const c = await S.getCfg(); await S.setCfg({ ...c, sheetUrl: "http://127.0.0.1:1/exec" });
  await assert.rejects(() => SS.runSync()); assert.ok(await Lead.findOne({ phone10: "9888880001" })); await S.setCfg(c);
});

console.log("Real-sheet columns: WhatsApp Link, Msg Sent, write-back");
const row = (name, phone, extra = {}) => { const r = [dmy(new Date()), name, "", phone, "", "Meera", "", "", "", "", "", "", ""]; Object.entries(extra).forEach(([k, v]) => (r[HEAD.indexOf(k)] = v)); return r; };
await S.setCfg({ ...(await S.getCfg()), aisensy: { ...(await S.getCfg()).aisensy, enabled: true, trigger: "arrival", communityLink: "https://default.example/group" } });
await t("a lead's own WhatsApp Link is used as {{4}} (default only as a fallback)", async () => {
  const b = sent.length;
  rows.push(row("Own Link", "9666666661", { "WhatsApp Link": "https://chat.whatsapp.com/OWN1" })); rows.push(row("No Link", "9666666662"));
  await SS.runSync(); await wait(2000);
  const got = sent.slice(b).sort((x, y) => x.destination.localeCompare(y.destination)); assert.equal(got.length, 2);
  assert.equal(got[0].templateParams[3], "https://chat.whatsapp.com/OWN1"); assert.equal(got[1].templateParams[3], "https://default.example/group");
});
await t("Msg Sent already filled (Pabbly sent it) -> the website does NOT send again", async () => {
  const b = sent.length; rows.push(row("Pabbly Done", "9666666663", { "Msg Sent": "Sent 09/11/2026 13:25", "WhatsApp Link": "https://chat.whatsapp.com/X" }));
  await SS.runSync(); await wait(1500); assert.equal(sent.length, b);
  const l = await Lead.findOne({ phone10: "9666666663" }); assert.ok(l.waWelcomeAt); assert.equal(l.waLink, "https://chat.whatsapp.com/X");
});
await t("after sending, Msg Sent + Call Status are written back to the sheet", async () => {
  posts.length = 0; const l = await Lead.findOne({ phone10: "9666666661" }); assert.match(l.msgSent, /^Sent \d\d\/\d\d\/\d{4} \d\d:\d\d$/); assert.equal(l.sheetDirty, true);
  await S.pushDirty(); const u = posts.flatMap((p) => p.updates).find((x) => x.phone === "9666666661"); assert.ok(u, "no write-back sent"); assert.match(u.msgSent, /^Sent /);
});
await t("Workshop Start Date does not become the workshop name; WhatsApp Link is not the name", async () => { const l = await Lead.findOne({ phone10: "9666666661" }); assert.equal(l.workshop || "", ""); assert.equal(l.name, "Own Link"); });

console.log(`\n${n} checks passed`);
process.exit(process.exitCode || 0);
