import React, { useEffect, useMemo, useState } from "react";
import { api } from "../api.js";
import { dealCounts, wsInfo } from "./leadUtils.js";

const isEmail = (x) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x);
// each pasted item is either a phone number (10+ digits) or an email address
const parse = (t) => [...new Set(t.split(/[\s,;]+/).filter((x) => isEmail(x) || x.replace(/\D/g, "").length >= 10))];

// "Paste the people who attended Day N" in two calm steps:
//   1. Check   — how many were found, how many are new, who was not found, which workshop they belong to
//   2. Share   — pick the team members and the ratio (2 : 1 : 1 …); the page shows exactly how many each person will get
// Nothing is saved until the last button.
export default function PasteAttendance({ d, cfg, workshops, workshop, toast, onDone }) {
  const [text, setText] = useState(""), [ws, setWs] = useState(workshop && !workshop.startsWith("__") ? workshop : "");
  const [check, setCheck] = useState(null), [busy, setBusy] = useState(false), [team, setTeam] = useState(null);
  const [rows, setRows] = useState([]), [keep, setKeep] = useState(false), [showMissing, setShowMissing] = useState(false);
  const entries = useMemo(() => parse(text), [text]);

  // follow the workshop chip at the top of the page
  useEffect(() => { if (workshop && !workshop.startsWith("__")) setWs(workshop); }, [workshop]);
  // a new paste / workshop / day means the old check no longer applies
  useEffect(() => { setCheck(null); setShowMissing(false); }, [text, ws, d]);
  useEffect(() => { api.ldTeam().then(setTeam).catch(() => setTeam([])); }, []);

  // people to choose from: everyone with a caller name. Start from what Settings → Automatic assignment says for this day;
  // a day that was never set up starts with every caller ticked, equal shares.
  useEffect(() => {
    if (!team) return;
    const people = team.filter((p) => p.active && p.leadName).filter((p, i, a) => a.findIndex((x) => x.leadName.toLowerCase() === p.leadName.toLowerCase()) === i);
    const saved = cfg?.assign?.queues?.["d" + d]?.people || [];
    setRows(people.map((p) => {
      const s = saved.find((x) => x.name.toLowerCase() === p.leadName.toLowerCase());
      return { name: p.leadName, role: p.role, on: s ? !!s.on && s.present !== false : saved.length ? false : p.role === "caller", share: s?.share || 1 };
    }).sort((a, b) => (b.on - a.on) || (a.role === "admin") - (b.role === "admin") || a.name.localeCompare(b.name)));
  }, [team, d]); // eslint-disable-line react-hooks/exhaustive-deps

  const edit = (name, patch) => setRows((r) => r.map((x) => (x.name === name ? { ...x, ...patch } : x)));
  const chosen = rows.filter((r) => r.on && r.share > 0);
  const total = check?.total || 0, counts = dealCounts(total, chosen), sum = chosen.reduce((a, p) => a + p.share, 0);
  const countOf = (name) => { const i = chosen.findIndex((p) => p.name === name); return i < 0 ? 0 : counts[i]; };

  const run = async (dryRun) => {
    setBusy(true);
    try {
      const body = { day: d, entries, workshop: ws, dryRun };
      if (!dryRun && !keep) body.assign = { people: chosen.map((p) => ({ name: p.name, share: p.share })) };
      const r = await api.ldPasteAttendance(body);
      if (dryRun) { setCheck(r); if (!r.total && !r.missing.length && !r.notInDays.length) toast("Nothing found in what you pasted", "bad"); return; }
      const parts = Object.entries(r.assigned || {}).map(([n, c]) => `${n} ${c}`).join(" · ");
      toast(`Day ${d}: ${r.marked} marked${parts ? " — " + parts : ""}${r.missing.length ? ` · ${r.missing.length} not found` : ""}`, r.missing.length ? "default" : "good");
      setText(""); setCheck(null);
      await onDone();
    } catch (e) { toast(e.message, "bad"); }
    setBusy(false);
  };

  const days = ws ? wsInfo(cfg, ws).days : null;
  const canGo = !!check && check.total > 0 && (keep || chosen.length > 0) && !busy;
  return (
    <div className="ld-panel" style={{ marginTop: 14 }}>
      <div className="ld-paste-head">
        <b>Step 1 · Paste Day {d} attendees</b>
        <span className="ld-small">phone numbers or emails, mixed is fine</span>
      </div>
      <textarea id="ld-paste" className="ld-textarea" rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder="9876543210, name@gmail.com, 9123456780 …" aria-label={`Day ${d} attendees`} />
      <div className="ld-row" style={{ marginTop: 8 }}>
        <label className="ld-small" htmlFor="ld-paste-ws">Which workshop?</label>
        <select id="ld-paste-ws" className="ld-input" style={{ maxWidth: 280 }} value={ws} onChange={(e) => setWs(e.target.value)}>
          <option value="">Any workshop — use their newest registration</option>
          {workshops.map((w) => <option key={w.name} value={w.name}>{w.name} · {wsInfo(cfg, w.name).days}-day</option>)}
        </select>
        <span className="ld-small">{entries.length ? <><b>{entries.length}</b> number{entries.length > 1 ? "s" : ""} / email{entries.length > 1 ? "s" : ""} found in the text</> : "Nothing pasted yet"}</span>
        <button type="button" className="ld-btn ld-btn-solid" disabled={!entries.length || busy} onClick={() => run(true)}>{busy && !check ? "Checking…" : "Check →"}</button>
      </div>
      {days && d > days && <div className="ld-callout bad" style={{ marginTop: 8 }}>⚠ {ws} runs only {days} day{days > 1 ? "s" : ""}, so Day {d} attendance can't be marked for it. Change its days in Settings → Workshops.</div>}
      <p className="ld-small" style={{ marginBottom: 0 }}>Someone who registered for more than one workshop is marked on the registration of the workshop you pick here.</p>

      {check && (
        <div className="ld-paste-result">
          <div className="ld-paste-head"><b>Check result</b></div>
          <div className="ld-chips-row">
            <span className="ld-pill ld-pill-done">✔ {check.total} found</span>
            {check.newly !== check.total && <span className="ld-pill ld-pill-wait">{check.already} already marked</span>}
            {check.other > 0 && <span className="ld-pill ld-pill-wait" title="Registered for a different workshop than the one picked — marked on their newest registration">{check.other} from another workshop</span>}
            {check.missing.length > 0 && <button type="button" className="ld-pill ld-pill-over ld-pillbtn" onClick={() => setShowMissing((v) => !v)}>{check.missing.length} not found {showMissing ? "▴" : "▾"}</button>}
            {check.notInDays.length > 0 && <span className="ld-pill ld-pill-over">{check.notInDays.length} skipped — workshop has no Day {d}</span>}
          </div>
          {showMissing && <p className="ld-small ld-missing">{check.missing.join(", ")}</p>}
          {check.notInDays.length > 0 && <p className="ld-small ld-missing">{check.notInDays.slice(0, 6).join(" · ")}{check.notInDays.length > 6 ? ` +${check.notInDays.length - 6} more` : ""}</p>}

          {check.total > 0 && (
            <>
              <div className="ld-paste-head" style={{ marginTop: 14 }}>
                <b>Step 2 · Who should call these {check.total} people?</b>
                <span className="ld-small">Share = ratio (2 gets twice as many as 1)</span>
              </div>
              <label className="ld-check"><input type="checkbox" checked={keep} onChange={(e) => setKeep(e.target.checked)} /> Don't change callers — each person stays with the caller who already has them</label>
              {!keep && (
                <>
                  <div className="ld-actions" style={{ margin: "4px 0 8px" }}>
                    <button type="button" className="ld-btn" onClick={() => setRows((r) => r.map((x) => ({ ...x, on: x.role !== "admin" })))}>All callers</button>
                    <button type="button" className="ld-btn" onClick={() => setRows((r) => r.map((x) => ({ ...x, share: 1 })))}>Equal shares</button>
                    <button type="button" className="ld-btn" onClick={() => setRows((r) => r.map((x) => ({ ...x, on: false })))}>Clear</button>
                  </div>
                  {team === null && <div className="ld-small">Loading team…</div>}
                  <div className="ld-deal">
                    {rows.map((r) => {
                      const n = countOf(r.name), pct = r.on && sum ? Math.round((r.share / sum) * 100) : 0;
                      return (
                        <div key={r.name} className={"ld-deal-row" + (r.on ? " on" : "")}>
                          <label className="ld-aq-who"><input type="checkbox" checked={r.on} onChange={(e) => edit(r.name, { on: e.target.checked })} /> <b>{r.name}</b>{r.role === "admin" && <span className="ld-small"> · admin</span>}</label>
                          {r.on ? (
                            <>
                              <span className="ld-stepper-n" role="group" aria-label={`Share for ${r.name}`}>
                                <button type="button" className="ld-btn" onClick={() => edit(r.name, { share: Math.max(1, r.share - 1) })} aria-label="Less">−</button>
                                <input className="ld-input ld-share" type="number" min="1" max="100" value={r.share} onChange={(e) => edit(r.name, { share: e.target.value === "" ? "" : Math.max(1, Math.min(100, +e.target.value)) })} onBlur={(e) => !(+e.target.value >= 1) && edit(r.name, { share: 1 })} />
                                <button type="button" className="ld-btn" onClick={() => edit(r.name, { share: Math.min(100, (+r.share || 0) + 1) })} aria-label="More">+</button>
                              </span>
                              <span className="ld-deal-bar" aria-hidden="true"><i style={{ width: pct + "%" }} /></span>
                              <span className="ld-deal-n"><b>{n}</b> <span className="ld-small">of {total} · {pct}%</span></span>
                            </>
                          ) : <span className="ld-small">not receiving</span>}
                        </div>
                      );
                    })}
                  </div>
                  <div className="ld-aq-ratio">{chosen.length
                    ? <>Ratio {chosen.map((p) => p.share).join(" : ")} → {chosen.map((p, i) => `${p.name} ${counts[i]}`).join(" · ")}</>
                    : <span className="ld-bad">Tick at least one person.</span>}</div>
                  <p className="ld-small">Calls someone has already started stay with that caller. Everyone else's Day {d} calls are dealt out as shown.</p>
                </>
              )}
            </>
          )}
          <div className="ld-actions" style={{ marginTop: 12 }}>
            <button type="button" className="ld-btn ld-btn-solid" disabled={!canGo} onClick={() => run(false)}>{busy ? "Saving…" : `Mark ${check.total} as Day ${d} attendees${keep ? "" : " & assign"}`}</button>
            <button type="button" className="ld-btn" disabled={busy} onClick={() => setCheck(null)}>Back</button>
          </div>
        </div>
      )}
    </div>
  );
}
