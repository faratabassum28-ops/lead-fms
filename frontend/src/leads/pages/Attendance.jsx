import React, { useState } from "react";
import PageHeader from "../../components/PageHeader.jsx";
import PageLoader from "../../components/PageLoader.jsx";
import SearchInput from "../../components/SearchInput.jsx";
import { useLeads } from "../LeadsContext.jsx";
import { LBL, dayCount, delay, fmt, state, stageWho, wsInfo } from "../leadUtils.js";
import { Stats } from "../ui.jsx";
import WorkshopBar from "../WorkshopBar.jsx";
import PasteAttendance from "../PasteAttendance.jsx";

// "Registration #2" tag: the same person can register again and again, each registration is its own row
const Reg = ({ info }) => (info.of > 1 ? <span className="ld-reg" title={`This person registered ${info.of} times — ${info.others.map((o) => o.workshop || "no workshop").join(", ")}`}>#{info.n} of {info.of}</span> : null);

// Attendees of each workshop day (Day 1 / 2 / 3) with their follow-up calls, plus the page where attendance is marked.
export default function Attendance() {
  const { leads, loaded, cfg, now, admin, who, patchLead, setModal, load, toast, inWs, openLead, workshops, workshop, regOf } = useLeads();
  const [mode, setMode] = useState("d1"), [q, setQ] = useState(""), [lim, setLim] = useState(200);
  if (!loaded || !cfg) return <PageLoader />;
  const nDays = dayCount(cfg, leads), days = Array.from({ length: nDays }, (_, i) => i + 1);
  const d = mode === "mark" ? 1 : Math.min(+mode[1] || 1, nDays), set = "d" + d + "Fus", needle = q.trim().toLowerCase();
  const hit = (l) => inWs(l) && (!needle || (l.name + " " + (l.workshop || "") + (admin ? " " + l.phone + " " + (l.email || "") : "")).toLowerCase().includes(needle));
  const rows = leads.filter((l) => (mode === "mark" || l["day" + d]) && hit(l) && (!who || mode === "mark" || stageWho(l, set) === who.toLowerCase()));
  const caller = (l) => l["d" + d + "Assigned"] || l.assignedTo;
  const tick = async (l, body) => { try { await patchLead(l, body); } catch (e) { toast(e.message, "bad"); } };
  // FU1 / FU2 … groups: as many as the longest list on this page (1 for a 1-day workshop, 2 for the usual plan)
  const nFu = Math.max(1, ...rows.map((l) => (l[set] || []).length));
  const baseCols = admin ? 9 : 7;
  const attended = (n) => leads.filter((l) => l["day" + n]).length;
  return (
    <div className="page">
      <PageHeader title="Attendance" subtitle={`Day 1${nDays > 1 ? " – Day " + nDays : ""} attendees and their follow-up calls`} />
      <Stats items={[...days.map((n) => [`Day ${n} attendees`, attended(n), "accent"]), ["Day 1 only (chase for Day 2)", leads.filter((l) => l.day1 && !l.day2 && wsInfo(cfg, l.workshop).days > 1).length, "neutral"]]} />
      <div className="toolbar">
        <div className="range-pills" role="tablist" style={{ margin: 0 }}>
          {[...days.map((n) => ["d" + n, `Day ${n} Attendees`]), ["mark", "✔ Mark attendance"]].map(([k, v]) => (
            <button key={k} type="button" role="tab" aria-selected={mode === k} className={"range-pill" + (mode === k ? " range-pill-active" : "")} onClick={() => setMode(k)}>{v}</button>
          ))}
        </div>
        <SearchInput value={q} onChange={setQ} placeholder={admin ? "Search name, phone or email…" : "Search name…"} />
      </div>
      <WorkshopBar items={leads.filter((l) => mode === "mark" || l["day" + d])} />
      {mode !== "mark" && admin && <PasteAttendance d={d} cfg={cfg} workshops={workshops} workshop={workshop} toast={toast} onDone={load} />}
      {mode === "mark" ? (
        <div className="table-wrap">
          <table className="table"><thead><tr><th>Lead</th>{admin && <th>Phone</th>}{admin && <th>Email</th>}<th>Workshop</th><th>Caller</th>{days.map((n) => <th key={n}>Day {n}</th>)}</tr></thead>
            <tbody>
              {rows.slice(0, lim).map((l) => {
                const info = wsInfo(cfg, l.workshop);
                return (
                  <tr key={l._id}><td><button type="button" className="ld-namebtn" onClick={() => openLead(l)}><b>{l.name}</b></button> <Reg info={regOf(l)} /></td>{admin && <td>{l.phone}</td>}{admin && <td>{l.email}</td>}
                    <td>{l.workshop ? <span className="ld-ws">{l.workshop}</span> : "—"} <span className="ld-small">{info.days}-day</span></td><td>{l.assignedTo}</td>
                    {days.map((n) => (
                      <td key={n}>{n <= info.days || l["day" + n]
                        ? <input type="checkbox" checked={!!l["day" + n]} onChange={(e) => tick(l, { ["day" + n]: e.target.checked })} aria-label={`Day ${n} ${l.name}`} />
                        : <span className="ld-small" title={`${l.workshop || "This workshop"} runs ${info.days} day${info.days > 1 ? "s" : ""}`}>—</span>}</td>
                    ))}</tr>
                );
              })}
              {!rows.length && <tr><td colSpan={admin ? 5 + nDays : 3 + nDays} className="empty-state">No leads match.</td></tr>}
            </tbody></table>
        </div>
      ) : (
        <div className="table-wrap">
          <table className="table ld-sheet">
            <thead>
              <tr><th colSpan={baseCols} className="g0">Day {d} Attendees</th>{Array.from({ length: nFu }, (_, k) => k + 1).map((n) => <th key={n} colSpan={5} className={"g" + (((n - 1) % 3) + 1)}>FollowUp {n} · Day {d} Call {n}</th>)}</tr>
              <tr>{["Timestamp", "Lead Name", ...(admin ? ["Lead Email", "Lead Phone"] : []), "UTW Date", "Webinar Reg.", "Workshop", "Assigned To", "Current FollowUp Status"].map((h) => <th key={h}>{h}</th>)}
                {Array.from({ length: nFu }, (_, k) => k + 1).flatMap((n) => ["Planned", "Actual", "Status", "Action", "Time Delay"].map((h) => <th key={n + h} className={"g" + (((n - 1) % 3) + 1)}>{h}</th>))}</tr>
            </thead>
            <tbody>
              {rows.slice(0, lim).map((l) => {
                const F = (l[set] || []).slice(0, nFu), cur = [...F].reverse().find((f) => f.status)?.status || "—";
                return (
                  <tr key={l._id}>
                    <td>{fmt(l.ts)}</td><td><button type="button" className="ld-namebtn" onClick={() => openLead(l)}><b>{l.name}</b></button> <Reg info={regOf(l)} /></td>{admin && <><td>{l.email}</td><td>{l.phone}</td></>}<td>{l.utwDate}</td><td>{l.webReg}</td><td>{l.workshop ? <span className="ld-ws">{l.workshop}</span> : "—"}</td><td>{caller(l)}</td><td>{cur}</td>
                    {Array.from({ length: nFu }, (_, i) => {
                      const f = F[i];
                      if (!f) return <td key={i} colSpan={5} className="ld-small">— not needed for this workshop</td>;
                      const s = state(f, now), dl = delay(f, now);
                      return (
                        <React.Fragment key={i}>
                          <td>{fmt(f.planned)}</td><td>{fmt(f.actual)}</td>
                          <td><span className={"ld-pill ld-pill-" + s}>{f.status || (f.skipped && !f.planned ? "—" : LBL[s])}</span></td>
                          <td><button type="button" className="link-btn" onClick={() => setModal({ l, n: i + 1, set })}>📝 Update Status</button></td>
                          <td className={dl ? "ld-bad" : ""}>{dl || "—"}</td>
                        </React.Fragment>
                      );
                    })}
                  </tr>
                );
              })}
              {!rows.length && <tr><td colSpan={baseCols + nFu * 5} className="empty-state">No Day {d} attendees{needle ? " match" : " yet"}.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
      {rows.length > lim && (
        <div className="ld-more"><span className="ld-small">Showing {lim} of {rows.length}</span>
          <button type="button" className="ld-btn" onClick={() => setLim(lim + 300)}>Show 300 more</button>
          <button type="button" className="ld-btn" onClick={() => setLim(rows.length)}>Show all</button></div>
      )}
    </div>
  );
}
