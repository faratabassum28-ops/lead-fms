import React, { useEffect, useMemo, useState } from "react";
import PageHeader from "../../components/PageHeader.jsx";
import SearchInput from "../../components/SearchInput.jsx";
import TableSkeleton from "../../components/TableSkeleton.jsx";
import { usePolling } from "../../hooks/usePolling.js";
import { api } from "../../api.js";
import { useLeads } from "../LeadsContext.jsx";
import { downloadCsv, fmt } from "../leadUtils.js";

const rupees = (n) => "₹" + Number(n || 0).toLocaleString("en-IN", { maximumFractionDigits: 2 });
const OUT = { created: ["ld-pill-done", "New lead · FU1"], matched: ["ld-pill-wait", "Existing lead · marked Paid"] };

// Every new booking from the "New Order FMS" sheet. A new person becomes a Paid lead in FU1; someone who is already a lead is marked Paid.
export default function Bookings() {
  const { openLead, leads } = useLeads();
  const [r, setR] = useState(null), [q, setQ] = useState(""), [prog, setProg] = useState("");
  const load = () => api.ldBookings().then(setR).catch(() => setR((p) => p || { rows: [], total: 0 }));
  useEffect(() => { load(); }, []);
  usePolling(load, 30000);

  const byKey = useMemo(() => new Map((leads || []).map((l) => [l.key, l])), [leads]);
  const programs = useMemo(() => [...new Set((r?.rows || []).map((x) => x.program).filter(Boolean))].sort(), [r]);
  const needle = q.trim().toLowerCase();
  const rows = (r?.rows || []).filter((x) => (!prog || x.program === prog) && (!needle || [x.name, x.phone, x.email, x.program, x.via].join(" ").toLowerCase().includes(needle)));
  const fu1 = (lead) => { const f = lead?.fus?.[0]; return !lead ? "—" : !f ? "—" : f.actual ? `Done · ${f.status || "called"}` : "Due now"; };
  const head = ["Booked at", "Name", "Phone", "Email", "Program", "Amount", "Paid through", "Caller", "FU1", "Result"];
  return (
    <div className="page">
      <PageHeader title="New Bookings" subtitle="Every new booking from the order sheet — each one starts in FU1 for the assigned caller"
        meta={<div className="ld-actions">
          {r && <span className="chip"><strong>{rows.length}</strong> bookings · <strong>{rupees(rows.reduce((s, x) => s + (x.amount || 0), 0))}</strong></span>}
          <button type="button" className="ld-btn" disabled={!rows.length} onClick={() => downloadCsv("new-bookings.csv", [head, ...rows.map((x) => [fmt(x.ts), x.name, x.phone, x.email, x.program, x.amount, x.via, byKey.get(x.leadKey)?.assignedTo || "", fu1(byKey.get(x.leadKey)), (OUT[x.outcome] || [])[1] || ""])])}>⬇ CSV</button>
        </div>} />
      <div className="toolbar">
        <SearchInput value={q} onChange={setQ} placeholder="Search name, phone, email, program…" />
        {programs.length > 1 && <select className="ld-input ld-narrow" value={prog} onChange={(e) => setProg(e.target.value)}><option value="">All programs</option>{programs.map((p) => <option key={p}>{p}</option>)}</select>}
      </div>
      <div className="table-wrap">
        <table className="table">
          <thead><tr>{head.map((h) => <th key={h}>{h}</th>)}</tr></thead>
          <tbody>
            {!r && <TableSkeleton columns={head.length} rows={8} />}
            {rows.map((x) => {
              const lead = byKey.get(x.leadKey), [cls, label] = OUT[x.outcome] || ["ld-pill-wait", x.outcome || "—"];
              return (
                <tr key={x._id}>
                  <td>{fmt(x.ts)}</td>
                  <td>{lead ? <button type="button" className="ld-namebtn" onClick={() => openLead(lead)} title="Open this lead"><b>{x.name}</b></button> : <b>{x.name}</b>}</td>
                  <td>{x.phone || "—"}</td><td>{x.email || "—"}</td>
                  <td>{x.program ? <span className="ld-ws">{x.program}</span> : "—"}</td>
                  <td><b>{rupees(x.amount)}</b></td><td>{x.via || "—"}</td>
                  <td>{lead?.assignedTo || "—"}</td>
                  <td>{fu1(lead)}</td>
                  <td><span className={"ld-pill " + cls}>{label}</span></td>
                </tr>
              );
            })}
            {r && !rows.length && <tr><td colSpan={head.length} className="empty-state">{r.rows.length ? "No booking matches your search." : "No bookings yet — a new booking in the order sheet appears here within a minute."}</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
