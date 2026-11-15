import express from "express";
import { HANDLED_EVENTS, parseEvent, verifySignature, verifyUrlSecret } from "../utils/razorpay.js";
import { processPayment } from "../utils/paymentService.js";
import { getCfg } from "../utils/leadService.js";
import { syncSoon } from "../utils/sheetSync.js";
import { timingSafeEqual } from "node:crypto";

// PUBLIC (mounted in server.js BEFORE requireAuth) — Razorpay cannot log in, so the request itself is the proof:
//   1. X-Razorpay-Signature  = HMAC-SHA256 of the raw body with RAZORPAY_WEBHOOK_SECRET (the secret typed in the Razorpay dashboard)
//   2. ?secret=…             = INTAKE_SECRET (the extra secret in the webhook URL)
// Whichever of the two environment variables are set must pass. If NEITHER is set the endpoint refuses everything —
// an open webhook would let anyone on the internet create leads.
//
// Razorpay setup: Dashboard → Account & Settings → Webhooks → Add New Webhook
//   URL    https://<your-backend>/api/intake/payment?secret=<INTAKE_SECRET>
//   Secret <RAZORPAY_WEBHOOK_SECRET>
//   Events payment.captured · payment_link.paid
const router = express.Router();

router.get("/payment", (_req, res) => res.json({ ok: true, service: "razorpay-payment-intake" })); // reachability check only

router.post("/payment", async (req, res) => {
  const sigSecret = process.env.RAZORPAY_WEBHOOK_SECRET, urlSecret = process.env.INTAKE_SECRET;
  if (!sigSecret && !urlSecret) {
    console.error("[intake] refused: set RAZORPAY_WEBHOOK_SECRET and/or INTAKE_SECRET on the server");
    return res.status(503).json({ error: "Payment intake is not configured" });
  }
  if (urlSecret && !verifyUrlSecret(String(req.query.secret || ""), urlSecret)) return res.status(401).json({ error: "Bad secret" });
  if (sigSecret && !verifySignature(req.rawBody, req.get("x-razorpay-signature"), sigSecret)) return res.status(401).json({ error: "Bad signature" });

  const event = req.body?.event;
  if (!HANDLED_EVENTS.includes(event)) return res.json({ ok: true, ignored: event || "unknown" }); // 200 so Razorpay does not keep retrying
  const parsed = parseEvent(req.body);
  if (!parsed) return res.json({ ok: true, ignored: "not a captured payment" });

  try {
    const r = await processPayment(parsed);
    console.log(`[intake] ${event} ${r.paymentId} -> ${r.outcome}${r.lead ? " (" + r.lead + ")" : ""}`);
    res.json({ ok: true, ...r });
  } catch (e) {
    // 5xx makes Razorpay retry — safe, because processing is idempotent per payment id
    console.error(`[intake] ${event} ${parsed.paymentId} failed:`, e.message);
    res.status(500).json({ error: "Could not save the payment" });
  }
});

// The Google Sheet pings this the moment a row is added or changed (installed by `setupInstantSync` in the Apps Script),
// so a new lead shows up on the website within seconds instead of waiting for the next 1-minute check.
// Proof = the sheet's secret key (the same one the script already uses), sent as ?token=…  It only ever starts an import
// of the sheet the website is already connected to — it carries no data, so there is nothing to forge or inject.
const same = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && timingSafeEqual(x, y); };
const sheetPing = async (req, res) => {
  try {
    const cfg = await getCfg(), token = String(req.query.token || req.body?.token || "");
    if (!cfg.sheetToken) return res.status(503).json({ error: "Sheet is not connected on the website yet" });
    if (!token || !same(token, cfg.sheetToken)) return res.status(401).json({ error: "Bad token" });
    syncSoon();
    res.json({ ok: true, queued: true });
  } catch (e) { res.status(500).json({ error: "Could not start the import" }); }
};
router.get("/sheet", sheetPing);
router.post("/sheet", sheetPing);

export default router;
