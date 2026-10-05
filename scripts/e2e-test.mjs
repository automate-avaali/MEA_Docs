// End-to-end API test against a running dev server, using the real scanned contracts in ../Docs.
// Mirrors what the browser does: register → send 5-page scanned batches (Gemini OCR) → complete → ask.
// Usage: node scripts/e2e-test.mjs [baseUrl]
import { readFileSync, readdirSync } from "node:fs";
import crypto from "node:crypto";
import { PDFDocument } from "pdf-lib";

const BASE = process.argv[2] || "http://localhost:3000";
let cookie = "";
const now = () => performance.now();

async function call(path, init = {}) {
  const res = await fetch(BASE + path, { ...init, headers: { ...(init.headers ?? {}), cookie } });
  const set = res.headers.getSetCookie?.() ?? [];
  for (const c of set) {
    const [kv] = c.split(";");
    const [k] = kv.split("=");
    cookie = [...cookie.split("; ").filter((x) => x && !x.startsWith(k + "=")), kv].join("; ");
  }
  return res;
}
const json = async (path, body, method = "POST") => {
  const r = await call(path, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, data: await r.json().catch(() => ({})) };
};

// ── 1. Auth ──
// LOGIN="email:password" → reuse an existing account and skip uploading (chat-only run).
const [loginEmail, loginPw] = (process.env.LOGIN ?? "").split(":");
const email = loginEmail || `e2e+${Date.now()}@test.local`;
let r = loginEmail
  ? await json("/api/auth/login", { email, password: loginPw })
  : await json("/api/auth/signup", { name: "E2E Tester", email, password: "Sup3r-secret!", locale: "en" });
console.log(loginEmail ? "login" : "signup", r.status, r.data.user?.email);
r = await json("/api/auth/me", null, "GET");
console.log("me", r.status, r.data.user?.name);

// ── 2. Upload the real scanned contracts ──
const dir = "../Docs/";
const files = loginEmail ? [] : readdirSync(dir).filter((f) => f.endsWith(".pdf")).slice(0, Number(process.env.DOCS || 99));
for (const f of files) {
  const bytes = readFileSync(dir + f);
  const src = await PDFDocument.load(bytes);
  const total = src.getPageCount();
  const t0 = now();
  r = await json("/api/documents", { title: f.replace(/\.pdf$/, ""), fileName: f, mimeType: "application/pdf", size: bytes.length, hash: crypto.createHash("sha256").update(bytes).digest("hex"), pageCount: total });
  const docId = r.data.document.id;
  const done = new Set(r.data.donePages);
  console.log(`\n${f}: ${total} pages, doc ${docId}${r.data.resumed ? ` (resumed, ${done.size} done)` : ""}`);

  const batches = [];
  for (let p = 1; p <= total; p += 5) batches.push(Array.from({ length: Math.min(5, total - p + 1) }, (_, i) => p + i).filter((x) => !done.has(x)));
  // 3 batches in flight, like the browser
  let next = 0;
  await Promise.all(
    Array.from({ length: 3 }, async () => {
      while (next < batches.length) {
        const pages = batches[next++];
        if (!pages.length) continue;
        const out = await PDFDocument.create();
        (await out.copyPages(src, pages.map((p) => p - 1))).forEach((pg) => out.addPage(pg));
        const form = new FormData();
        form.append("pdf", new Blob([await out.save()], { type: "application/pdf" }), "batch.pdf");
        form.append("pdfPages", JSON.stringify(pages));
        const tb = now();
        const res = await call(`/api/documents/${docId}/batch`, { method: "POST", body: form });
        const d = await res.json();
        console.log(`  pages ${pages[0]}-${pages.at(-1)}: http ${res.status} · ${d.chunks ?? "-"} chunks · ocr ${d.timings?.ocr ?? "-"} ms · embed ${d.timings?.embed ?? "-"} ms · total ${Math.round(now() - tb)} ms${d.flagged?.length ? ` · flagged ${d.flagged}` : ""}${d.code ? ` · ${d.code}` : ""}`);
      }
    }),
  );
  r = await json(`/api/documents/${docId}/complete`);
  console.log(`  complete: ${r.data.document?.chunkCount} chunks, lang ${r.data.document?.language}, ${((now() - t0) / 1000).toFixed(1)} s total (${((now() - t0) / 1000 / total).toFixed(1)} s/page)`);
}

// Atlas Search indexes are eventually consistent — give them a moment to pick up new chunks.
if (files.length) await new Promise((ok) => setTimeout(ok, 4000));

// ── 3. Ask ──
const QUESTIONS = (process.env.QUESTIONS || "").split("|").filter(Boolean).length
  ? process.env.QUESTIONS.split("|")
  : [
      "ما هي مدة العقد ومتى ينتهي؟",
      "What can the First Party do if the Second Party does not pay its invoices on time?",
      "What is the commercial registration number of the First Party?",
      "What is the off-invoice discount for SSPET 250ml in Slab B?",
      "ما هي الخصومات الممنوحة للطرف الثاني؟",
      "معاہدے کی مدت کیا ہے؟",
      "وماذا عن الثلاجات؟",
    ];
let conversationId = null;
for (const q of QUESTIONS) {
  const t0 = now();
  const res = await call("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: q, conversationId }) });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "", text = "", sourcesAt = 0, firstAt = 0, sources = [], issues = [], timings = {}, err = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const ev = JSON.parse(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
      if (ev.t === "meta") conversationId = ev.conversationId;
      if (ev.t === "sources") (sourcesAt = Math.round(now() - t0)), (sources = ev.sources);
      if (ev.t === "delta") (firstAt ||= Math.round(now() - t0)), (text += ev.d);
      if (ev.t === "verify") issues = ev.issues;
      if (ev.t === "done") timings = ev.timings;
      if (ev.t === "error") err = ev.code;
    }
  }
  console.log(`\nQ: ${q}`);
  console.log(`   sources at ${sourcesAt} ms · first words at ${firstAt} ms · total ${Math.round(now() - t0)} ms · server timings ${JSON.stringify(timings)}`);
  console.log(`   top sources: ${sources.slice(0, 3).map((s) => `[${s.n}] ${s.title} p.${s.page} ${s.section ? "· " + s.section.slice(0, 30) : ""}`).join(" | ")}`);
  console.log(`   A: ${text.replace(/\s+/g, " ").slice(0, 400)}`);
  if (issues.length) console.log(`   ⚠ issues: ${issues.join(", ")}`);
  if (err) console.log(`   ✖ error: ${err}`);
}

if (loginEmail) process.exit(0);
// ── 4. History + password reset flow ──
r = await json("/api/conversations", null, "GET");
console.log(`\nhistory: ${r.data.conversations?.length} conversation(s); "${r.data.conversations?.[0]?.title}"`);
r = await json(`/api/conversations/${conversationId}`, null, "GET");
console.log(`messages stored: ${r.data.messages?.length}`);
r = await json("/api/auth/forgot-password", { email });
const token = r.data.devLink?.split("token=")[1];
console.log("forgot-password:", r.status, token ? "dev link issued" : "no link");
r = await json("/api/auth/reset-password", { token, password: "N3w-password!" });
console.log("reset-password:", r.status);
r = await json("/api/auth/me", null, "GET");
console.log("old session after reset (should be 401):", r.status);
r = await json("/api/auth/login", { email, password: "N3w-password!" });
console.log("login with new password:", r.status);
