// One-time clean-up: for every lead, in every follow-up track (Lead FU1-3, Day 1 / 2 / 3 FU1-3), once a call was saved
// as "Connected", the steps AFTER it that were never called are closed (skipped) — the same rule the app now applies
// to new calls. Calls already made are never touched. Each track is handled on its own.
//
//   npm run close:connected -- --dry     only COUNT what would be closed (nothing is written)
//   npm run close:connected              close them
//
// Safe to re-run: steps that are already closed or called are left alone.
import "dotenv/config";
import mongoose from "mongoose";
import { Lead } from "./models/Lead.js";

const dry = process.argv.includes("--dry");
const SETS = ["fus", "d1Fus", "d2Fus", "d3Fus"];

await mongoose.connect(process.env.MONGO_URI || "mongodb://127.0.0.1:27017/lead_fms", { serverSelectionTimeoutMS: 10_000 });

let leads = 0, steps = 0, ops = [];
for await (const l of Lead.find({}, SETS.join(" ")).lean().cursor()) {
  const $set = {};
  for (const set of SETS) {
    const arr = l[set] || [];
    const first = arr.findIndex((f) => f.actual && f.status === "Connected"); // the first Connected call in this track
    if (first < 0) continue;
    arr.forEach((f, i) => {
      if (i > first && !f.actual && !f.skipped) { $set[`${set}.${i}.skipped`] = true; steps++; }
    });
  }
  if (Object.keys($set).length) { leads++; if (!dry) ops.push({ updateOne: { filter: { _id: l._id }, update: { $set } } }); }
  if (ops.length >= 500) await Lead.bulkWrite(ops.splice(0));
}
if (ops.length) await Lead.bulkWrite(ops);

console.log(dry ? `DRY RUN — would close ${steps} pending follow-up(s) on ${leads} lead(s). Nothing was changed.` : `Closed ${steps} pending follow-up(s) on ${leads} lead(s).`);
await mongoose.disconnect();
