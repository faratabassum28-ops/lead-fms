import React, { useEffect, useMemo, useState } from "react";
import PageHeader from "../../components/PageHeader.jsx";
import SearchInput from "../../components/SearchInput.jsx";
import TableSkeleton from "../../components/TableSkeleton.jsx";
import { usePolling } from "../../hooks/usePolling.js";
import { api } from "../../api.js";
import { useLeads } from "../LeadsContext.jsx";
import { downloadCsv, fmt } from "../leadUtils.js";

const rupees = (n) => "₹" + Number(n || 0).toLocaleString("en-IN", { maximumFractionDigits: 2 });
const OUT = {
  created: ["ld-pill-done", "New lead created"],
  matched: ["ld-pill-done", "Matched to a lead"],
  "no-contact": ["ld-pill-over", "No phone / email — add manually"],
};

// Every payment Razorpay reported (payment.captured / payment_link.paid), and what became of it.
export default function Payments() {
  const { openLead, leads } = useLeads();
  const [r, setR] = useState(null), [q, setQ] = useState("");
  const load = () => api.ldPayments().then(setR).catch(() => setR((p) => p || { rows: [], total: 0, noContact: 0 }));
  useEffect(() => { load(); }, []);
  usePolling(load, 30000);

  const byKey = useMemo(() => new Map((leads || []).map((l) => [l.key, l])), [leads]);
  const needle = q.trim().toLowerCase();
  const rows = (r?.rows || []).filter((x) => !needle || [x.name, x.phone, x.email, x.workshop, x.paymentId].join(" ").toLowerCase().includes(needle));
  return (
    <div className="page">
      <PageHeader title="Payments" subtitle="Live from Razorpay — each payment becomes a lead, or marks an existing lead as paid"
        meta={<div className="ld-actions">
          {r && <span className="chip"><strong>{r.rows.length}</strong> payments · <strong>{rupees(r.total)}</strong></span>}
          <button type="button" className="ld-btn" disabled={!rows.length} onClick={() => downloadCsv("payments.csv", [["Paid at", "Name", "Phone", "Email", "Workshop", "Amount", "Method", "Payment id", "Result"], ...rows.map((x) => [fmt(x.paidAt), x.name, x.phone, x.email, x.workshop, x.amount, x.method, x.paymentId, (OUT[x.outcome] || [])[1] || ""])])}>⬇ CSV</button>
        </div>} />
      {r?.noContact > 0 && <div className="ld-callout bad">⚠ {r.noContact} payment{r.noContact === 1 ? " has" : "s have"} no phone number or known email, so no lead could be made. Find the person in Razorpay and add them with <b>Leads → Add lead</b>.</div>}
      <div className="toolbar"><SearchInput value={q} onChange={setQ} placeholder="Search name, phone, email, workshop, payment id…" /></div>
      <div className="table-wrap">
        <table className="table">
          <thead><tr>{["Paid at", "Name", "Phone", "Email", "Workshop", "Amount", "Method", "Result", "Payment id"].map((h) => <th key={h}>{h}</th>)}</tr></thead>
          <tbody>
            {!r && <TableSkeleton columns={9} rows={8} />}
            {rows.map((x) => {
              const lead = byKey.get(x.leadKey), [cls, label] = OUT[x.outcome] || ["ld-pill-wait", x.outcome || "—"];
              return (
                <tr key={x._id}>
                  <td>{fmt(x.paidAt)}</td>
                  <td>{lead ? <button type="button" className="ld-namebtn" onClick={() => openLead(lead)} title="Open this lead"><b>{x.name}</b></button> : <b>{x.name}</b>}</td>
                  <td>{x.phone || "—"}</td><td>{x.email || "—"}</td>
                  <td>{x.workshop ? <span className="ld-ws">{x.workshop}</span> : "—"}</td>
                  <td><b>{rupees(x.amount)}</b></td><td>{x.method || "—"}</td>
                  <td><span className={"ld-pill " + cls}>{label}</span></td>
                  <td className="ld-small">{x.paymentId}</td>
                </tr>
              );
            })}
            {r && !rows.length && <tr><td colSpan={9} className="empty-state">{r.rows.length ? "No payment matches your search." : "No payments yet — they appear here the moment Razorpay reports them."}</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
