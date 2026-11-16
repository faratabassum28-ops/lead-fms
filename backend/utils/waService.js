import { Lead, WaMessage } from "../models/Lead.js";
import * as S from "./leadService.js";
import { buildBody, destinationFor, postCampaign, welcomeParams } from "./aisensy.js";

// "We just connected" WhatsApp, sent through AiSensy the first time a lead's call is saved as Connected.
//   • The API key lives ONLY in the server's environment (AISENSY_API_KEY) — never in the database or the browser.
//   • Everything else (on/off, campaign name, workshop start, community link) is in Settings → WhatsApp.
//   • One welcome per lead: the lead is "claimed" atomically before sending, so two quick saves can't send twice;
//     if the send fails the claim is released so the next Connected save (or the admin's Resend) tries again.
//   • Every attempt — sent, failed or skipped — is written to the WhatsApp log (Settings), and sent ones to the lead's history.

const AI_DEF = { enabled: false, trigger: "status", campaignName: "", triggerStatus: "Connected", startText: "", communityLink: "", onlyPaid: false };
// trigger: "status" = when a caller saves the call as triggerStatus (default)  ·  "arrival" = the moment a new lead comes in
export const aiCfg = (cfg) => ({ ...AI_DEF, ...(cfg?.aisensy || {}) });

const fail = (msg, status = 400) => Object.assign(new Error(msg), { status });
const clip = (v, n) => String(v ?? "").trim().slice(0, n);

// validate what the admin saved in Settings
export function cleanAisensy(a = {}) {
  const out = {
    enabled: !!a.enabled, trigger: a.trigger === "arrival" ? "arrival" : "status", campaignName: clip(a.campaignName, 80), triggerStatus: clip(a.triggerStatus, 40) || "Connected",
    startText: clip(a.startText, 120), communityLink: clip(a.communityLink, 300), onlyPaid: !!a.onlyPaid,
  };
  if (out.communityLink && !/^https?:\/\/\S+$/i.test(out.communityLink)) throw fail("The community / Zoom link must start with https://");
  if (out.enabled && !out.campaignName) throw fail("Enter the AiSensy campaign name before turning the WhatsApp message on");
  return out;
}

export const keyIsSet = () => !!process.env.AISENSY_API_KEY;
// What is still missing before a welcome can go out — shown in Settings so a silent "not working" is never a mystery.
export function problems(cfg) {
  const a = aiCfg(cfg), out = [];
  if (!keyIsSet()) out.push("AISENSY_API_KEY is not set on the server (Render → Environment), then redeploy");
  if (!a.enabled) out.push("“Send the welcome message automatically” is switched off");
  if (!a.campaignName) out.push("AiSensy campaign name is empty");
  if (!a.communityLink) out.push("Default community / Zoom link is empty (leads with their own “WhatsApp Link” in the sheet still work; others are skipped)");
  if (!a.startText) out.push("Workshop start date & time is empty (each lead’s own UTW Date is used instead — leads without one are skipped)");
  return out;
}
export const waLog = (limit = 100) => WaMessage.find().sort({ at: -1 }).limit(limit).lean();
const record = (v) => WaMessage.create({ at: new Date(), ...v }).catch((e) => console.error("[whatsapp] log failed:", e.message));

// shared by the real welcome and the "send a test" button
async function deliver({ a, phone, name, params }) {
  const key = process.env.AISENSY_API_KEY;
  if (!key) return { ok: false, error: "AISENSY_API_KEY is not set on the server (add it in Render → Environment)" };
  if (!a.campaignName) return { ok: false, error: "No AiSensy campaign name in Settings" };
  const r = await postCampaign(buildBody({ apiKey: key, campaignName: a.campaignName, phone, name, params, tags: ["lead-fms"] }));
  return r.ok ? { ok: true, response: r.body } : { ok: false, error: `AiSensy said (HTTP ${r.status || "—"}): ${r.body}` };
}

// callerName = who the lead is talking to ({{2}} in the template)
// force = an admin pressed "Resend" — ignores "already sent" and the on/off switch
// quiet = a background retry: skips are not written to the log again (only real sends and failures are)
export async function sendWelcome(leadId, { callerName = "", by = "System", force = false, quiet = false } = {}) {
  const a = aiCfg(await S.getCfg());
  if (!force && !a.enabled) return { status: "skipped", reason: "WhatsApp message is switched off in Settings" };
  const lead = await Lead.findById(leadId);
  if (!lead) throw fail("Lead not found", 404);
  const base = { kind: "welcome", leadId: String(lead._id), leadKey: lead.key, name: lead.name, phone: lead.phone, campaign: a.campaignName, by };
  const skip = async (reason) => { if (!quiet) await record({ ...base, status: "skipped", error: reason }); return { status: "skipped", reason }; };

  if (!force && lead.waWelcomeAt) return { status: "skipped", reason: "Already sent to this lead" };
  if (a.onlyPaid && !lead.paid && !force) return skip("Skipped — “only message paid leads” is on and this lead has not paid");
  // an unassigned lead still gets the message — signed by the team instead of silently never being sent
  const params = welcomeParams({ name: lead.name, caller: callerName || lead.assignedTo || "My Soul School team", start: a.startText || lead.utwDate, link: /^https?:\/\/\S+$/i.test(lead.waLink || "") ? lead.waLink.trim() : a.communityLink });
  if (params.some((p) => !p)) return skip("Skipped — needs a workshop start date & time (Settings, or the lead\u2019s UTW / start date) and a community link (the lead\u2019s “WhatsApp Link” in the sheet, or the default in Settings)");
  if (destinationFor(lead.phone).length < 11) return skip("Skipped — this lead has no valid phone number");

  // claim: only one request may send for this lead
  const before = lead.waWelcomeAt || null;
  const claimed = await Lead.findOneAndUpdate(force ? { _id: lead._id } : { _id: lead._id, waWelcomeAt: null }, { $set: { waWelcomeAt: new Date() } });
  if (!claimed) return { status: "skipped", reason: "Already sent to this lead" };

  const r = await deliver({ a, phone: lead.phone, name: lead.name, params });
  if (r.ok) {
    await record({ ...base, status: "sent", params, response: r.response });
    await Lead.updateOne({ _id: lead._id }, { $unset: { waPendingAt: 1, waTriedAt: 1 }, $set: { waTries: 0, msgSent: sentStamp(), sheetDirty: true }, $push: { trail: S.trailOp("whatsapp", `Welcome WhatsApp sent via AiSensy (by ${by})`, "AiSensy") } });
    return { status: "sent" };
  }
  // release the claim, remember the attempt: the background job tries again (see retryPending)
  await Lead.updateOne({ _id: lead._id }, { ...(before ? { $set: { waWelcomeAt: before } } : { $unset: { waWelcomeAt: 1 } }), $inc: { waTries: 1 } });
  await Lead.updateOne({ _id: lead._id }, { $set: { waTriedAt: new Date() }, $push: { trail: S.trailOp("whatsapp", `Welcome WhatsApp could not be sent: ${r.error}`, "AiSensy") } });
  await record({ ...base, status: "failed", params, error: r.error });
  return { status: "failed", reason: r.error };
}

// ---- sending one at a time -------------------------------------------------------------------------------------------
// AiSensy rate-limits bursts (a 50-row paste would fire 50 requests at once), so welcomes go out one after another.
let chain = Promise.resolve();
const enqueue = (fn) => { const run = chain.then(fn, fn); chain = run.then(() => wait(400), () => wait(400)); return run; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// A welcome is DUE for this lead (trigger fired). It is remembered as pending, so if AiSensy is down for a minute or a
// setting is still missing, the background job sends it later — for up to 24 hours — instead of it being lost.
export async function triggerWelcome(leadId, opts = {}) {
  await Lead.updateOne({ _id: leadId, waWelcomeAt: null }, { $set: { waPendingAt: new Date(), waTries: 0 }, $unset: { waTriedAt: 1 } });
  return enqueue(() => sendWelcome(leadId, opts));
}
// fire-and-forget: never slows the caller down and never throws
export const welcomeSoon = (leadId, opts) => triggerWelcome(leadId, opts).catch((e) => console.error("[whatsapp] welcome failed:", e.message));

// "As soon as a new lead arrives" mode (Settings → WhatsApp → Send when)
export async function arrivalWelcome(leadId, owner = "") {
  try {
    const a = aiCfg(await S.getCfg());
    if (a.enabled && a.trigger === "arrival") await welcomeSoon(leadId, { callerName: owner, by: "System" });
  } catch (e) { console.error("[whatsapp] arrival welcome failed:", e.message); }
}

// "Sent 15/11/2026 18:30" (India time) — written into the sheet's Msg Sent column
const sentStamp = () => { const d = S.L(new Date()), p = (n) => String(n).padStart(2, "0"); return `Sent ${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)}/${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`; };
const MAX_TRIES = 5, WINDOW_MS = 24 * 36e5;
// every minute: send the welcomes that are due but not delivered yet (failed send, missing setting that is now filled in)
export async function retryPending() {
  const a = aiCfg(await S.getCfg());
  if (!a.enabled) return { retried: 0 };
  const now = Date.now();
  const due = await Lead.find({ waWelcomeAt: null, waPendingAt: { $gt: new Date(now - WINDOW_MS) }, waTries: { $lt: MAX_TRIES } }).limit(20);
  let retried = 0;
  for (const l of due) {
    // wait longer after each failure: 1, 2, 4, 8 minutes
    if (l.waTriedAt && now - +l.waTriedAt < 60_000 * 2 ** Math.max(0, (l.waTries || 1) - 1)) continue;
    retried++;
    await enqueue(() => sendWelcome(l._id, { callerName: l.assignedTo, by: "System (retry)", quiet: true })).catch((e) => console.error("[whatsapp] retry failed:", e.message));
  }
  return { retried };
}

// Settings → "Send a test": same template and campaign, to any number, no lead involved
export async function sendTest({ phone, name = "Test", callerName = "Team", by = "Admin" }) {
  const a = aiCfg(await S.getCfg());
  const params = welcomeParams({ name, caller: callerName, start: a.startText || "Test date & time", link: a.communityLink || "https://example.com" });
  const base = { kind: "test", name, phone: String(phone || ""), campaign: a.campaignName, by };
  if (String(phone || "").replace(/\D/g, "").length < 10) throw fail("Enter the phone number to send the test to");
  const r = await deliver({ a, phone, name, params });
  await record({ ...base, status: r.ok ? "sent" : "failed", params, response: r.response, error: r.error });
  return r.ok ? { status: "sent" } : { status: "failed", reason: r.error };
}
