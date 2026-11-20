import React from "react";
import { Navigate, useParams } from "react-router-dom";
import Tasks from "./Tasks.jsx";

// Pending attendee calls of ONE workshop day (/attendee-followups/1 = Day 1, /2 = Day 2, /3 = Day 3).
// Each day is its own entry in the sidebar, so there are no Day tabs on the page itself.
export default function AttendeeFollowUps() {
  const { n } = useParams();
  const day = Math.floor(Number(n));
  if (!(day >= 1 && day <= 3)) return <Navigate to="/attendee-followups/1" replace />;
  return <Tasks view="attendees" day={day} />;
}
