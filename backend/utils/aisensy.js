// AiSensy "API Campaign" client — no database, so it can be tested on its own.
// Docs: POST https://backend.aisensy.com/campaign/t1/api/v2
//   { apiKey, campaignName, destination, userName, source, templateParams: [...] }
// templateParams must have EXACTLY as many entries as the approved template has {{n}} variables, otherwise AiSensy rejects it.

export const ENDPOINT = "https://backend.aisensy.com/campaign/t1/api/v2";

// AiSensy wants the number with its country code: +919876543210. A bare 10-digit number is taken as Indian.
export function destinationFor(phone) {
  const d = String(phone ?? "").replace(/\D/g, "");
  if (d.length === 10) return "+91" + d;
  if (d.length === 11 && d.startsWith("0")) return "+91" + d.slice(1);
  return d.length >= 10 ? "+" + d : "";
}

// "priya sharma" -> "Priya" (the template says "Hi {{1}}")
export const firstName = (name) => {
  const w = String(name ?? "").trim().split(/\s+/)[0] || "";
  return w ? w[0].toUpperCase() + w.slice(1).toLowerCase() : "there";
};

// The four variables of the Mehakleen welcome template, in order:
//   {{1}} first name · {{2}} caller · {{3}} workshop start date & time · {{4}} private community (Zoom) link
export const welcomeParams = ({ name, caller, start, link }) => [firstName(name), String(caller || "").trim(), String(start || "").trim(), String(link || "").trim()];

export const buildBody = ({ apiKey, campaignName, phone, name, params, tags }) => ({
  apiKey, campaignName, destination: destinationFor(phone), userName: String(name || "").trim() || "Lead",
  source: "lead-fms", templateParams: params, ...(tags?.length ? { tags } : {}),
});

const snippet = (t) => String(t ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// -> { ok, status, body } ; never throws. Retries network errors, 429 and 5xx (up to 3 tries).
export async function postCampaign(body, { fetchImpl = fetch, delayMs = 1500 } = {}) {
  let last = { ok: false, status: 0, body: "Not sent" };
  for (let a = 1; a <= 3; a++) {
    const ctrl = new AbortController(), timer = setTimeout(() => ctrl.abort(), 20_000);
    try {
      const res = await fetchImpl(ENDPOINT, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: ctrl.signal });
      const txt = await res.text();
      last = { ok: res.ok, status: res.status, body: snippet(txt) };
      if (res.ok || (res.status !== 429 && res.status < 500)) return last; // success, or a request problem retrying cannot fix
    } catch (e) {
      last = { ok: false, status: 0, body: e?.name === "AbortError" ? "AiSensy took longer than 20 seconds to answer" : `Could not reach AiSensy (${e?.cause?.code || e?.message || "network error"})` };
    } finally { clearTimeout(timer); }
    if (a < 3) await wait(delayMs * a);
  }
  return last;
}
