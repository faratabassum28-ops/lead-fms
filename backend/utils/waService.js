import { Lead, WaMessage } from "../models/Lead.js";
import * as S from "./leadService.js";
import { buildBody, postCampaign, welcomeParams } from "./aisensy.js";

// "We just connected" WhatsApp, sent through AiSensy the first time a lead's call is saved as Connected.
//   • The API key lives ONLY in the server's environment (AISENSY_API_KEY) — never in the database or the browser.
//   • Everything else (on/off, campaign name, workshop start, community link) is in Settings → WhatsApp.
//   • One welcome per lead: the lead is "claimed" atomically before sending, so two quick saves can't send twice;
//     if the send fails the claim is released so the next Connected save (or the admin's Resend) tries again.
//   • Every attempt — sent, failed or skipped — is written to the WhatsApp log (Settings), and sent ones to the lead's history.

const AI_DEF = { enabled: false, campaignName: "", triggerStatus: "Connected", startText: "", communityLink: "", onlyPaid: false };
export const aiCfg = (cfg) => ({ ...AI_DEF, ...(cfg?.aisensy || {}) });

const fail = (msg, status = 400) => Object.assign(new Error(msg), { status });
const clip = (v, n) => String(v ?? "").trim().slice(0, n);

// validate what the admin saved in Settings
export function cleanAisensy(a = {}) {
  const out = {
    enabled: !!a.enabled, campaignName: clip(a.campaignName, 80), triggerStatus: clip(a.triggerStatus, 40) || "Connected",
    startText: clip(a.startText, 120), communityLink: clip(a.communityLink, 300), onlyPaid: !!a.onlyPaid,
  };
  if (out.communityLink && !/^https?:\/\/\S+$/i.test(out.communityLink)) throw fail("The community / Zoom link must start with https://");
  if (out.enabled && !out.campaignName) throw fail("Enter the AiSensy campaign name before turning the WhatsApp message on");
  return out;
}

export const keyIsSet = () => !!process.env.AISENSY_API_KEY;
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
export async function sendWelcome(leadId, { callerName = "", by = "System", force = false } = {}) {
  const a = aiCfg(await S.getCfg());
  if (!force && !a.enabled) return { status: "skipped", reason: "WhatsApp message is switched off in Settings" };
  const lead = await Lead.findById(leadId);
  if (!lead) throw fail("Lead not found", 404);
  const base = { kind: "welcome", leadId: String(lead._id), leadKey: lead.key, name: lead.name, phone: lead.phone, campaign: a.campaignName, by };
  const skip = async (reason) => { await record({ ...base, status: "skipped", error: reason }); return { status: "skipped", reason }; };

  if (!force && lead.waWelcomeAt) return { status: "skipped", reason: "Already sent to this lead" };
  if (a.onlyPaid && !lead.paid && !force) return skip("Skipped — “only message paid leads” is on and this lead has not paid");
  const params = welcomeParams({ name: lead.name, caller: callerName || lead.assignedTo, start: a.startText || lead.utwDate, link: a.communityLink });
  if (params.some((p) => !p)) return skip("Skipped — fill in the caller, the workshop start date & time and the community link (Settings → WhatsApp)");
  if (!lead.phone) return skip("Skipped — this lead has no phone number");

  // claim: only one request may send for this lead
  const before = lead.waWelcomeAt || null;
  const claimed = await Lead.findOneAndUpdate(force ? { _id: lead._id } : { _id: lead._id, waWelcomeAt: null }, { $set: { waWelcomeAt: new Date() } });
  if (!claimed) return { status: "skipped", reason: "Already sent to this lead" };

  const r = await deliver({ a, phone: lead.phone, name: lead.name, params });
  if (r.ok) {
    await record({ ...base, status: "sent", params, response: r.response });
    await Lead.updateOne({ _id: lead._id }, { $push: { trail: S.trailOp("whatsapp", `Welcome WhatsApp sent via AiSensy (by ${by})`, "AiSensy") } });
    return { status: "sent" };
  }
  // release the claim so it can be retried
  await Lead.updateOne({ _id: lead._id }, before ? { $set: { waWelcomeAt: before } } : { $unset: { waWelcomeAt: 1 } });
  await record({ ...base, status: "failed", params, error: r.error });
  await Lead.updateOne({ _id: lead._id }, { $push: { trail: S.trailOp("whatsapp", `Welcome WhatsApp could not be sent: ${r.error}`, "AiSensy") } });
  return { status: "failed", reason: r.error };
}

// fire-and-forget: never slows the caller down and never throws
export const welcomeSoon = (leadId, opts) => sendWelcome(leadId, opts).catch((e) => console.error("[whatsapp] welcome failed:", e.message));

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
