// Turns whatever the admin gives us — pasted text, a copied Google-Sheet range, a CSV / Excel file, a Google Sheet link's rows —
// into a clean list of phone numbers and emails. No DOM and no libraries, so it is easy to test.

export const isEmail = (x) => /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(x);
const EMAIL_G = /[^\s@,;<>()"']+@[^\s@,;<>()"']+\.[^\s@,;<>()"']+/g;
const SCI = /^\d(\.\d+)?e\+?\d+$/i; // 9.87654E+09 — Excel / Sheets turned a long number into a short one: the digits are gone for good

// ---- text -> rows ----------------------------------------------------------------------------------------------------
// A small CSV / TSV reader (quotes, "" escapes, newlines inside quotes, BOM). The delimiter is guessed from the first lines.
export function parseDelimited(text) {
  let t = String(text ?? "").replace(/^\uFEFF/, "");
  const head = t.split(/\r?\n/).slice(0, 20).join("\n");
  const tabs = (head.match(/\t/g) || []).length, commas = (head.match(/,/g) || []).length, semis = (head.match(/;/g) || []).length;
  const D = tabs && tabs >= commas ? "\t" : semis > commas ? ";" : ",";
  const rows = []; let r = [], c = "", q = false;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (q) {
      if (ch === '"') { if (t[i + 1] === '"') { c += '"'; i++; } else q = false; } else c += ch;
    } else if (ch === '"' && !c) q = true;
    else if (ch === D) { r.push(c); c = ""; }
    else if (ch === "\n" || ch === "\r") { if (ch === "\r" && t[i + 1] === "\n") i++; r.push(c); c = ""; if (r.some((x) => x.trim())) rows.push(r); r = []; }
    else c += ch;
  }
  r.push(c); if (r.some((x) => x.trim())) rows.push(r);
  return rows;
}

// ---- one cell -> phone numbers / emails ------------------------------------------------------------------------------
// asColumn = the cell sits in a column that is named Phone / Email: the whole cell is ONE value (so "98765 43210" stays one number).
function fromCell(raw, out, bad, asColumn) {
  let s = String(raw ?? "").trim();
  if (!s) return;
  const mails = s.match(EMAIL_G) || [];
  for (const m of mails) out.push(m.toLowerCase());
  if (mails.length) s = s.replace(EMAIL_G, " ");
  // several numbers in one cell: split on , ; / | and new lines
  for (const part of s.split(/[,;/|\n]+/)) {
    let p = part.trim();
    if (!p) continue;
    if (SCI.test(p)) { bad.sci.push(p); continue; }
    p = p.replace(/\.0+$/, ""); // 9876543210.0
    const tokens = p.split(/\s+/);
    // free text: "9876543210 9123456780" are two numbers, but "98765 43210" and "+91 98765 43210" are one
    const pieces = !asColumn && tokens.length > 1 && tokens.every((x) => x.replace(/\D/g, "").length >= 10) ? tokens : [p];
    for (const x of pieces) {
      const digits = x.replace(/\D/g, "");
      if (digits.length < (asColumn ? 1 : 7)) continue; // in free text a short number is just a row number / year: ignore silently
      if (digits.length < 10 || digits.length > 13) { bad.short.push(x.trim()); continue; }
      out.push(digits.slice(-10));
    }
  }
}

const PHONE_H = /phone|mobile|contact|whats\s?app|cell|number|\bno\.?\b|मोबाइल/i;
const EMAIL_H = /e-?mail|mail\s?id/i;
const looksLikeData = (x) => isEmail(String(x).trim()) || String(x).replace(/\D/g, "").length >= 10;

// rows: array of arrays. Finds a header row (Phone / Email columns) and reads just those columns; with no header every cell is scanned.
export function extractEntries(rows) {
  const out = [], bad = { short: [], sci: [] };
  let hi = -1, pc = [], ec = [], names = { phone: [], email: [] };
  for (let i = 0; i < Math.min(rows.length, 8) && hi < 0; i++) {
    const r = rows[i];
    if (r.some(looksLikeData)) break; // real data already: there is no header
    r.forEach((h, j) => { const x = String(h || "").trim(); if (EMAIL_H.test(x)) { ec.push(j); names.email.push(x); } else if (PHONE_H.test(x)) { pc.push(j); names.phone.push(x); } });
    if (pc.length || ec.length) hi = i; else { pc = []; ec = []; names = { phone: [], email: [] }; }
  }
  const hadHeader = hi >= 0, body = hadHeader ? rows.slice(hi + 1) : rows;
  for (const r of body) {
    if (hadHeader) { for (const j of pc) fromCell(r[j], out, bad, true); for (const j of ec) fromCell(r[j], out, bad, true); }
    else for (const c of r) fromCell(c, out, bad, false);
  }
  const seen = new Set(), entries = [];
  for (const e of out) { if (!seen.has(e)) { seen.add(e); entries.push(e); } }
  return { entries, found: out.length, dupes: out.length - entries.length, invalid: bad.short, sci: bad.sci, hadHeader, columns: names, rowCount: body.length };
}

export const parseText = (text) => extractEntries(parseDelimited(text));

// ---- XLSX (first sheet) ------------------------------------------------------------------------------------------------
// An .xlsx file is a zip of XML files. Browsers can inflate zip data natively (DecompressionStream), so no library is needed.
async function inflate(bytes) {
  const ds = new DecompressionStream("deflate-raw"), w = ds.writable.getWriter();
  w.write(bytes); w.close();
  return new Uint8Array(await new Response(ds.readable).arrayBuffer());
}
async function unzip(buf) {
  const u8 = new Uint8Array(buf), dv = new DataView(buf), files = new Map();
  let e = u8.length - 22;
  while (e >= 0 && dv.getUint32(e, true) !== 0x06054b50) e--;
  if (e < 0) throw new Error("This is not a valid Excel (.xlsx) file");
  let p = dv.getUint32(e + 16, true);
  const n = dv.getUint16(e + 10, true), dec = new TextDecoder();
  for (let i = 0; i < n; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true), nl = dv.getUint16(p + 28, true), el = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true), off = dv.getUint32(p + 42, true);
    files.set(dec.decode(u8.subarray(p + 46, p + 46 + nl)), { method, csize, off });
    p += 46 + nl + el + cl;
  }
  return async (name) => {
    const f = files.get(name);
    if (!f) return null;
    const s = f.off + 30 + dv.getUint16(f.off + 26, true) + dv.getUint16(f.off + 28, true), data = u8.subarray(s, s + f.csize);
    return dec.decode(f.method === 0 ? data : await inflate(data));
  };
}
const unxml = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, c) => String.fromCodePoint(+c)).replace(/&#x([0-9a-f]+);/gi, (_, c) => String.fromCodePoint(parseInt(c, 16))).replace(/&amp;/g, "&");
const colNo = (ref) => { let n = 0; for (const ch of ref.replace(/\d/g, "")) n = n * 26 + ch.charCodeAt(0) - 64; return n - 1; };

export async function parseXlsx(buf) {
  const get = await unzip(buf);
  const wb = await get("xl/workbook.xml");
  if (!wb) throw new Error("This is not a valid Excel (.xlsx) file");
  let path = "xl/worksheets/sheet1.xml";
  const rid = wb.match(/<sheet\b[^>]*\br:id="([^"]+)"/)?.[1], rels = await get("xl/_rels/workbook.xml.rels");
  if (rid && rels) {
    const tag = rels.match(new RegExp(`<Relationship\\b[^>]*\\bId="${rid}"[^>]*>`))?.[0], tg = tag?.match(/Target="([^"]+)"/)?.[1];
    if (tg) path = tg.startsWith("/") ? tg.slice(1) : "xl/" + tg;
  }
  const sheet = (await get(path)) || (await get("xl/worksheets/sheet1.xml"));
  if (!sheet) throw new Error("Could not find a sheet in this Excel file");
  const sst = [], ssx = await get("xl/sharedStrings.xml");
  if (ssx) for (const m of ssx.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) sst.push(unxml([...m[1].replace(/<rPh\b[\s\S]*?<\/rPh>/g, "").matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((x) => x[1]).join("")));
  const rows = [];
  for (const rm of sheet.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const row = []; let next = 0;
    for (const cm of rm[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cm[1], body = cm[2] || "", ref = attrs.match(/\br="([A-Z]+\d+)"/)?.[1], t = attrs.match(/\bt="(\w+)"/)?.[1];
      const ix = ref ? colNo(ref) : next; next = ix + 1;
      const v = body.match(/<v>([\s\S]*?)<\/v>/)?.[1];
      let val = "";
      if (t === "s") val = sst[+v] ?? "";
      else if (t === "inlineStr") val = unxml([...body.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((x) => x[1]).join(""));
      else if (v !== undefined) val = t === "str" || t === "b" || t === "e" ? unxml(v) : Number.isFinite(+v) && Math.abs(+v) < 1e21 ? String(+v) : v;
      row[ix] = val;
    }
    for (let i = 0; i < row.length; i++) if (row[i] === undefined) row[i] = "";
    if (row.some((x) => String(x).trim())) rows.push(row);
  }
  return rows;
}

// ---- file -> entries -----------------------------------------------------------------------------------------------------
export async function parseFile(file) {
  const name = file.name || "", ext = name.split(".").pop().toLowerCase();
  if (ext === "xlsx" || ext === "xlsm") return extractEntries(await parseXlsx(await file.arrayBuffer()));
  if (ext === "xls") throw new Error("Old .xls files can't be read. In Excel choose File → Save As → CSV (or .xlsx), then upload that.");
  if (["csv", "tsv", "txt", ""].includes(ext) || /text|csv/.test(file.type || "")) return parseText(await file.text());
  throw new Error("Upload a .csv, .xlsx or .txt file (in Google Sheets: File → Download → CSV).");
}

// ---- template -------------------------------------------------------------------------------------------------------------
export const TEMPLATE_HEADER = ["Phone", "Email", "Name"];
export const TEMPLATE_ROWS = [
  ["9876543210", "", "Example Person 1"],
  ["", "example2@gmail.com", "Example Person 2"],
  ["9123456780", "example3@gmail.com", "Example Person 3"],
];

// ---- check in chunks ---------------------------------------------------------------------------------------------------------
export const chunk = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };
// the same interleaved dealing as the server's dealByRatio (so the preview and the result agree)
export function dealNames(n, people) {
  if (!n || !people.length) return [];
  const tot = people.reduce((a, p) => a + p.share, 0), quota = people.map((p) => (n * p.share) / tot), give = quota.map(Math.floor);
  let left = n - give.reduce((a, b) => a + b, 0);
  quota.map((q, i) => [q - Math.floor(q), i]).sort((a, b) => b[0] - a[0] || a[1] - b[1]).slice(0, left).forEach(([, i]) => give[i]++);
  const got = people.map(() => 0), out = [];
  for (let k = 0; k < n; k++) {
    let bi = -1, bv = Infinity;
    give.forEach((g, i) => { if (got[i] < g && got[i] / g < bv) { bv = got[i] / g; bi = i; } });
    got[bi]++; out.push(people[bi].name);
  }
  return out;
}
