import assert from "node:assert/strict";
import crypto from "node:crypto";
import { parseEvent, verifySignature, verifyUrlSecret, normPhone } from "../utils/razorpay.js";
import { destinationFor, firstName, welcomeParams, buildBody, postCampaign, ENDPOINT } from "../utils/aisensy.js";

let n = 0; const t = (name, fn) => Promise.resolve(fn()).then(() => { n++; console.log("  ✓", name); }, (e) => { console.log("  ✗", name, "\n   ", e.message); process.exitCode = 1; });

const pay = { id: "pay_Abc123", entity: "payment", amount: 49900, currency: "INR", status: "captured", order_id: "order_X1", method: "upi", email: "priya.sharma@gmail.com", contact: "+919876543210", notes: [], description: "3 Day Ultimate Tarot Workshop", created_at: 1760000000 };
const captured = { entity: "event", event: "payment.captured", created_at: 1760000001, payload: { payment: { entity: pay } } };
const linkPaid = { entity: "event", event: "payment_link.paid", payload: {
  payment_link: { entity: { id: "plink_L9", amount: 49900, amount_paid: 49900, status: "paid", description: "3 Day Ultimate Tarot Workshop", customer: { name: "Priya Sharma", email: "priya.sharma@gmail.com", contact: "+919876543210" }, notes: { workshop: "Tarot Workshop Nov" } } },
  order: { entity: { id: "order_X1", notes: [] } }, payment: { entity: { ...pay, notes: [] } } } };

console.log("Razorpay signature");
const raw = Buffer.from(JSON.stringify(captured)), secret = "s3cret-webhook";
const good = crypto.createHmac("sha256", secret).update(raw).digest("hex");
await t("valid signature accepted", () => assert.equal(verifySignature(raw, good, secret), true));
await t("wrong secret rejected", () => assert.equal(verifySignature(raw, good, "other"), false));
await t("tampered body rejected", () => assert.equal(verifySignature(Buffer.from(raw + " "), good, secret), false));
await t("missing signature rejected", () => assert.equal(verifySignature(raw, undefined, secret), false));
await t("missing secret rejected (never fail-open)", () => assert.equal(verifySignature(raw, good, ""), false));
await t("different-length signature does not throw", () => assert.equal(verifySignature(raw, "abc", secret), false));
await t("url secret match / mismatch / empty", () => { assert.equal(verifyUrlSecret("a1", "a1"), true); assert.equal(verifyUrlSecret("a2", "a1"), false); assert.equal(verifyUrlSecret("", "a1"), false); assert.equal(verifyUrlSecret("a1", ""), false); });

console.log("parseEvent");
await t("payment.captured parsed (paise->rupees, phone, email, workshop, time)", () => {
  const p = parseEvent(captured);
  assert.equal(p.paymentId, "pay_Abc123"); assert.equal(p.amount, 499); assert.equal(p.phone, "9876543210");
  assert.equal(p.email, "priya.sharma@gmail.com"); assert.equal(p.workshop, "3 Day Ultimate Tarot Workshop"); assert.equal(p.method, "upi");
  assert.equal(p.paidAt.getTime(), 1760000000 * 1000);
});
await t("no name in payment.captured -> guessed from email, flagged", () => { const p = parseEvent(captured); assert.equal(p.name, "Priya Sharma"); assert.equal(p.nameGuess, true); });
await t("payment_link.paid has the real name, same payment id, notes.workshop wins", () => {
  const p = parseEvent(linkPaid);
  assert.equal(p.paymentId, "pay_Abc123"); assert.equal(p.name, "Priya Sharma"); assert.equal(p.nameGuess, false); assert.equal(p.workshop, "Tarot Workshop Nov");
});
await t("both events of one payment share the id (so they merge)", () => assert.equal(parseEvent(captured).paymentId, parseEvent(linkPaid).paymentId));
await t("empty notes [] does not crash", () => assert.ok(parseEvent({ ...captured, payload: { payment: { entity: { ...pay, notes: [] } } } })));
await t("void@razorpay.com is not a real email", () => assert.equal(parseEvent({ ...captured, payload: { payment: { entity: { ...pay, email: "void@razorpay.com" } } } }).email, ""));
await t("name from notes (form field 'Full Name')", () => assert.equal(parseEvent({ ...captured, payload: { payment: { entity: { ...pay, notes: { "Full Name": "Anita Rao", workshop_name: "Delhi" } } } } }).name, "Anita Rao"));
await t("'workshop_name' note is not mistaken for the person's name", () => assert.equal(parseEvent({ ...captured, payload: { payment: { entity: { ...pay, email: "", notes: { workshop_name: "Delhi Workshop" } } } } }).name, "Razorpay customer"));
await t("id-like descriptions never become a workshop", () => assert.equal(parseEvent({ ...captured, payload: { payment: { entity: { ...pay, description: "#Fk3JkXYZ" } } } }).workshop, ""));
await t("other events / failed payments ignored", () => { assert.equal(parseEvent({ event: "payment.failed", payload: { payment: { entity: pay } } }), null); assert.equal(parseEvent({ event: "payment.captured", payload: { payment: { entity: { ...pay, status: "failed" } } } }), null); assert.equal(parseEvent({}), null); assert.equal(parseEvent(null), null); });
await t("payment without phone -> empty phone (service stores as no-contact)", () => assert.equal(parseEvent({ ...captured, payload: { payment: { entity: { ...pay, contact: undefined } } } }).phone, ""));
await t("phone normalisation", () => { for (const [i, o] of [["+91 98765-43210", "9876543210"], ["919876543210", "9876543210"], ["09876543210", "9876543210"], ["9876543210", "9876543210"], ["+14155550123", "14155550123"], ["123", ""], [null, ""]]) assert.equal(normPhone(i), o, String(i)); });

console.log("AiSensy");
await t("destination formats", () => { assert.equal(destinationFor("9876543210"), "+919876543210"); assert.equal(destinationFor("919876543210"), "+919876543210"); assert.equal(destinationFor("+91 98765 43210"), "+919876543210"); assert.equal(destinationFor("14155550123"), "+14155550123"); assert.equal(destinationFor(""), ""); });
await t("first name", () => { assert.equal(firstName("priya SHARMA"), "Priya"); assert.equal(firstName(""), "there"); assert.equal(firstName("  anita  rao"), "Anita"); });
await t("exactly 4 template params in the right order", () => assert.deepEqual(welcomeParams({ name: "Priya Sharma", caller: "Dolly", start: "Sat 15 Nov, 7 PM", link: "https://chat.whatsapp.com/x" }), ["Priya", "Dolly", "Sat 15 Nov, 7 PM", "https://chat.whatsapp.com/x"]));
await t("request body matches the AiSensy v2 contract", () => { const b = buildBody({ apiKey: "K", campaignName: "tarot_welcome", phone: "9876543210", name: "Priya Sharma", params: ["a", "b", "c", "d"] }); assert.deepEqual(Object.keys(b).sort(), ["apiKey", "campaignName", "destination", "source", "templateParams", "userName"]); assert.equal(b.destination, "+919876543210"); assert.equal(ENDPOINT, "https://backend.aisensy.com/campaign/t1/api/v2"); });

const mk = (...rs) => { let i = 0, calls = 0; return { calls: () => calls, f: async () => { calls++; const r = rs[Math.min(i++, rs.length - 1)]; if (r instanceof Error) throw r; return { ok: r[0] < 400, status: r[0], text: async () => r[1] }; } }; };
await t("200 -> ok, one call", async () => { const m = mk([200, '{"success":"true"}']); const r = await postCampaign({}, { fetchImpl: m.f, delayMs: 1 }); assert.equal(r.ok, true); assert.equal(m.calls(), 1); });
await t("400 (bad campaign / param count) -> NOT retried, reason kept", async () => { const m = mk([400, "Template params mismatch"]); const r = await postCampaign({}, { fetchImpl: m.f, delayMs: 1 }); assert.equal(r.ok, false); assert.equal(m.calls(), 1); assert.match(r.body, /mismatch/); });
await t("500 then 200 -> retried and succeeds", async () => { const m = mk([500, "oops"], [200, "{}"]); const r = await postCampaign({}, { fetchImpl: m.f, delayMs: 1 }); assert.equal(r.ok, true); assert.equal(m.calls(), 2); });
await t("network error x3 -> gives up with a readable reason, never throws", async () => { const e = Object.assign(new Error("fetch failed"), { cause: { code: "ENOTFOUND" } }); const m = mk(e); const r = await postCampaign({}, { fetchImpl: m.f, delayMs: 1 }); assert.equal(r.ok, false); assert.equal(m.calls(), 3); assert.match(r.body, /ENOTFOUND/); });
console.log(`\n${n} checks run`);
