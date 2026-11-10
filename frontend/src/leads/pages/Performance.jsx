import React, { useCallback, useEffect, useState } from "react";
import PageHeader from "../../components/PageHeader.jsx";
import PageLoader from "../../components/PageLoader.jsx";
import { api } from "../../api.js";
import { avatarStyleFromString, initials } from "../../utils/colorFromString.js";
import { useLeads } from "../LeadsContext.jsx";

// ---- India-time calendar helpers (the follow-up plan is in IST; the browser may not be) ----
const IST = 330 * 60000;
const ymd = (ms) => new Date(ms + IST).toISOString().slice(0, 10);
const addDays = (s, n) => ymd(new Date(s + "T00:00:00Z").getTime() - IST + n * 864e5);
const dow = (s) => new Date(s + "T00:00:00Z").getUTCDay(); // 0 = Sunday
const monday = (s) => addDays(s, -((dow(s) + 6) % 7));
const PRESETS = [
  ["today", "Today", (t) => [t, t]],
  ["yesterday", "Yesterday", (t) => [addDays(t, -1), addDays(t, -1)]],
  ["week", "This week", (t) => [monday(t), t]],
  ["lastweek", "Last week", (t) => [addDays(monday(t), -7), addDays(monday(t), -1)]],
  ["month", "This month", (t) => [t.slice(0, 8) + "01", t]],
];
const LABEL = { excellent: "Excellent", good: "Good", fair: "Fair", poor: "Poor", none: "No tasks due" };
const clock = (d) => new Date(d).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: "Asia/Kolkata" }).toLowerCase();

// % change between two numbers, as a little ▲/▼ chip (nothing when there is no earlier period to compare with)
const Delta = ({ now, before, pp }) => {
  if (before == null || now == null || (!pp && !before)) return null;
  const v = pp ? Math.round((now - before) * 10) / 10 : Math.round(((now - before) / before) * 100);
  if (!v) return null;
  return <span className={"pf-delta " + (v > 0 ? "up" : "down")}>{v > 0 ? "▲" : "▼"} {Math.abs(v)}{pp ? " pp" : "%"}</span>;
};
const Card = ({ cls, label, delta, value, big, note }) => (
  <div className={"pf-card " + cls}>
    <div className="pf-card-top"><span>{label}</span>{delta}</div>
    <div className="pf-big">{value}{big && <small>{big}</small>}</div>
    {note}
  </div>
);
const rate = (t) => (t.due ? (t.onTime / t.due) * 100 : null);

// Admin scorecard: are people doing their follow-up calls on time? (every call has a deadline)
export default function Performance() {
  const { toast } = useLeads();
  const [range, setRange] = useState(null); // [from, to] — null until the first server answer tells us today's date
  const [preset, setPreset] = useState("today");
  const [d, setD] = useState(null);
  const load = useCallback((r) => {
    api.ldPerformance(r?.[0] || "", r?.[1] || "").then((x) => { setD(x); setRange((p) => p || [x.from, x.to]); }).catch((e) => toast(e.message, "bad"));
  }, []);
  useEffect(() => { load(null); }, [load]);
  const pick = (k, fn) => { const r = fn(d?.today || ymd(Date.now())); setPreset(k); setRange(r); setD(null); load(r); };
  const custom = (i, v) => { if (!v) return; const r = i ? [range[0], v] : [v, range[1]]; if (r[1] < r[0]) r[i ? 0 : 1] = v; setPreset("custom"); setRange(r); setD(null); load(r); };

  const t = d?.team, p = d?.prev;
  return (
    <div className="page">
      <PageHeader title="Team Performance" subtitle="How the team is doing: first, whether calls are done on time, then the work volume" />
      <div className="pf-bar">
        {PRESETS.map(([k, label, fn]) => <button key={k} type="button" className={"pf-pill" + (preset === k ? " on" : "")} onClick={() => pick(k, fn)}>{label}</button>)}
        <span className="pf-dates">From <input type="date" value={range?.[0] || ""} max={d?.today} onChange={(e) => custom(0, e.target.value)} />
          To <input type="date" value={range?.[1] || ""} max={d?.today} onChange={(e) => custom(1, e.target.value)} /></span>
        <span className="pf-meta">
          {d && <span>{d.from === d.to ? d.from : `${d.from} → ${d.to}`} (IST){d.inProgress ? " · in progress" : ""}</span>}
          {d && <span>Updated {clock(d.at)}</span>}
          <button type="button" className="ld-btn" onClick={() => { setD(null); load(range); }}>Refresh</button>
        </span>
      </div>

      {!d ? <PageLoader /> : (
        <>
          <h2 className="pf-h">Task scorecard: are they doing their work on time?</h2>
          <p className="pf-sub">Every follow-up call (FU1, FU2, FU3 …) has a deadline. A task counts here when its deadline falls in the period you picked.</p>
          <div className="pf-cards">
            <Card cls={"c-" + t.rating} label="Team score" delta={<Delta now={t.score} before={p.score} />} value={t.score ?? "—"} big={t.score != null ? "/100" : ""}
              note={<span className={"pf-tag " + t.rating}>{LABEL[t.rating]}</span>} />
            <Card cls="c-due" label="Tasks due" delta={<Delta now={t.due} before={p.due} />} value={t.due} note={<span className="pf-note">{t.assigned} assigned in this period</span>} />
            <Card cls="c-good" label="Done on time" delta={<Delta pp now={rate(t)} before={rate(p)} />} value={t.onTime} note={<span className="pf-note">{t.due ? Math.round((t.onTime / t.due) * 100) : 0}% of tasks due</span>} />
            <Card cls="c-late" label="Done late" value={t.late} note={<span className="pf-note">finished after it turned overdue</span>} />
            <Card cls="c-miss" label="Missed" value={t.missed} note={<span className="pf-note">still not done and overdue</span>} />
            <Card cls="c-todo" label="Still to do" value={t.todo} note={<span className="pf-note">due in this period, not overdue yet</span>} />
          </div>

          <div className="pf-table">
            <table>
              <thead><tr><th>Person</th><th>Performance</th><th className="n">Assigned</th><th className="n">Due</th><th className="n">On time</th><th className="n">Late</th><th className="n">Missed</th><th className="n">To do</th><th className="n">Completed</th></tr></thead>
              <tbody>
                {d.rows.map((x) => (
                  <tr key={x.name}>
                    <td><div className="pf-person"><span className="avatar" style={avatarStyleFromString(x.name)}>{initials(x.name)}</span><div><b>{x.name}</b><small>{x.admin ? "Admin" : "Caller"}</small></div></div></td>
                    <td><div className="pf-perf">
                      <span className="pf-meter"><i className={x.rating} style={{ width: (x.score ?? 0) + "%" }} /></span>
                      <span className="pf-score">{x.score ?? "—"}</span>
                      <span className={"pf-tag " + x.rating}>{LABEL[x.rating]}</span>
                    </div></td>
                    <td className="n">{x.assigned}</td><td className="n">{x.due}</td>
                    <td className={"n " + (x.onTime ? "pf-ok" : "pf-mute")}>{x.onTime}</td>
                    <td className="n">{x.late}</td>
                    <td className={"n " + (x.missed ? "pf-no" : "pf-mute")}>{x.missed}</td>
                    <td className="n">{x.todo}</td>
                    <td className="n">{x.completed == null ? "—" : x.completed + "%"}</td>
                  </tr>
                ))}
                {!d.rows.length && <tr><td colSpan={9} style={{ textAlign: "center", color: "var(--muted)", padding: 24 }}>No follow-ups fall in this period.</td></tr>}
                <tr className="team">
                  <td>Team</td>
                  <td><div className="pf-perf"><span className="pf-meter"><i className={t.rating} style={{ width: (t.score ?? 0) + "%" }} /></span><span className="pf-score">{t.score ?? "—"}</span></div></td>
                  <td className="n">{t.assigned}</td><td className="n">{t.due}</td><td className="n">{t.onTime}</td><td className="n">{t.late}</td><td className="n">{t.missed}</td><td className="n">{t.todo}</td>
                  <td className="n">{t.completed == null ? "—" : t.completed + "%"}</td>
                </tr>
              </tbody>
            </table>
          </div>

          <details className="pf-how">
            <summary>How is the score worked out?</summary>
            <p>Each call has a deadline: its planned time{d.graceMin ? `, with ${d.graceMin} minutes of grace` : ""}.</p>
            <ul>
              <li><b>Done on time</b> — finished by the deadline. <b>Done late</b> — finished after it.</li>
              <li><b>Missed</b> — the deadline has passed and the call is still not done. <b>Still to do</b> — the deadline has not come yet.</li>
              <li><b>Tasks due</b> = on time + late + missed.</li>
              <li><b>Score</b> = (on time + half of late) ÷ tasks due × 100. Excellent 85+, Good 70+, Fair 50+, Poor below 50.</li>
              <li>The ▲/▼ chips compare with the period just before this one, of the same length.</li>
            </ul>
          </details>
        </>
      )}
    </div>
  );
}
