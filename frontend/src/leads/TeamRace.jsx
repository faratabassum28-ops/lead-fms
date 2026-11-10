import React, { useCallback, useEffect, useState } from "react";
import { api } from "../api.js";
import { useAuth } from "../context/AuthContext.jsx";
import { usePolling } from "../hooks/usePolling.js";
import { useLeads } from "./LeadsContext.jsx";

const tone = (p) => (p >= 100 ? "full" : p >= 67 ? "high" : p >= 34 ? "mid" : "low");

// Live "who is ahead today" strip on Today Follow-ups: just every person's name and a bar that fills as they finish calls,
// so everyone can see at a glance how the others are doing. No heading, no phone numbers, no lead details.
// Updates every 15 s, and instantly after you save one of your own calls.
export default function TeamRace() {
  const { tick } = useLeads();
  const { leadName } = useAuth();
  const [d, setD] = useState(null);
  const load = useCallback(() => api.ldProgress().then(setD).catch(() => {}), []);
  useEffect(() => { load(); }, [load, tick]);
  usePolling(load, 15000);
  if (!d || !d.rows.length) return null;
  const me = (leadName || "").toLowerCase();
  return (
    <section className="ld-race2" aria-label="Today's team progress">
      {d.rows.map((r) => (
        <div key={r.name} className={"ld-r2" + (r.name.toLowerCase() === me ? " me" : "")}
          title={`${r.name}: ${r.done} of ${r.total} calls done · ${r.connected} connected`}>
          <span className="ld-r2-name">{r.name}</span>
          <span className="ld-track ld-r2-track" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={r.pct}>
            <i className={"ld-race-fill ld-race-" + tone(r.pct)} style={{ width: Math.max(r.pct, r.done ? 4 : 0) + "%" }} />
          </span>
          <span className="ld-r2-n">{r.pct >= 100 ? "✓" : `${r.done}/${r.total}`}</span>
        </div>
      ))}
    </section>
  );
}
