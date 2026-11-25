// Handwritten signatures, handwriting and stamps (client-safe: used by ingestion in the browser and on the server).
//
// OCR writes what is drawn by hand as fixed markers (see ../ai/gemini-ocr.ts):
//   [Handwritten signature — First Party / الطرف الأول — name: وليد عبدالله الحربي]
//   [No signature — Second Party]
//   [Handwritten: …]   [Stamp: شركة … س.ت 4030310797]
// Chunks carrying them are flagged at ingestion (`signatures`, `stamps`), and questions about signing get those
// chunks first (retrieval) with rules on how to read them (answer prompt).

const SIGNED = /\[\s*Handwritten signature\b/gi;
const UNSIGNED = /\[\s*No signature\b/gi;
const STAMP = /\[\s*(?:Company\s+)?(?:Stamp|Seal)\b[^\]]*\]/gi;

export type SignatureStats = { signatures: number; unsigned: number; stamps: number };

export function signatureStats(text: string): SignatureStats {
  return {
    signatures: text.match(SIGNED)?.length ?? 0,
    unsigned: text.match(UNSIGNED)?.length ?? 0,
    stamps: text.match(STAMP)?.length ?? 0,
  };
}

/**
 * A signature line in text read before the markers existed: "Signature: [illegible]", "التوقيع", "[Signature]",
 * "[Stamp of …]", "Signed by:". Line starts only, so clauses like "بالتوقيع عليه" / "signed by both parties" don't count.
 * Written without \b: Arabic letters are not "word" characters for \b (JS and MongoDB alike).
 */
export const SIGNATURE_LINE = /(?:^|\n)\s*(?:\*\*)?\s*(?:signature\s*:|signed\s+by\s*:|التوقيع|الإمضاء|دستخط)|\[\s*(?:signature|stamp|seal|handwritten)/i;

/** Order for signature questions: 0 = signed / unsigned marker, 1 = stamp only, 2 = signature line (older reading), 3 = other. */
export function signatureTier(h: { signatures?: number; unsigned?: number; stamps?: number; content: string }) {
  if (h.signatures || h.unsigned) return 0;
  if (h.stamps) return 1;
  return SIGNATURE_LINE.test(h.content) ? 2 : 3;
}

/** Extra keyword-search words for chunks with a signature block, so "من وقع؟" / "کس نے دستخط کیے؟" find them. */
export const SIGNATURE_SEARCH_TERMS = "signature signed handwritten signatory stamp توقيع التوقيع موقع بخط اليد ختم دستخط مہر";

/**
 * Questions about signing: who signed, is it signed/stamped, signatories, signature dates — English, Arabic, Urdu.
 * Bare "موقع" / "الموقع" / "وقع" are left out on purpose: they also mean "site" / "the location" / "occurred".
 */
export const SIGNATURE_QUESTION =
  /\bsign(?:ed|s|ing|ature|atures|atory|atories|er|ers)?\b|\bco-?signed\b|\bstamp(?:ed|s)?\b|\bseal(?:ed|s)?\b|توقيع|موقّع|الموقعين|الموقعون|وقّع|من\s+وقع|هل\s+وقع|إمضاء|امضاء|ممضي|مختوم|الختم|ختم|دستخط|مہر|ٹھپہ/i;

export const isSignatureQuestion = (...texts: (string | undefined)[]) => texts.some((t) => !!t && SIGNATURE_QUESTION.test(t));

/** A page whose text has a signature place — digital pages like this also go to OCR (signature may be an image). */
export const SIGNATURE_LABEL = /\bsignature\b|\bsigned\s+by\b|\bsignatory\b|التوقيع|توقيع|الإمضاء|إمضاء|دستخط/i;

// A name label just before "[illegible]" on the same line: "Mr./ Mrs. [illegible]", "ويمثلها السيد/ [illegible]".
// \b only on the English words (Arabic letters are not \b "word" characters).
const NAME_LABEL = /(?:\bMr\b|\bMrs\b|\bMs\b|\bname\b|represented\s+by|السيد|السيدة|السيده|الاسم|الإسم|ويمثلها|نام)[^\n[\]]{0,25}$/i;

/**
 * A person's name that couldn't be read is reported as "not present", never "illegible" (product rule).
 * Applied to what the LLM sees and to what the source viewer shows, so documents read earlier follow it too.
 * Other unreadable words keep [illegible] — "Signature: [illegible]" still means something was signed there.
 */
export function namesNotPresent(text: string) {
  return text
    .replace(/(name:\s*)(?:\[?\s*illegible\s*\]?|unreadable|not readable)[^\]\n]*/gi, "$1not present")
    .replace(/\[\s*illegible\s*\]/gi, (m, offset: number, all: string) => (NAME_LABEL.test(all.slice(Math.max(0, offset - 40), offset)) ? "(name not present)" : m));
}

// ── Signature summary (signature questions) ──────────────────────────────────────────────────────────────
// Built in code from the marks, so the model doesn't have to merge the Arabic and English columns of each party
// across a dozen sources itself (small models get that wrong). One line per document and party.

const PARTY_RULES: [RegExp, string][] = [
  [/first\s*part(?:y)?|الطرف\s*الأو?ل|فریق\s*اول/i, "First Party / الطرف الأول"],
  [/second\s*party|الطرف\s*الثاني|فریق\s*دوم/i, "Second Party / الطرف الثاني"],
];
const partyOf = (s: string) => PARTY_RULES.find(([re]) => re.test(s))?.[1] ?? null;
const DASH = "\\s*[—–-]\\s*";
const SIGNED_MARK = new RegExp(`\\[\\s*Handwritten signature${DASH}([^\\]]*?)${DASH}name:\\s*([^\\]]*)\\]`, "gi");
const UNSIGNED_MARK = new RegExp(`\\[\\s*No signature${DASH}([^\\]]*)\\]`, "gi");
const STAMP_MARK = /\[\s*(?:Stamp|Seal)(?:\s+of)?\s*:?\s*([^\]]*)\]/gi;
// Older readings (before the marks): "Signature: [Signature]", "Signature: [illegible]", "التوقيع [illegible]".
const OLD_SIGNED = /(?:signature\s*:|التوقيع\s*:?)\s*\[\s*(?:signature|illegible)\s*\]/i;
const NOT_PRESENT = /^(?:not present|not written|\[?\s*illegible\s*\]?|unreadable|none|-)?$/i;

type PartyState = { signed: boolean; unsigned: boolean; name?: string; stamps: Set<string>; refs: Set<number> };

/** `hits[i]` is source [i + 1] of the prompt. Returns "" when no source has a signature block. */
export function signatureSummary(hits: { documentId: unknown; docTitle: string; section?: string; content: string }[]) {
  const docs = new Map<string, { title: string; parties: Map<string, PartyState>; stamps: Set<string>; stampRefs: Set<number> }>();
  hits.forEach((h, i) => {
    const n = i + 1;
    const key = String(h.documentId);
    const doc = docs.get(key) ?? { title: h.docTitle, parties: new Map(), stamps: new Set<string>(), stampRefs: new Set<number>() };
    const party = (label: string) => {
      const p = partyOf(label) ?? (label.trim() || "Party (unnamed)");
      const s = doc.parties.get(p) ?? { signed: false, unsigned: false, stamps: new Set<string>(), refs: new Set<number>() };
      doc.parties.set(p, s);
      s.refs.add(n);
      return s;
    };
    const content = namesNotPresent(h.content);
    const marks: { at: number; s: PartyState }[] = []; // where each party's block is marked in this chunk
    for (const m of content.matchAll(SIGNED_MARK)) {
      const s = party(m[1]);
      s.signed = true;
      const name = m[2].trim();
      if (!s.name && !NOT_PRESENT.test(name)) s.name = name;
      marks.push({ at: m.index, s });
    }
    for (const m of content.matchAll(UNSIGNED_MARK)) {
      const s = party(m[1]);
      s.unsigned = true;
      marks.push({ at: m.index, s });
    }
    const sectionParty = partyOf(h.section ?? "");
    if (!marks.length && sectionParty && OLD_SIGNED.test(content)) party(sectionParty).signed = true;
    for (const m of content.matchAll(STAMP_MARK)) {
      const text = m[1].replace(/\s+/g, " ").trim();
      if (!text) continue;
      // A stamp belongs to the party whose block it sits in: the nearest mark before it, else the chunk's section.
      const before = marks.filter((x) => x.at < m.index).pop()?.s;
      const owner = before ?? marks[0]?.s ?? (sectionParty ? party(sectionParty) : null);
      if (owner) owner.stamps.add(text);
      else {
        doc.stamps.add(text);
        doc.stampRefs.add(n);
      }
    }
    if (doc.parties.size || doc.stamps.size) docs.set(key, doc);
  });
  const lines: string[] = [];
  for (const d of docs.values()) {
    for (const [p, s] of d.parties) {
      const status = s.signed ? "signed by hand" : s.unsigned ? "NOT signed (signature place empty)" : "signature not visible in the sources";
      const signer = s.signed ? ` — signer: ${s.name ?? "name not present"}` : "";
      const stamp = s.stamps.size ? ` — stamp: ${[...s.stamps].join(" | ")}` : "";
      lines.push(`- ${d.title} — ${p}: ${status}${signer}${stamp} ${[...s.refs].map((r) => `[${r}]`).join("")}`);
    }
    if (d.stamps.size) lines.push(`- ${d.title} — stamp on the signature page: ${[...d.stamps].join(" | ")} ${[...d.stampRefs].map((r) => `[${r}]`).join("")}`);
  }
  return lines.join("\n");
}

/** Marker words removed before comparing two OCR readings (Tesseract never writes them). */
export const stripMarkers = (text: string) =>
  text.replace(/\[\s*(?:Handwritten signature|No signature|Handwritten|Stamp)\s*(?:—|-|:)?/gi, "[").replace(/—\s*name:/gi, "");
