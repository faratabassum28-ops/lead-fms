import { Lead, LeadPayment } from "../models/Lead.js";
import * as S from "./leadService.js";

// A captured Razorpay payment becomes (or enriches) a lead:
//   • the payer is matched to an existing lead by phone, then by email  -> the lead is marked Paid
//   • nobody matches                                                    -> a new lead is created, assigned by
//                                                                          Settings → Automatic assignment, with the
//                                                                          normal follow-up plan
//   • no phone and no known email                                       -> the payment is stored as "no-contact"
//                                                                          and shown on the Payments page
// The same payment arrives twice when it was made through a payment link (payment.captured AND payment_link.paid),
// in either order, within milliseconds. So: one row per payment id, the two events are merged, and everything runs
// one at a time so the two deliveries can never create two leads.

let chain = Promise.resolve();
export function processPayment(parsed) {
  const run = chain.then(() => apply(parsed));
  chain = run.catch(() => {});
  return run;
}

const rupees = (n) => "₹" + Number(n || 0).toLocaleString("en-IN", { maximumFractionDigits: 2 });
const blank = (v) =>
  v === undefined || v === null || v === "" || (v instanceof Date ? isNaN(v) : typeof v === "object" && !Array.isArray(v) && !Object.keys(v).length);

async function findLead(p, known) {
  if (known) { const l = await Lead.findOne({ key: known }); if (l) return l; }
  if (p.phone) { const l = await S.byPhone(p.phone.slice(-10)); if (l) return l; }
  if (p.email) { const l = await S.byEmail(p.email); if (l) return l; }
  return null;
}

async function apply(p) {
  // 1. one row per payment — fill what is blank, keep what is known (a later event may carry the real name)
  const doc = (await LeadPayment.findOne({ paymentId: p.paymentId })) || new LeadPayment({ paymentId: p.paymentId, events: [] });
  for (const k of ["orderId", "linkId", "amount", "currency", "method", "status", "email", "phone", "description", "workshop", "paidAt"])
    if (blank(doc[k]) && !blank(p[k])) doc[k] = p[k];
  if (blank(doc.name) || (doc.nameGuess && !p.nameGuess)) { doc.name = p.name; doc.nameGuess = p.nameGuess; }
  if (blank(doc.notes) && !blank(p.notes)) doc.notes = p.notes;
  if (!doc.events.includes(p.event)) doc.events.push(p.event);

  // use the merged view from here on, so a second event never loses what the first one brought
  const m = { ...p, name: doc.name, nameGuess: !!doc.nameGuess, email: doc.email || p.email, phone: doc.phone || p.phone, workshop: doc.workshop || p.workshop, method: doc.method || p.method };

  let lead = await findLead(m, doc.leadKey);
  const cfg = await S.getCfg();
  const ws = S.cleanWorkshop(m.workshop), pay = `${rupees(m.amount)} via Razorpay${m.method ? " (" + m.method + ")" : ""}`;

  if (lead) {
    // --- existing lead: mark it paid, once per payment id ---
    if (!(lead.payIds || []).includes(m.paymentId)) {
      lead.payIds = [...(lead.payIds || []), m.paymentId];
      lead.paidAmount = (lead.paidAmount || 0) + m.amount;
      lead.paid = true; lead.paidAt = lead.paidAt && lead.paidAt > m.paidAt ? lead.paidAt : m.paidAt; lead.payMethod = m.method || lead.payMethod;
      S.trail(lead, "payment", `Payment received: ${pay} · ${m.paymentId}`, "Razorpay");
    }
    if (lead.nameGuess && !m.nameGuess) { S.trail(lead, "details", `Name updated to ${m.name} (from the payment)`, "Razorpay"); lead.name = m.name; lead.nameGuess = false; }
    if (!lead.email && m.email) lead.email = m.email;
    if (!lead.workshop && ws) { lead.workshop = ws; S.trail(lead, "workshop", `Workshop: ${ws} (from the payment)`, "Razorpay"); }
    await lead.save();
    doc.outcome = doc.outcome === "created" ? "created" : "matched";
  } else if (m.phone) {
    // --- nobody matches: a new lead, handled exactly like a sheet / manual lead ---
    const now = new Date(), A = await S.assigner("new", cfg), owner = A.pick();
    const story = [{ at: now, type: "entered", text: `Lead came in from a Razorpay payment${ws ? " · " + ws : ""}`, by: "Razorpay" }];
    if (owner) story.push({ at: now, type: "assign", text: `Assigned to ${owner} (automatic)`, by: "System" });
    story.push({ at: now, type: "payment", text: `Payment received: ${pay} · ${m.paymentId}`, by: "Razorpay" });
    try {
      lead = await Lead.create({
        key: m.phone, phone: m.phone, name: m.name, nameGuess: m.nameGuess, email: m.email, workshop: ws, ts: m.paidAt, source: "razorpay",
        paid: true, paidAt: m.paidAt, paidAmount: m.amount, payIds: [m.paymentId], payMethod: m.method,
        assignedTo: owner, assignedBy: owner ? "auto" : undefined, assignedAt: owner ? now : undefined,
        fus: S.planFor(now, cfg), trail: story,
      });
      await A.save();
      doc.outcome = "created";
    } catch (e) {
      if (e.code !== 11000) throw e;
      // the same phone was created a moment ago (e.g. by the sheet import): attach to that lead instead
      lead = await findLead(m, null);
      if (!lead) throw e;
      lead.payIds = [...(lead.payIds || []), m.paymentId]; lead.paidAmount = (lead.paidAmount || 0) + m.amount; lead.paid = true; lead.paidAt = m.paidAt;
      S.trail(lead, "payment", `Payment received: ${pay} · ${m.paymentId}`, "Razorpay");
      await lead.save();
      doc.outcome = "matched";
    }
  } else {
    doc.outcome = "no-contact"; // paid, but there is no phone number or known email to build a lead from
  }

  if (lead) doc.leadKey = lead.key;
  await doc.save();
  S.bustProgress();
  return { paymentId: m.paymentId, outcome: doc.outcome, lead: lead ? lead.name : null };
}
