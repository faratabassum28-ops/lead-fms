import crypto from "node:crypto";

// Everything here is pure (no database) so it can be tested on its own.
//
// Razorpay sends one POST per event. We handle the two the account is subscribed to:
//   payment.captured  -> payload.payment.entity
//   payment_link.paid -> payload.payment_link.entity + payload.payment.entity (+ payload.order.entity)
// A payment made through a payment link fires BOTH events for the SAME payment id, so callers must
// treat the payment id as the identity and merge — see utils/paymentService.js.

export const HANDLED_EVENTS = ["payment.captured", "payment_link.paid"];

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

// X-Razorpay-Signature = hex HMAC-SHA256 of the RAW request body, keyed with the webhook secret.
export function verifySignature(rawBody, signature, secret) {
  if (!rawBody || !signature || !secret) return false;
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  return safeEqual(expected, String(signature).trim());
}

// the extra ?secret=… on the webhook URL
export const verifyUrlSecret = (given, expected) => !!expected && !!given && safeEqual(given, expected);

const str = (v) => (typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "");
const pick = (...v) => v.map(str).find(Boolean) || "";
// Razorpay sends notes as {} — or as [] when empty
const obj = (x) => (x && typeof x === "object" && !Array.isArray(x) ? x : {});

// "+91 98765-43210" / "919876543210" / "09876543210"  ->  "9876543210"; other countries keep their full number
export function normPhone(raw) {
  let d = String(raw ?? "").replace(/\D/g, "");
  if (d.startsWith("00")) d = d.slice(2);
  if (d.length === 12 && d.startsWith("91")) return d.slice(2);
  if (d.length === 11 && d.startsWith("0")) return d.slice(1);
  return d.length >= 10 && d.length <= 15 ? d : "";
}

// Razorpay fills this in when the payer left the email blank
const isRealEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && !/@razorpay\.com$/i.test(e);

const nameFromEmail = (e) =>
  e.split("@")[0].replace(/[._\-+0-9]+/g, " ").trim().split(/\s+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");

// Where the payer typed their name differs per Razorpay product (Payment Link / Page / Button / Checkout),
// so look in the usual note keys first, then any key that contains "name" (but is not the workshop's name).
function nameFromNotes(n) {
  const direct = pick(n.name, n.full_name, n.fullname, n.fullName, n.customer_name, n.student_name, n.your_name, n.lead_name);
  if (direct) return direct;
  for (const [k, v] of Object.entries(n)) if (/name/i.test(k) && !/workshop|course|event|product|plan|company/i.test(k) && str(v)) return str(v);
  return "";
}
function workshopFromNotes(n) {
  const direct = pick(n.workshop, n.workshop_name, n.workshopName, n.course, n.event, n.product, n.program);
  if (direct) return direct;
  for (const [k, v] of Object.entries(n)) if (/workshop|course|program/i.test(k) && str(v)) return str(v);
  return "";
}

// Razorpay often puts an id-like string ("#Fk3JkX…", "order_…") in description — not a workshop name
const useful = (d) => { const t = str(d); return t && !/^#|^(pay|order|plink|inv)_/i.test(t) && t.length <= 80 ? t : ""; };

// -> null when the event is not one we act on, else one flat record
export function parseEvent(body) {
  const event = str(body?.event);
  if (!HANDLED_EVENTS.includes(event)) return null;
  const P = body?.payload || {};
  const pay = obj(P.payment?.entity), link = obj(P.payment_link?.entity), order = obj(P.order?.entity);
  const paymentId = pick(pay.id, link.id ? "plink_" + link.id : "");
  if (!paymentId) return null;

  // a payment is real money only when captured (payment.captured) / paid (payment_link.paid)
  const paidish = event === "payment_link.paid" ? str(link.status || "paid") === "paid" : str(pay.status || "captured") === "captured";
  if (!paidish) return null;

  const notes = { ...obj(order.notes), ...obj(link.notes), ...obj(pay.notes) };
  const cust = obj(link.customer);
  let email = pick(pay.email, cust.email, notes.email).toLowerCase();
  if (!isRealEmail(email)) email = "";
  const phone = normPhone(pick(pay.contact, cust.contact, notes.phone, notes.mobile, notes.whatsapp, notes.contact, notes.phone_number));

  let name = pick(nameFromNotes(notes), cust.name), nameGuess = false;
  if (!name) { name = (email && nameFromEmail(email)) || "Razorpay customer"; nameGuess = true; }

  const paise = Number(pay.amount ?? link.amount_paid ?? link.amount ?? 0);
  const sec = Number(pay.created_at ?? body.created_at);
  return {
    event, paymentId,
    orderId: pick(pay.order_id, order.id), linkId: pick(link.id),
    amount: Number.isFinite(paise) ? Math.round(paise) / 100 : 0,
    currency: pick(pay.currency, link.currency) || "INR",
    method: pick(pay.method), status: event === "payment_link.paid" ? "paid" : "captured",
    name, nameGuess, email, phone,
    workshop: pick(workshopFromNotes(notes), useful(link.description), useful(pay.description)),
    description: pick(link.description, pay.description),
    notes,
    paidAt: Number.isFinite(sec) && sec > 0 ? new Date(sec * 1000) : new Date(),
  };
}
