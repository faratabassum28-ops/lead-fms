import * as S from "./leadService.js";
import * as W from "./waService.js";
import cron from "node-cron";

// One place that runs "sheet -> website": import the rows, then everything that should happen to a NEW lead.
// Used by the 1-minute background job, the "Import from sheet" button and the instant ping from the Google Sheet.

// a row older than this is history (e.g. an old list pasted in) — it never triggers a WhatsApp on arrival
const FRESH_MS = 24 * 36e5;

export async function runSync(by = null) {
  const r = await S.syncIntake(by);
  const fresh = (r.newLeads || []).filter((n) => !n.ts || Date.now() - new Date(n.ts) < FRESH_MS);
  for (const n of fresh) W.arrivalWelcome(n.id, n.owner); // queued: never blocks the import, never throws
  S.bustProgress();
  return { added: r.added, updated: r.updated, byEmailMatched: r.byEmailMatched };
}

// The Google Sheet says "something changed": sync now. Many pings in a row (a 50-row paste) collapse into
// one run followed by at most one more run, so nothing is missed and nothing runs twice at the same time.
let running = false, again = false;
export function syncSoon() {
  if (running) { again = true; return; }
  running = true;
  (async () => {
    try {
      for (let i = 0; i < 5; i++) {
        again = false;
        try { await runSync(); }
        catch (e) {
          if (/already running/i.test(e.message)) { again = true; await new Promise((r) => setTimeout(r, 3000)); }
          else console.error("[sheet] instant sync failed:", e.message);
        }
        if (!again) break;
      }
    } finally { running = false; }
  })();
}

// Every minute: write Level / Profession / City back to the sheet, import new rows, run the daily share and retry any
// WhatsApp that could not be sent. The Google Sheet also pings the website the moment a row is added (instant), so
// this is the safety net, not the main path. Each step is isolated: one failing never stops the others.
let ticking = false;
export function startSheetJobs() {
  cron.schedule("* * * * *", async () => {
    if (ticking) return;
    ticking = true;
    try {
      await S.pushDirty().catch(() => {});
      await runSync().catch(() => {}); // failures are saved + shown in Settings; a repeated failure is logged once
      await S.shareTick().catch((e) => console.error("[leads] share tick failed:", e.message));
      await W.retryPending().catch((e) => console.error("[whatsapp] retry failed:", e.message));
    } finally { ticking = false; }
  });
}
