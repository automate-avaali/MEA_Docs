// Answer-quality evaluation against a running server, on the real contracts in ../Docs.
// Signs up a throwaway account, uploads all PDFs (Gemini OCR path), asks questions with known answers,
// scores them, then deletes the account and all its data.   Usage: node scripts/eval.mjs [baseUrl]
import { readFileSync, readdirSync } from "node:fs";
import crypto from "node:crypto";
import { PDFDocument } from "pdf-lib";

const BASE = process.argv[2] || "http://localhost:3000";
let cookie = "";
async function call(path, init = {}) {
  const res = await fetch(BASE + path, { ...init, headers: { ...(init.headers ?? {}), cookie } });
  for (const c of res.headers.getSetCookie?.() ?? []) {
    const [kv] = c.split(";");
    const k = kv.split("=")[0];
    cookie = [...cookie.split("; ").filter((x) => x && !x.startsWith(k + "=")), kv].join("; ");
  }
  return res;
}
const json = async (path, body, method = "POST") => {
  const r = await call(path, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, data: await r.json().catch(() => ({})) };
};

// expect: every regex must match the answer. lang: expected answer language.
// newChat: start a fresh conversation (otherwise it's a follow-up in the current one).
const CASES = [
  { q: "ما هي مدة العقد ومتى ينتهي؟", lang: "ar", expect: [/ستة|6/, /30|يونيو|حزيران/], note: "term: 6 months, ends 30/06/2026" },
  { q: "What can the First Party do if the Second Party does not pay its invoices on time?", lang: "en", expect: [/suspend/i], note: "suspend supply (3.3)" },
  { q: "What is the commercial registration number of the First Party?", lang: "en", expect: [/4030262648/] },
  { q: "What is the off-invoice discount for SSPET 250ml in Slab B?", lang: "en", expect: [/1\.30?\b/], note: "table lookup" },
  { q: "What is the off-invoice discount for CAN 185mlx12 in Slab C?", lang: "en", expect: [/2\.17/], note: "table lookup" },
  { q: "ما هو الخصم لعبوة CAN 320ml في الشريحة A؟", lang: "ar", expect: [/1[.,]09|١[.,]٠٩/], note: "table lookup, Arabic question" },
  { q: "ما هي الخصومات الممنوحة للطرف الثاني؟", lang: "ar", expect: [/ملحق|\(2\)/] },
  { q: "معاہدے کی مدت کیا ہے؟", lang: "ur", expect: [/چھ|6/, /2026/], newChat: true },
  { q: "وماذا عن الثلاجات؟", lang: "ar", expect: [/ثلاج/], note: "follow-up in same chat" },
  { q: "Where is the First Party's registered office?", lang: "en", expect: [/Jeddah|21534/i], newChat: true },
  { q: "Who owns the refrigerators supplied to the Second Party?", lang: "en", expect: [/first party/i] },
  { q: "ریفریجریٹرز کس کی ملکیت ہیں؟", lang: "ur", expect: [/پہلے فریق|پہلی پارٹی|فریق اول|First Party|الطرف الأول/i], newChat: true },
  { q: "Within how many days must the Second Party notify the First Party of a new branch?", lang: "en", expect: [/10|15/], note: "EN says 10 days, AR says 15" },
  { q: "Is the agreement renewed automatically?", lang: "en", expect: [/\bnot\b|\bno\b/i] },
  { q: "What is the name of MenaBev's CEO?", lang: "en", expect: [/couldn't find|could not find|not (found|mentioned|provided|available)/i], note: "NOT in the documents → must not invent", newChat: true },
];

// HANDWRITING=1 → only the handwritten-annex question on 104190 (the case reported from the UI).
if (process.env.HANDWRITING) {
  CASES.length = 0;
  CASES.push({
    q: "104190 - from this document can you provide me the customer name and customer number that is present in this particular doc",
    lang: "en",
    expect: [/122414|١٢٢٤١٤/, /106095|١٠٦٠٩٥/, /115610|١١٥٦١٠/],
    note: "handwritten annex, page 6",
  });
}
const FILES = process.env.FILES ? new RegExp(process.env.FILES) : /./;

// ── account + upload ──
const email = `eval+${Date.now()}@test.local`;
const password = "Ev4l-secret!";
let r = await json("/api/auth/signup", { name: "Eval", email, password, locale: "en" });
if (r.status !== 201) throw new Error("signup failed " + JSON.stringify(r.data));

const dir = "../Docs/";
const t0 = Date.now();
let pages = 0;
for (const f of readdirSync(dir).filter((x) => x.endsWith(".pdf") && FILES.test(x))) {
  const bytes = readFileSync(dir + f);
  const src = await PDFDocument.load(bytes);
  const total = src.getPageCount();
  pages += total;
  r = await json("/api/documents", { title: f.replace(/\.pdf$/, ""), fileName: f, mimeType: "application/pdf", size: bytes.length, hash: crypto.createHash("sha256").update(bytes).digest("hex"), pageCount: total });
  const id = r.data.document.id;
  const batches = [];
  for (let p = 1; p <= total; p += 5) batches.push(Array.from({ length: Math.min(5, total - p + 1) }, (_, i) => p + i));
  await Promise.all(
    batches.map(async (b) => {
      const out = await PDFDocument.create();
      (await out.copyPages(src, b.map((p) => p - 1))).forEach((pg) => out.addPage(pg));
      const form = new FormData();
      form.append("pdf", new Blob([await out.save()], { type: "application/pdf" }), "b.pdf");
      form.append("pdfPages", JSON.stringify(b));
      const res = await call(`/api/documents/${id}/batch`, { method: "POST", body: form });
      if (!res.ok) console.log(`  ✖ ${f} pages ${b[0]}-${b.at(-1)}: ${res.status} ${JSON.stringify(await res.json())}`);
    }),
  );
  r = await json(`/api/documents/${id}/complete`);
  console.log(`indexed ${f}: ${total} pages, ${r.data.document.chunkCount} chunks, ${r.data.document.language}`);
}
console.log(`ingestion: ${pages} pages in ${((Date.now() - t0) / 1000).toFixed(0)} s\n`);
await new Promise((ok) => setTimeout(ok, 5000)); // let Atlas Search pick up the new chunks

// ── questions ──
const detect = (t) => {
  const a = (t.match(/[؀-ۿ]/g) ?? []).length, l = (t.match(/[A-Za-z]/g) ?? []).length;
  if (l > a) return "en";
  return (t.match(/[ٹڈڑںےۓھۃ]/g) ?? []).length >= 2 ? "ur" : "ar";
};
let conversationId = null;
const rows = [];
for (const c of CASES) {
  if (c.newChat) conversationId = null;
  const start = Date.now();
  const res = await call("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: c.q, conversationId }) });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "", text = "", first = 0, issues = [], timings = {}, err = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const ev = JSON.parse(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
      if (ev.t === "meta") conversationId = ev.conversationId;
      if (ev.t === "delta") (first ||= Date.now() - start), (text += ev.d);
      if (ev.t === "verify") issues = ev.issues;
      if (ev.t === "done") timings = ev.timings;
      if (ev.t === "error") err = ev.code;
    }
  }
  const correct = !err && c.expect.every((re) => re.test(text));
  const langOk = detect(text) === c.lang;
  rows.push({ c, text, correct, langOk, first, total: Date.now() - start, issues, err, retried: timings.retriedLanguage });
  console.log(`${correct && langOk ? "✅" : "❌"} [${c.lang}] ${c.q}`);
  console.log(`   ${text.replace(/\s+/g, " ").slice(0, process.env.HANDWRITING ? 1200 : 260)}`);
  console.log(`   correct=${correct} language=${langOk ? "ok" : "WRONG (" + detect(text) + ")"} · first words ${first} ms · total ${Date.now() - start} ms${issues.length ? " · ⚠ " + issues.join(", ") : ""}${timings.retriedLanguage ? " · language retry" : ""}${err ? " · ERROR " + err : ""}${c.note ? "  (" + c.note + ")" : ""}\n`);
}

const ok = rows.filter((x) => x.correct).length, lang = rows.filter((x) => x.langOk).length;
const med = (a) => a.sort((x, y) => x - y)[Math.floor(a.length / 2)];
console.log(`SCORE: correct ${ok}/${rows.length} · right language ${lang}/${rows.length} · checker flags ${rows.filter((x) => x.issues.length).length} · language retries ${rows.filter((x) => x.retried).length}`);
console.log(`latency: first words median ${med(rows.map((x) => x.first))} ms (max ${Math.max(...rows.map((x) => x.first))}) · total median ${med(rows.map((x) => x.total))} ms`);

// ── clean up: delete the account and everything it indexed ──
r = await json("/api/account", { password }, "DELETE");
console.log(`cleanup: account deleted (${r.status})`);
