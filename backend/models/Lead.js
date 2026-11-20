import mongoose from "mongoose";

// Lead FMS data — replaces the Google-Sheet lead tracker.
// People are NOT stored here: callers and admins are User accounts (see models/User.js).

const { Schema } = mongoose;

// One follow-up call: planned time, when it was actually done, the outcome, a note.
const Fu = new Schema(
  { skipped: Boolean, planned: Date, actual: Date, status: String, note: String, callbackAt: Date },
  { _id: false }
);

// One line of a lead's story: how it came in, who it was assigned to (and how), attendance, edits.
// Calls are NOT stored here — they come from the Activity collection, which keeps every update forever.
const Trail = new Schema({ at: Date, type: String, text: String, by: String }, { _id: false });

const LeadSchema = new Schema(
  {
    key: { type: String, unique: true }, // one lead = one REGISTRATION. First registration: the phone number; a later one by the same person: "<phone>#<timestamp>"
    ts: Date, // when the lead came in
    sheetSeenTs: Date, // the newest sheet row (Timestamp) already applied to this lead: a LATER row for the same phone = the person enquired again
    name: String,
    email: String,
    emailKey: { type: String, index: true }, // trimmed + lower-cased email: the sheet import / attendance match leads by it too
    phone: String,
    phone10: { type: String, index: true }, // last 10 digits: matches 98xxxxxxxx and 9198xxxxxxxx
    utwDate: String,
    workshop: { type: String, index: true }, // typed in the sheet's "Workshop Name" column
    assignedTo: { type: String, index: true }, // caller name (Lead Qualification)
    assignedBy: String, // how assignedTo was set: "auto" (Settings) | "sheet" (Assigned To column) | "manual" (an admin)
    assignedAt: Date,
    d1By: String, d2By: String, d3By: String, // how d1Assigned / d2Assigned / d3Assigned were set ("auto" | "manual" | "paste")
    trail: [Trail],
    d1Assigned: String, // optional separate caller for the Day 1 follow-ups
    d2Assigned: String, // ... and Day 2
    d3Assigned: String, // ... and Day 3 (3-day workshops)
    locked: Boolean, // manually assigned: a sheet re-import never changes the caller
    level: String,
    profession: String,
    city: String,
    webReg: String,
    // Razorpay: set when a captured payment is matched to (or creates) this lead
    paid: { type: Boolean, index: true },
    paidAt: Date,
    paidAmount: Number, // total in rupees across all payments
    payIds: [String], // Razorpay payment ids already counted (makes re-delivered webhooks harmless)
    payMethod: String,
    bookingRefs: [String], // booking-sheet rows already applied to this lead (a row is never applied twice)
    nameGuess: Boolean, // the name was guessed from the email — a later event with the real name replaces it
    // AiSensy: the "we just connected" WhatsApp is sent once per lead
    waWelcomeAt: Date,
    waLink: String, // the sheet's "WhatsApp Link" for THIS lead (group / community link) — used as template variable {{4}}
    callStatus: String, msgSent: String, // written back to the sheet's "Call Status" / "Msg Sent" columns
    waPendingAt: { type: Date, index: true }, // a welcome is due but not delivered yet (the background job retries it for 24 h)
    waTries: Number, waTriedAt: Date, // failed attempts so far, and when the last one was
    day1: Boolean, // attended Day 1
    day2: Boolean,
    day3: Boolean, // only for workshops that run 3 days (Settings -> Workshops)
    fus: [Fu], // Lead Qualification follow-ups 1..3
    d1Fus: [Fu], // Day 1 attendee follow-ups
    d2Fus: [Fu], // Day 2 attendee follow-ups
    d3Fus: [Fu], // Day 3 attendee follow-ups
    source: String, // sheet | manual | sheet-import | booking | razorpay
    sheetDirty: { type: Boolean, index: true }, // Level / Profession / City changed in the app and not yet written back to the Google Sheet
  },
  { timestamps: true }
);
LeadSchema.index({ ts: -1 });
LeadSchema.pre("save", function () {
  if (this.phone) this.phone10 = this.phone.replace(/\D/g, "").slice(-10);
  this.emailKey = (this.email || "").trim().toLowerCase();
});

export const Lead = mongoose.model("Lead", LeadSchema, "leads");

// One row per Razorpay payment (payment.captured and payment_link.paid for the same payment merge into one row).
export const LeadPayment = mongoose.model(
  "Payment",
  new Schema(
    {
      paymentId: { type: String, unique: true },
      events: [String], // which webhook events delivered this payment
      orderId: String, linkId: String,
      amount: Number, currency: String, method: String, status: String,
      name: String, nameGuess: Boolean, email: String, phone: String,
      description: String, workshop: String, notes: Object,
      paidAt: { type: Date, index: true },
      leadKey: String, // the lead this payment was attached to
      outcome: String, // "created" (new lead) | "matched" (existing lead) | "no-contact" (no phone / email to match on)
    },
    { timestamps: true }
  ),
  "payments"
);

// One row per booking of the "New Order FMS" sheet (after it was connected) — the "New Bookings" page. A booking by someone who is
// already a lead is listed too (outcome "matched"); a brand-new person is outcome "created". ref = "<timestamp ms>:<last 10 digits>".
export const LeadBooking = mongoose.model(
  "Booking",
  new Schema(
    {
      ref: { type: String, unique: true },
      ts: { type: Date, index: true }, // when the booking was made (the sheet's Timestamp)
      name: String, email: String, phone: String, program: String, amount: Number, via: String,
      leadKey: String, // the lead it became / was attached to
      outcome: String, // "created" | "matched"
    },
    { timestamps: true }
  ),
  "bookings"
);

// Every WhatsApp (AiSensy) message the site tried to send: sent, failed or skipped — so nothing fails silently.
export const WaMessage = mongoose.model(
  "WaMessage",
  new Schema({
    at: { type: Date, index: true }, kind: String, // "welcome" | "test"
    leadId: String, leadKey: String, name: String, phone: String,
    status: String, // "sent" | "failed" | "skipped"
    error: String, response: String, params: [String], campaign: String, by: String,
  }),
  "wamessages"
);

// Every status update, kept forever (call history / reports).
export const LeadActivity = mongoose.model(
  "Activity",
  new Schema({
    key: String, name: String, caller: String, step: Number, status: String, note: String,
    at: { type: Date, index: true }, delayMs: Number, stage: String, by: String, demo: Boolean,
  }),
  "activities"
);

export const LeadConfig = mongoose.model(
  "Config",
  new Schema({ _id: String, v: Object }),
  "configs"
);

// One row per "Import from sheet" (manual click, or an automatic run that actually changed something).
export const LeadImportLog = mongoose.model(
  "ImportLog",
  new Schema({
    at: { type: Date, index: true }, by: String, byEmail: String, trigger: String, // "manual" | "auto"
    added: Number, updated: Number, byEmailMatched: Number, rows: Number, ok: Boolean, error: String, note: String,
  }),
  "importlogs"
);

// Nightly copy of the Daily Board, saved forever.
export const LeadSnapshot = mongoose.model(
  "Snapshot",
  new Schema({ date: { type: String, unique: true }, data: Object }),
  "snapshots"
);
