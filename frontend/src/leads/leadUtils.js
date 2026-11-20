// Shared helpers for the Lead FMS app (formatting, follow-up state, task lists, CSV).

export const fmt = (d) =>
  d ? new Date(d).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false }) : "—";

// "3h 20m" / "2d 4h"
export const hm = (ms) => {
  const h = Math.floor(ms / 36e5);
  return h >= 24 ? `${Math.floor(h / 24)}d ${h % 24}h` : `${h}h ${Math.floor((ms % 36e5) / 6e4)}m`;
};

// how late a follow-up is (still running if not done yet)
export const delay = (f, now) => {
  if (f.skipped) return "";
  const ms = (f.actual ? new Date(f.actual) : now) - new Date(f.planned);
  return ms > 0 ? hm(ms) : "";
};

// skip = auto-closed, done, over = overdue, wait = upcoming
export const state = (f, now) => (f.skipped ? "skip" : f.actual ? "done" : new Date(f.planned) < now ? "over" : "wait");
export const LBL = { skip: "Auto-closed", done: "Done", over: "Overdue", wait: "Upcoming" };

// the three follow-up tracks every lead can have
export const DAYS = [1, 2, 3];
export const SETS = [["fus", "FU"], ["d1Fus", "D1·FU"], ["d2Fus", "D2·FU"], ["d3Fus", "D3·FU"]];
const dayOf = (set) => (set === "fus" ? 0 : +set[1]);
// "Day 2 · " for an attendee set, "" for the lead's own calls
export const dayTag = (set) => (set === "fus" ? "" : `Day ${dayOf(set)} · `);

// who owns a follow-up: Day 1 / Day 2 can have their own caller, otherwise the lead's caller
export const stageWho = (l, set) =>
  ((set === "fus" ? "" : l["d" + dayOf(set) + "Assigned"]) || l.assignedTo || "").toLowerCase();

// every follow-up that is actionable right now (not done, not closed, previous one done)
// (steps beyond what Settings declares — e.g. an old FU4 — are never actionable)
export const planLen = (cfg, set) => (set === "fus" ? cfg?.plan : cfg?.attPlan)?.length ?? Infinity;
export const tasksOf = (leads, who, cfg) =>
  leads
    .flatMap((l) => SETS.flatMap(([set, lb]) => (l[set] || []).slice(0, planLen(cfg, set)).map((f, i) => ({ l, f, i, set, lb }))))
    .filter((t) => !(t.set === "fus" && t.l.source === "razorpay")) // paid-by-Razorpay leads live in the Razorpay Payments tab, not in FU1
    .filter((t) => t.f.planned && !t.f.actual && !t.f.skipped && (t.i === 0 || t.l[t.set][t.i - 1].actual || t.l[t.set][t.i - 1].skipped) && (!who || stageWho(t.l, t.set) === who.toLowerCase()));

// the person a follow-up belongs to, as they are spelled on the lead ("Unassigned" when nobody has it yet)
export const ownerOf = (l, set) => (set === "fus" ? "" : l["d" + dayOf(set) + "Assigned"]) || l.assignedTo || "Unassigned";
// "just now" / "5 min ago" / "2 h ago"
export const ago = (d, now = new Date()) => {
  if (!d) return "";
  const m = Math.max(0, Math.round((now - new Date(d)) / 6e4));
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.floor(m / 60)} h ago` : fmt(d);
};
export const NO_WS = "__none"; // the "no workshop" filter

// whole calendar days between a planned time and today (1 = yesterday) — "how long has this been waiting"
export const daysAgo = (planned, today = new Date()) => {
  const a = new Date(today), p = new Date(planned);
  a.setHours(0, 0, 0, 0); p.setHours(0, 0, 0, 0);
  return Math.round((a - p) / 864e5);
};
// Delayed Follow-ups are triaged by how long they have waited; Today Follow-ups by "due now" vs "later today"
export const DELAY_BUCKETS = [["1", "Yesterday", (d) => d <= 1], ["2-3", "2–3 days", (d) => d >= 2 && d <= 3], ["4-7", "4–7 days", (d) => d >= 4 && d <= 7], ["8+", "Over a week", (d) => d >= 8]];
export const TODAY_BUCKETS = [["now", "Due now"], ["later", "Later today"]];
export const bucketOf = (t, now, delayed) => (delayed ? (DELAY_BUCKETS.find(([, , fn]) => fn(daysAgo(t.f.planned, now))) || DELAY_BUCKETS[3])[0] : new Date(t.f.planned) <= now ? "now" : "later");
export const shortDate = (d) => new Date(d).toLocaleDateString("en-IN", { day: "numeric", month: "short" });

export const wa = (p, t = "") => "https://wa.me/" + (p.length === 10 ? "91" + p : p) + (t ? "?text=" + encodeURIComponent(t) : "");
export const waText = (l, cfg) => (cfg?.waTemplate || "").replace("{name}", l.name || "").replace("{caller}", l.assignedTo || "");

export const pc = (a, b) => (b ? Math.round((a / b) * 100) + "%" : "—");
export const endOfToday = () => { const d = new Date(); d.setHours(23, 59, 59, 999); return d; };
// "Today Follow-ups": planned for today (any follow-up step). Planned before today -> "Delayed Follow-ups".
export const isDueToday = (t) => {
  const a = new Date(); a.setHours(0, 0, 0, 0);
  return new Date(t.f.planned) >= a;
};

// Follow-up steps are configured in Settings (up to 10). These helpers keep every page in step with that plan.
export const MAX_FU = 10;
const ORD = ["First", "Second", "Third", "Fourth", "Fifth", "Sixth", "Seventh", "Eighth", "Ninth", "Tenth"];
export const stepName = (i) => (ORD[i] || `Call ${i + 1}`) + " call";
// how many FU columns to show: exactly what Settings declares (add one there -> a new column appears everywhere)
export const fuCount = (cfg, leads = [], set = "fus", plan = set === "fus" ? cfg?.plan : cfg?.attPlan) =>
  Math.min(MAX_FU, plan?.length || 0);
// FU1 / FU2 / ... columns for the lead-qualification calls; Day 1 / Day 2 attendee calls get their own block
export const fuCols = (cfg, leads) => Array.from({ length: fuCount(cfg, leads) }, (_, i) => ["fus", i, "FU" + (i + 1), stepName(i)]);

// ---- workshops: how many days each one runs and how many follow-ups follow each day (Settings → Workshops) ----
// Same rule as the server: a workshop that is not listed uses the default; "auto" follow-ups = 1 for a 1-day workshop, else the whole plan.
export function wsInfo(cfg, name) {
  const key = String(name || "").replace(/\s+/g, " ").trim().toLowerCase(), hit = key && (cfg?.workshops || []).find((w) => String(w.name || "").toLowerCase() === key);
  const base = { days: 2, fu: 0, ...(cfg?.wsDefault || {}) }, days = Math.min(3, Math.max(1, Math.floor(Number(hit?.days ?? base.days)) || 2));
  const want = Math.floor(Number(hit ? hit.fu : base.fu)) || 0, max = cfg?.attPlan?.length || 1;
  return { days, fu: Math.min(max, Math.max(1, want || (days === 1 ? 1 : max))), listed: !!hit };
}
// the Day tabs to show: Day 1 and Day 2 always (as before), Day 3 only once a 3-day workshop exists (or someone already has Day 3)
export const dayCount = (cfg, leads = []) => (leads.some((l) => l.day3 || wsInfo(cfg, l.workshop).days >= 3) || (cfg?.workshops || []).some((w) => +w.days >= 3) ? 3 : 2);
// FU1 / FU2 columns of one Day tab: as many as the longest follow-up list among the people who attended that day
export const attCols = (cfg, leads, day) => {
  const set = "d" + day + "Fus", n = Math.max(1, ...leads.filter((l) => l["day" + day]).map((l) => (l[set] || []).length));
  return Array.from({ length: Math.min(MAX_FU, n, cfg?.attPlan?.length || n) }, (_, i) => [set, i, "FU" + (i + 1), stepName(i)]);
};
// deal n items to people by ratio, exactly (100 at 2 : 1 : 1 → 50 / 25 / 25) — the same rule as the server, so the preview matches
export function dealCounts(n, people) {
  const tot = people.reduce((a, p) => a + p.share, 0);
  if (!n || !tot) return people.map(() => 0);
  const quota = people.map((p) => (n * p.share) / tot), give = quota.map(Math.floor);
  let left = n - give.reduce((a, b) => a + b, 0);
  quota.map((q, i) => [q - Math.floor(q), i]).sort((a, b) => b[0] - a[0] || a[1] - b[1]).slice(0, left).forEach(([, i]) => give[i]++);
  return give;
}
// every registration of the same person (phone, last 10 digits) — a person can register again and again
export const regsOf = (leads) => {
  const m = new Map();
  for (const l of leads) { const k = String(l.phone10 || l.phone || "").slice(-10); if (k) m.set(k, [...(m.get(k) || []), l]); }
  for (const a of m.values()) a.sort((x, y) => new Date(x.ts) - new Date(y.ts));
  return m;
};

export function downloadCsv(filename, rows) {
  const csv = rows.map((r) => r.map((c) => `"${String(c ?? "").replace(/"/g, '""')}"`).join(",")).join("\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
