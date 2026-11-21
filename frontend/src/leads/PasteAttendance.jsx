import React, { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api.js";
import { dealCounts, downloadCsv, wsInfo } from "./leadUtils.js";
import { TEMPLATE_HEADER, TEMPLATE_ROWS, chunk, dealNames, extractEntries, parseFile, parseText } from "./attendanceParse.js";

const CHECK_CHUNK = 1000; // numbers checked per request
const SAVE_CHUNK = 300; // leads marked per request
const n0 = (n) => Number(n || 0).toLocaleString("en-IN");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// a request that fails on a shaky connection is tried again twice before we give up on it
async function retry(fn, tries = 3) {
  for (let i = 0; ; i++) {
    try { return await fn(); } catch (e) { if (i >= tries - 1 || !e.network) throw e; await sleep(1200 * (i + 1)); }
  }
}

const SOURCES = [["paste", "📋 Paste"], ["file", "📄 Upload file"], ["sheet", "🔗 Google Sheet link"]];

// "Mark the people who attended Day N" in three calm steps:
//   1. Load   — paste them, upload a CSV / Excel file, or give a Google Sheet link (thousands are fine)
//   2. Check  — how many were found, how many are new, who was not found, which workshop they belong to
//   3. Share  — pick the team members and the ratio (2 : 1 : 1 …); the page shows exactly how many each person will get
// Nothing is saved until the last button, and big lists are saved in small batches with a progress bar.
export default function PasteAttendance({ d, cfg, workshops, workshop, toast, onDone }) {
  const [src, setSrc] = useState("paste"), [text, setText] = useState(""), [file, setFile] = useState(null), [sheetUrl, setSheetUrl] = useState(() => { try { return localStorage.getItem("attSheetUrl") || ""; } catch { return ""; } });
  const [loaded, setLoaded] = useState(null); // result of the file / sheet: { label, ...extractEntries() }
  const [ws, setWs] = useState(workshop && !workshop.startsWith("__") ? workshop : "");
  const [check, setCheck] = useState(null), [busy, setBusy] = useState(false), [prog, setProg] = useState(null), [team, setTeam] = useState(null);
  const [rows, setRows] = useState([]), [keep, setKeep] = useState(false), [showMissing, setShowMissing] = useState(false), [finished, setFinished] = useState(null), [showHelp, setShowHelp] = useState(false), [addNew, setAddNew] = useState(true);
  const run = useRef(0), doneIds = useRef(new Set()), fileInput = useRef(null), checkRef = useRef(null);

  const pasted = useMemo(() => (src === "paste" && text.trim() ? parseText(text) : null), [src, text]);
  const list = src === "paste" ? pasted : loaded;
  const entries = list?.entries || [];

  // follow the workshop chip at the top of the page
  useEffect(() => { if (workshop && !workshop.startsWith("__")) setWs(workshop); }, [workshop]);
  // a new list / workshop / day means the old check no longer applies (and any check still running is dropped)
  useEffect(() => { run.current++; doneIds.current = new Set(); setCheck(null); setShowMissing(false); setBusy(false); setProg(null); }, [list, ws, d]);
  // the list is checked by itself as soon as it is loaded (pasted text: a moment after the typing stops) — no extra button
  useEffect(() => {
    if (!entries.length) return undefined;
    const t = setTimeout(() => checkRef.current?.(), src === "paste" ? 800 : 60);
    return () => clearTimeout(t);
  }, [list, ws, d]); // eslint-disable-line react-hooks/exhaustive-deps
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
  // people in the list who are not registered anywhere yet: every identifier they gave came back "not found"
  const newPeople = useMemo(() => {
    if (!check || !list?.people) return [];
    const miss = new Set(check.missing);
    return list.people.filter((p) => p.ids.every((i) => miss.has(i)));
  }, [check, list]);
  const nNew = addNew ? newPeople.length : 0;
  const total = (check?.total || 0) + nNew, counts = dealCounts(total, chosen), sum = chosen.reduce((a, p) => a + p.share, 0);
  const countOf = (name) => { const i = chosen.findIndex((p) => p.name === name); return i < 0 ? 0 : counts[i]; };

  // ---- loading a list ----
  const pickFile = async (f) => {
    if (!f) return;
    setBusy(true); setLoaded(null); setFile(f.name);
    try { const r = await parseFile(f); setLoaded({ ...r, label: f.name }); if (!r.entries.length) toast("No phone numbers or emails found in that file", "bad"); }
    catch (e) { toast(e.message, "bad"); setFile(null); }
    setBusy(false);
  };
  const loadSheet = async () => {
    setBusy(true); setLoaded(null);
    try {
      const r = await api.ldAttendanceSheet(sheetUrl.trim());
      try { localStorage.setItem("attSheetUrl", sheetUrl.trim()); } catch { /* private mode: fine */ }
      const x = extractEntries(r.rows || []); setLoaded({ ...x, label: "Google Sheet" });
      if (!x.entries.length) toast("The sheet was read, but no phone numbers or emails were found in it", "bad");
    } catch (e) { toast(e.message, "bad"); }
    setBusy(false);
  };
  const switchSrc = (k) => { setSrc(k); setLoaded(null); setFile(null); };
  const downloadTemplate = () => downloadCsv("attendance-upload-template.csv", [TEMPLATE_HEADER, ...TEMPLATE_ROWS]);
  const copyTemplate = async () => {
    try { await navigator.clipboard.writeText([TEMPLATE_HEADER, ...TEMPLATE_ROWS].map((r) => r.join("\t")).join("\n")); toast("Template copied — open a new Google Sheet, click cell A1 and paste", "good"); }
    catch { toast("Could not copy — use “Download template” instead", "bad"); }
  };

  // ---- step 1: check (in chunks of 1,000) ----
  const doCheck = async () => {
    const my = ++run.current;
    setBusy(true); setFinished(null); setProg({ done: 0, total: entries.length, label: "Checking" });
    const agg = { total: 0, already: 0, other: 0, missing: [], notInDays: [], picked: [], seen: new Set() };
    try {
      let done = 0;
      for (const part of chunk(entries, CHECK_CHUNK)) {
        const r = await retry(() => api.ldPasteAttendance({ day: d, entries: part, workshop: ws, dryRun: true }));
        if (my !== run.current) return; // the list / workshop changed while checking
        for (const [id, f] of r.picked) { if (agg.seen.has(id)) continue; agg.seen.add(id); agg.picked.push([id, f]); if (f & 1) agg.already++; if (f & 2) agg.other++; }
        agg.missing.push(...r.missing); agg.notInDays.push(...r.notInDays);
        done += part.length; setProg({ done, total: entries.length, label: "Checking" });
      }
      const res = { total: agg.picked.length, already: agg.already, newly: agg.picked.length - agg.already, other: agg.other, missing: agg.missing, notInDays: agg.notInDays, picked: agg.picked };
      setCheck(res);
      if (!res.total && !res.missing.length && !res.notInDays.length) toast("Nothing found in this list", "bad");
    } catch (e) { if (my === run.current) toast(e.message, "bad"); }
    if (my === run.current) { setBusy(false); setProg(null); }
  };

  checkRef.current = doCheck;

  // ---- step 3: save (in batches of 300, each lead told exactly which caller it gets) ----
  const doSave = async () => {
    const my = ++run.current;
    setBusy(true);
    const picked = check.picked, people = addNew ? newPeople : [], grand = picked.length + people.length;
    // everyone who can be dealt (found people whose calls have not started + all the new people) gets one caller, by the ratio
    const dealable = picked.filter(([, f]) => !(f & 4)).map(([id]) => id), allKeys = [...dealable, ...people.map((p) => "p:" + p.ids[0])];
    const names = keep ? [] : dealNames(allKeys.length, chosen), dealt = {};
    allKeys.forEach((k, i) => { if (names[i]) dealt[k] = names[i]; });
    const todoIds = picked.map(([id]) => id).filter((id) => !doneIds.current.has(id)), todoNew = people.filter((p) => !doneIds.current.has("p:" + p.ids[0])), given = {};
    let created = 0, skipped = 0;
    setProg({ done: doneIds.current.size, total: grand, label: "Saving" });
    const merge = (r) => { created += r.created || 0; skipped += r.skipped || 0; for (const [k, v] of Object.entries(r.assigned || {})) given[k] = (given[k] || 0) + v; };
    try {
      for (const part of chunk(todoIds, SAVE_CHUNK)) {
        const sub = {}; part.forEach((id) => { if (dealt[id]) sub[id] = dealt[id]; });
        merge(await retry(() => api.ldPasteAttendance({ day: d, ids: part, dealt: sub, keep, workshop: ws }), 4));
        part.forEach((id) => doneIds.current.add(id));
        setProg({ done: doneIds.current.size, total: grand, label: "Saving" });
      }
      for (const part of chunk(todoNew, 200)) {
        const create = part.map((p) => ({ name: p.name, phone: p.phone, email: p.email, to: dealt["p:" + p.ids[0]] || "" }));
        merge(await retry(() => api.ldPasteAttendance({ day: d, create, keep, workshop: ws }), 4));
        part.forEach((p) => doneIds.current.add("p:" + p.ids[0]));
        setProg({ done: doneIds.current.size, total: grand, label: "Saving" });
      }
      const res = { marked: doneIds.current.size - skipped, created, given, missing: addNew ? [] : check.missing, notInDays: check.notInDays, day: d };
      doneIds.current = new Set();
      const parts = Object.entries(given).map(([n, c]) => `${n} ${n0(c)}`).join(" · ");
      toast(`Day ${d}: ${n0(res.marked)} marked${created ? ` (${n0(created)} new)` : ""}${parts ? " — " + parts : ""}`, "good");
      setFinished(res); setText(""); setLoaded(null); setFile(null); setCheck(null);
      await onDone();
    } catch (e) {
      toast(`${e.message}. ${n0(doneIds.current.size)} of ${n0(grand)} saved — press the button again to continue with the remaining ${n0(grand - doneIds.current.size)}.`, "bad");
    }
    if (my === run.current) { setBusy(false); setProg(null); }
    else setBusy(false);
  };

  const days = ws ? wsInfo(cfg, ws).days : null;
  const resumed = doneIds.current.size > 0 && !!check;
  const needWs = nNew > 0 && !ws, canGo = !!check && total > 0 && (keep || chosen.length > 0) && !needWs && !busy;
  const sheetOk = /^https:\/\/docs\.google\.com\/spreadsheets\/d\/[\w-]+/.test(sheetUrl.trim());
  const pct = prog && prog.total ? Math.min(100, Math.round((prog.done / prog.total) * 100)) : 0;

  return (
    <div className="ld-panel" style={{ marginTop: 14 }}>
      <div className="ld-paste-head">
        <b>Step 1 · Add Day {d} attendees</b>
        <span className="ld-small">paste them, upload a CSV / Excel file, or use a Google Sheet link — phone numbers or emails, mixed is fine</span>
      </div>

      <div className="range-pills" role="tablist" style={{ margin: "0 0 10px" }}>
        {SOURCES.map(([k, v]) => <button key={k} type="button" role="tab" aria-selected={src === k} className={"range-pill" + (src === k ? " range-pill-active" : "")} onClick={() => switchSrc(k)} disabled={busy}>{v}</button>)}
      </div>

      {src === "paste" && (
        <textarea id="ld-paste" className="ld-textarea" rows={3} value={text} onChange={(e) => { setText(e.target.value); setFinished(null); }} placeholder="9876543210, name@gmail.com, 9123456780 …   (or copy a whole column from Google Sheets and paste it here)" aria-label={`Day ${d} attendees`} />
      )}
      {src === "file" && (
        <div className="ld-drop" onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); pickFile(e.dataTransfer.files?.[0]); }}>
          <input ref={fileInput} type="file" accept=".csv,.tsv,.txt,.xlsx,.xlsm,text/csv" hidden onChange={(e) => { pickFile(e.target.files?.[0]); e.target.value = ""; }} />
          <button type="button" className="ld-btn ld-btn-solid" onClick={() => fileInput.current?.click()} disabled={busy}>Choose a file…</button>
          <span className="ld-small">{file ? <>Selected: <b>{file}</b></> : "or drop a .csv / .xlsx file here — the file can have thousands of rows"}</span>
        </div>
      )}
      {src === "sheet" && (
        <div className="ld-row">
          <input className="ld-input" style={{ flex: "1 1 360px", maxWidth: 620 }} value={sheetUrl} onChange={(e) => { setSheetUrl(e.target.value); setLoaded(null); }} placeholder="https://docs.google.com/spreadsheets/d/…/edit#gid=0" aria-label="Google Sheet link" />
          <button type="button" className="ld-btn ld-btn-solid" disabled={!sheetOk || busy} onClick={loadSheet}>{busy && !loaded ? "Reading sheet…" : "Read sheet →"}</button>
        </div>
      )}

      {src === "sheet" && <p className="ld-small" style={{ margin: "6px 0 0" }}>The sheet must be shared as <b>Share → General access → Anyone with the link → Viewer</b>. The tab named in the link (its <code>gid</code>) is the one that is read.</p>}

      {/* what was found in the list */}
      {list && (
        <div className="ld-src-sum">
          <div className="ld-chips-row">
            <span className={"ld-pill " + (entries.length ? "ld-pill-done" : "ld-pill-over")}>{entries.length ? "✔" : "✖"} {n0(entries.length)} unique number{entries.length === 1 ? "" : "s"} / email{entries.length === 1 ? "" : "s"}</span>
            {list.label && <span className="ld-small">from {list.label} · {n0(list.rowCount)} row{list.rowCount === 1 ? "" : "s"}</span>}
            {list.dupes > 0 && <span className="ld-pill ld-pill-wait">{n0(list.dupes)} repeated (ignored)</span>}
            {list.invalid.length > 0 && <span className="ld-pill ld-pill-over" title={list.invalid.slice(0, 12).join(", ")}>{n0(list.invalid.length)} not valid phone numbers (skipped)</span>}
          </div>
          {list.hadHeader
            ? <p className="ld-small" style={{ margin: "4px 0 0" }}>Using column{list.columns.phone.length + list.columns.email.length > 1 ? "s" : ""}: <b>{[...list.columns.phone, ...list.columns.email].join(", ")}</b></p>
            : list.rowCount > 1 && <p className="ld-small" style={{ margin: "4px 0 0" }}>No “Phone” / “Email” heading found, so every cell was scanned for numbers and emails. For a cleaner result use the template below.</p>}
          {list.sci.length > 0 && <div className="ld-callout bad" style={{ marginTop: 8 }}>⚠ {n0(list.sci.length)} phone value{list.sci.length > 1 ? "s look" : " looks"} like <b>{list.sci[0]}</b> — Excel / Sheets shortened the number and the real digits are lost. In the sheet select the Phone column → Format → Number → <b>Plain text</b>, enter the numbers again and re-upload.</div>}
          {entries.length > 0 && <p className="ld-small ld-missing" style={{ marginBottom: 0 }}>Preview: {entries.slice(0, 5).join(" · ")}{entries.length > 5 ? " …" : ""}</p>}
        </div>
      )}

      <div className="ld-row" style={{ marginTop: 8 }}>
        <label className="ld-small" htmlFor="ld-paste-ws">Which workshop?</label>
        <select id="ld-paste-ws" className="ld-input" style={{ maxWidth: 280 }} value={ws} onChange={(e) => setWs(e.target.value)} disabled={busy}>
          <option value="">Any workshop — use their newest registration</option>
          {workshops.map((w) => <option key={w.name} value={w.name}>{w.name} · {wsInfo(cfg, w.name).days}-day</option>)}
        </select>
        <span className="ld-small">{busy && prog?.label === "Checking" ? `Checking… ${pct}%` : entries.length ? "Checked automatically" : "Load a list to start"}</span>
      </div>
      {busy && prog?.label === "Checking" && <div className="ld-prog" aria-label="Checking progress"><i style={{ width: pct + "%" }} /></div>}
      {days && d > days && <div className="ld-callout bad" style={{ marginTop: 8 }}>⚠ {ws} runs only {days} day{days > 1 ? "s" : ""}, so Day {d} attendance can't be marked for it. Change its days in Settings → Workshops.</div>}
      <p className="ld-small" style={{ marginBottom: 0 }}>Someone who registered for more than one workshop is marked on the registration of the workshop you pick here.</p>

      {/* template + how-to */}
      <div className="ld-actions" style={{ marginTop: 8 }}>
        <button type="button" className="ld-btn" onClick={downloadTemplate}>⬇ Download template (.csv)</button>
        <button type="button" className="ld-btn" onClick={copyTemplate}>📋 Copy template for Google Sheets</button>
        <button type="button" className="ld-btn" onClick={() => setShowHelp((v) => !v)}>{showHelp ? "Hide" : "How to upload a sheet"} {showHelp ? "▴" : "▾"}</button>
      </div>
      {showHelp && (
        <div className="ld-howto">
          <b>The sheet needs just two things</b>
          <ul>
            <li>A <b>Phone</b> column and/or an <b>Email</b> column (either one is enough; use the template headings or anything with “phone”, “mobile”, “whatsapp” or “email” in it). Other columns such as Name are ignored.</li>
            <li>One person per row. The same person twice, or a mix of phone and email for the same person, is fine — they are counted once.</li>
            <li>Phone numbers can be written 9876543210, +91 98765 43210 or 98765-43210. Format the Phone column as <b>Plain text</b> so Excel does not turn long numbers into 9.87E+09.</li>
          </ul>
          <b>Three ways to load it</b>
          <ol>
            <li><b>Google Sheet link</b> — Share → <i>Anyone with the link</i> (Viewer) → copy link → paste in “Google Sheet link” → <i>Read sheet</i>.</li>
            <li><b>Upload file</b> — in Google Sheets: File → Download → <i>Comma-separated values (.csv)</i> (or Microsoft Excel .xlsx) → choose it under “Upload file”.</li>
            <li><b>Paste</b> — select the Phone column in the sheet, copy, paste into the box.</li>
          </ol>
          <b>Then</b> the list is checked automatically. Choose the callers &amp; ratio in Step 2 and press <i>Submit</i>. People who are not registered yet are added as new attendees (tick the option to turn this off). Nothing is saved before you press Submit.
        </div>
      )}

      {finished && !check && (
        <div className="ld-callout good" style={{ marginTop: 12 }}>
          ✔ Day {finished.day}: <b>{n0(finished.marked)}</b> marked as attended{finished.created > 0 ? <> ({n0(finished.created)} new)</> : ""}{Object.keys(finished.given).length ? <> — {Object.entries(finished.given).map(([n, c]) => `${n} ${n0(c)}`).join(" · ")}</> : ""}.
          {finished.missing.length > 0 && <> {n0(finished.missing.length)} not found <button type="button" className="link-btn" onClick={() => downloadCsv(`day${finished.day}-not-found.csv`, [["Phone / Email not found"], ...finished.missing.map((x) => [x])])}>⬇ download list</button></>}
        </div>
      )}

      {check && (
        <div className="ld-paste-result">
          <div className="ld-paste-head"><b>Result</b></div>
          <div className="ld-chips-row">
            <span className="ld-pill ld-pill-done">✔ {n0(check.total)} already registered</span>
            {check.newly !== check.total && <span className="ld-pill ld-pill-wait">{n0(check.already)} already marked</span>}
            {check.other > 0 && <span className="ld-pill ld-pill-wait" title="Registered for a different workshop than the one picked — marked on their newest registration">{n0(check.other)} from another workshop</span>}
            {newPeople.length > 0 && <span className={"ld-pill " + (addNew ? "ld-pill-done" : "ld-pill-over")}>{n0(newPeople.length)} new {addNew ? "— will be added" : "— not registered, skipped"}</span>}
            {check.missing.length > 0 && <button type="button" className="ld-pill ld-pill-wait ld-pillbtn" onClick={() => setShowMissing((v) => !v)}>{n0(check.missing.length)} numbers / emails not in the system {showMissing ? "▴" : "▾"}</button>}
            {check.notInDays.length > 0 && <span className="ld-pill ld-pill-over">{n0(check.notInDays.length)} skipped — workshop has no Day {d}</span>}
          </div>
          {showMissing && (
            <p className="ld-small ld-missing">{check.missing.slice(0, 200).join(", ")}{check.missing.length > 200 ? ` … +${n0(check.missing.length - 200)} more` : ""}{" "}
              <button type="button" className="link-btn" onClick={() => downloadCsv(`day${d}-not-found.csv`, [["Phone / Email not found"], ...check.missing.map((x) => [x])])}>⬇ download full list</button></p>
          )}
          {check.notInDays.length > 0 && <p className="ld-small ld-missing">{check.notInDays.slice(0, 6).join(" · ")}{check.notInDays.length > 6 ? ` +${n0(check.notInDays.length - 6)} more` : ""}</p>}

          {newPeople.length > 0 && (
            <>
              <label className="ld-check" style={{ marginTop: 8 }}><input type="checkbox" checked={addNew} onChange={(e) => setAddNew(e.target.checked)} /> Add the {n0(newPeople.length)} people who are not registered yet as new Day {d} attendees (they go to Attendee follow-ups only)</label>
              {needWs && <div className="ld-callout bad" style={{ marginTop: 6 }}>⚠ Choose the workshop above first — new attendees are added under it.</div>}
            </>
          )}

          {total > 0 && (
            <>
              <div className="ld-paste-head" style={{ marginTop: 14 }}>
                <b>Step 2 · Who should call these {n0(total)} people?</b>
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
                      const n = countOf(r.name), pc = r.on && sum ? Math.round((r.share / sum) * 100) : 0;
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
                              <span className="ld-deal-bar" aria-hidden="true"><i style={{ width: pc + "%" }} /></span>
                              <span className="ld-deal-n"><b>{n0(n)}</b> <span className="ld-small">of {n0(total)} · {pc}%</span></span>
                            </>
                          ) : <span className="ld-small">not receiving</span>}
                        </div>
                      );
                    })}
                  </div>
                  <div className="ld-aq-ratio">{chosen.length
                    ? <>Ratio {chosen.map((p) => p.share).join(" : ")} → {chosen.map((p, i) => `${p.name} ${n0(counts[i])}`).join(" · ")}</>
                    : <span className="ld-bad">Tick at least one person.</span>}</div>
                  <p className="ld-small">Calls someone has already started stay with that caller. Everyone else's Day {d} calls are dealt out as shown.</p>
                </>
              )}
            </>
          )}
          <div className="ld-actions" style={{ marginTop: 12 }}>
            <button type="button" className="ld-btn ld-btn-solid" disabled={!canGo} onClick={doSave}>
              {busy && prog?.label === "Saving" ? `Saving… ${pct}%` : resumed ? `Continue saving (${n0(total - doneIds.current.size)} left)` : `Submit · mark ${n0(total)} as Day ${d} attendees${keep ? "" : " & assign"}`}
            </button>
          </div>
          {busy && prog?.label === "Saving" && (
            <>
              <div className="ld-prog" aria-label="Saving progress"><i style={{ width: pct + "%" }} /></div>
              <p className="ld-small" style={{ margin: "4px 0 0" }}>{n0(prog.done)} of {n0(prog.total)} saved — keep this page open until it finishes.</p>
            </>
          )}
        </div>
      )}
    </div>
  );
}
