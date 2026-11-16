import { Lead, LeadBooking, LeadConfig } from "../models/Lead.js";
import * as S from "./leadService.js";
import * as W from "./waService.js";

// "New Order FMS" (the bookings sheet)  ->  Lead FMS.
// Every NEW booking (made after the sheet was connected) becomes a PAID lead that starts in FU1, due now, and is shared
// out by Settings → Automatic assignment. A person who is already a lead is matched by phone (then email), marked Paid and
// pulled to FU1. Each sheet row is applied once (bookingRefs), so the 1-minute re-read never duplicates anything.

const STATUS_ID = "bookingSync";
const saveStatus = (v) => LeadConfig.findByIdAndUpdate(STATUS_ID, { v: { at: new Date(), ...v } }, { upsert: true }).catch(() => {});
export const bookingStatus = async () => (await LeadConfig.findById(STATUS_ID).lean())?.v || null;

const rupees = (n) => "₹" + Number(n || 0).toLocaleString("en-IN", { maximumFractionDigits: 2 });
const money = (v) => { const n = parseFloat(String(v ?? "").replace(/[^\d.]/g, "")); return Number.isFinite(n) ? n : 0; };
const FRESH_MS = 24 * 36e5; // a WhatsApp on arrival is only sent for bookings made in the last 24 h

let running = false, lastErr = "";
export async function syncBookings() {
  if (running) return { busy: true };
  running = true;
  try {
    const cfg = await S.getCfg();
    if (!cfg.bookingUrl || !cfg.sheetToken) return { off: true };
    if (!cfg.bookingFrom) { // first run after connecting: from now on only — the old orders in the sheet are history
      await S.setCfg({ ...cfg, bookingFrom: new Date().toISOString() });
      await saveStatus({ ok: true, armed: true, added: 0, matched: 0 });
      return { armed: true };
    }
    const from = new Date(cfg.bookingFrom), url = cfg.bookingUrl.trim();
    const res = await S.scriptCall({ ...cfg, sheetUrl: `${url}${url.includes("?") ? "&" : "?"}since=${+from - 864e5}` });
    const rows = res.rows || [], H = (rows[0] || []).map((h) => String(h).trim().toLowerCase());
    const col = (re) => H.findIndex((h) => re.test(h));
    const ix = { ts: col(/timestamp/), name: col(/name/), email: col(/email/), phone: col(/phone/), prog: col(/program/), amt: col(/amount/), via: col(/paid.*through|through|method/) };
    if (ix.phone < 0) throw new Error("The booking script did not return a Phone column");
    const cell = (r, i) => (i >= 0 ? String(r[i] ?? "").trim() : "");

    const items = rows.slice(1).map((r) => ({ r, digits: cell(r, ix.phone).replace(/\D/g, ""), ts: S.pdate(cell(r, ix.ts)) }))
      .filter((x) => x.digits.length >= 10 && x.ts && x.ts >= from)
      .sort((a, b) => a.ts - b.ts);

    // rows already listed on the "New Bookings" page were fully handled in an earlier minute
    const refOf = (x) => `${+x.ts}:${x.digits.slice(-10)}`;
    const known = new Set((await LeadBooking.find({ ref: { $in: items.map(refOf) } }).select("ref").lean()).map((b) => b.ref));
    const A = await S.assigner("new", cfg);
    let added = 0, matched = 0, skipped = 0;
    const created = [];
    for (const { r, digits, ts } of items) {
      try {
        const p10 = digits.slice(-10), ref = `${+ts}:${p10}`;
        if (known.has(ref)) { skipped++; continue; }
        const email = cell(r, ix.email), name = cell(r, ix.name) || "Booking", amount = money(cell(r, ix.amt));
        const ws = S.cleanWorkshop(cell(r, ix.prog)), via = cell(r, ix.via), now = new Date();
        const what = `${rupees(amount)}${ws ? " · " + ws : ""}${via ? " · via " + via : ""}`;
        const list = (outcome, lead) => LeadBooking.updateOne({ ref }, { $setOnInsert: { ts, name, email, phone: digits, program: ws, amount, via, leadKey: lead.key, outcome } }, { upsert: true });
        let lead = (await S.byPhone(p10)) || (email ? await S.byEmail(email) : null);

        if (lead) {
          if ((lead.bookingRefs || []).includes(ref)) { skipped++; continue; }
          lead.bookingRefs = [...(lead.bookingRefs || []), ref].slice(-20);
          lead.paid = true; lead.paidAt = lead.paidAt && lead.paidAt > ts ? lead.paidAt : ts;
          lead.paidAmount = Math.max(lead.paidAmount || 0, amount); // never double-counts a payment Razorpay already recorded
          lead.payMethod = lead.payMethod || via || undefined;
          if (!lead.workshop && ws) lead.workshop = ws;
          if (!lead.assignedTo) { const o = A.pick(); if (o) { lead.assignedTo = o; lead.assignedBy = "auto"; lead.assignedAt = now; } }
          if (!lead.fus?.length) lead.fus = S.planNew(now, cfg);
          else if (!lead.fus[0].actual) { lead.fus[0].planned = now; lead.markModified("fus"); } // FU1 not done yet -> due now
          S.trail(lead, "payment", `Booking received: ${what}`, "Booking sheet");
          await lead.save();
          await list("matched", lead);
          matched++;
          continue;
        }

        const owner = A.pick();
        const story = [{ at: now, type: "entered", text: `New booking from the order sheet · ${what}`, by: "Booking sheet" }];
        if (owner) story.push({ at: now, type: "assign", text: `Assigned to ${owner} (automatic)`, by: "System" });
        try {
          lead = await Lead.create({
            key: digits, phone: digits, name, email, workshop: ws, ts, source: "booking", paid: true, paidAt: ts, paidAmount: amount, payMethod: via || undefined,
            bookingRefs: [ref], assignedTo: owner, assignedBy: owner ? "auto" : undefined, assignedAt: owner ? now : undefined,
            fus: S.planNew(now, cfg), trail: story,
          });
          await list("created", lead);
          added++; created.push({ id: String(lead._id), owner, ts });
        } catch (e) {
          if (e.code !== 11000) throw e; // the same phone was created a moment ago (the lead sheet): attach to it on the next minute
          skipped++;
        }
      } catch (e) { skipped++; console.error("[booking] row skipped:", e.message); }
    }
    await A.save();
    for (const n of created) if (Date.now() - +n.ts < FRESH_MS) W.arrivalWelcome(n.id, n.owner);
    if (added || matched) S.bustProgress();
    lastErr = "";
    await saveStatus({ ok: true, added, matched, rows: items.length });
    return { added, matched, skipped };
  } catch (e) {
    if (e.message !== lastErr) console.error("[booking] import failed:", e.message); // logged once, not every minute
    lastErr = e.message;
    await saveStatus({ ok: false, error: e.message });
    throw e;
  } finally { running = false; }
}
