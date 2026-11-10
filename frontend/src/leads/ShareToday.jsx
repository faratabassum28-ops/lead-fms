import React, { useEffect, useMemo, useState } from "react";
import { api } from "../api.js";
import { useLeads } from "./LeadsContext.jsx";
import { Panel } from "./ui.jsx";
import { tasksOf, stageWho } from "./leadUtils.js";

// Set once, runs by itself: every day at the chosen time today's calls are shared equally among the team.
// Tick who is in the team, mark anyone who is off today (that clears itself at midnight), and switch automatic sharing on.
export default function ShareToday() {
  const { leads, cfg, load, toast } = useLeads();
  const [st, setSt] = useState(null), [busy, setBusy] = useState(false);
  useEffect(() => { api.ldShare().then(setSt).catch((e) => toast(e.message, "bad")); }, []);
  const sod = new Date().setHours(0, 0, 0, 0), eod = new Date().setHours(23, 59, 59, 999);
  const todays = useMemo(() => tasksOf(leads, "", cfg).filter((t) => +new Date(t.f.planned) >= sod && +new Date(t.f.planned) <= eod), [leads, cfg, sod, eod]);
  const mine = (n) => todays.filter((t) => stageWho(t.l, t.set) === n.toLowerCase()).length;
  if (!st) return <Panel title="⚖️ Share calls equally, every day"><div className="ld-small">Loading…</div></Panel>;

  const save = async (patch, ok) => {
    setBusy(true);
    try { setSt(await api.ldSaveShare(patch)); await load(); if (ok) toast(ok, "good"); }
    catch (e) { toast(e.message, "bad"); }
    setBusy(false);
  };
  const inTeam = (n) => st.people.includes(n), off = (n) => st.off.includes(n);
  const working = st.people.filter((n) => !st.off.includes(n));
  const each = working.length ? Math.ceil(todays.length / working.length) : 0;
  const flip = (arr, n) => (arr.includes(n) ? arr.filter((x) => x !== n) : [...arr, n]);
  const when = (d) => new Date(d).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", hour12: true });
  const status = !st.auto ? "Automatic sharing is OFF — calls are only shared when you press “Share now”."
    : st.lastRun === st.today ? `Shared today${st.lastResult ? ` at ${when(st.lastResult.at)} — ${st.lastResult.moved} calls moved` : ""}. Next: tomorrow at ${st.time}.`
    : `Will share automatically today at ${st.time}.`;

  return (
    <Panel title="⚖️ Share calls equally, every day">
      <p className="ld-small" style={{ marginTop: 0 }}>Set it once. Every day, today's calls are dealt out evenly to the team below. Someone on leave? Press <b>Off today</b> — their calls move to the others straight away, and they are back in the team tomorrow without you doing anything.</p>
      <div className="sh-top">
        <label className="ld-check" style={{ margin: 0 }}><input type="checkbox" checked={st.auto} disabled={busy} onChange={(e) => save({ auto: e.target.checked }, e.target.checked ? "Automatic daily sharing is ON" : "Automatic sharing turned off")} /> <b>Share automatically every day at</b></label>
        <input className="ld-input" type="time" value={st.time} disabled={busy} onChange={(e) => e.target.value && save({ time: e.target.value })} aria-label="Time of day" />
        <button type="button" className="ld-btn ld-btn-solid" disabled={busy || !working.length || !todays.length} onClick={() => save({ runNow: true }, "Shared equally")}>{busy ? "Working…" : "Share now"}</button>
      </div>
      <div className={"ld-callout " + (st.auto ? "good" : "")} style={{ margin: "10px 0", background: st.auto ? undefined : "var(--panel-alt)" }}>{status}</div>
      <div className="sh-list">
        <div className="sh-row sh-head"><span>Person</span><span>Calls today</span><span>In the team</span><span>Today</span></div>
        {st.callers.map((n) => (
          <div key={n} className={"sh-row" + (!inTeam(n) || off(n) ? " dim" : "")}>
            <b>{n}</b>
            <span className="sh-n">{mine(n)}</span>
            <label className="ld-check" style={{ margin: 0 }}><input type="checkbox" checked={inTeam(n)} disabled={busy} onChange={() => save({ people: flip(st.people, n) })} /> In the team</label>
            {inTeam(n)
              ? <button type="button" className={"ld-btn" + (off(n) ? " ld-btn-remove" : "")} disabled={busy} onClick={() => save({ off: flip(st.off, n), runNow: st.auto && st.lastRun === st.today }, off(n) ? n + " is back today" : n + " is off today")}>{off(n) ? "Off today ✕ (tap to undo)" : "Off today"}</button>
              : <span className="ld-small">not in the team</span>}
          </div>
        ))}
        {!st.callers.length && <div className="ld-small">No callers yet — add them on the Team page.</div>}
      </div>
      <p className="ld-small" style={{ marginBottom: 0 }}>{todays.length} calls today · {working.length} people working{working.length && todays.length ? ` · about ${each} each` : ""}. New leads that arrive are shared among the same people.</p>
    </Panel>
  );
}
