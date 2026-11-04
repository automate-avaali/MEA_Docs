import "server-only";
import { completeChat } from "../ai/fanar";
import { searchNormalize } from "../text/arabic";

// Query understanding — runs before retrieval on EVERY message:
//   • rewrites the message into a self-contained question using the thread (last 10 Q&A pairs), but only when
//     it is connected to earlier turns ("is this signed?", "and the penalties?", "Suhas" after "what's your name?")
//   • produces bilingual (English + Arabic) keyword queries, since the contracts are bilingual
//   • detects small talk ("my name is Suhas") → answered from the conversation, no document search
//   • asks ONE clarifying question when the message can't be understood even with the thread ("ID #")
//   • picks up explicit page references ("top of the first page" → page 1)
// On any failure / timeout it falls back to the raw message + the fixed term expansion below, so a slow or
// broken rewrite can never block an answer.

export type Rewrite = {
  intent: "search" | "chat" | "clarify";
  standalone: string;
  queries: string[];
  pages: number[];
  reply: string;
  source: "llm" | "fallback";
  ms: number;
};
export type Turn = { role: "user" | "assistant"; content: string };

const SYSTEM = `You prepare the user's latest message for a search over their uploaded business documents (contracts, invoices, agreements — usually bilingual Arabic/English, scanned and OCR'd).

Return ONLY a JSON object, no comments, no markdown:
{"intent": "search" | "chat" | "clarify", "standalone": string, "queries": string[], "pages": number[], "reply": string}

- intent "search": anything that could be answered from the documents. This is the default when unsure.
- intent "chat": greetings, thanks, small talk, or statements/questions about the conversation itself ("my name is Suhas", "what is my name?"). Put the answer in "reply", using only the conversation. Never state document facts in a chat reply.
- intent "clarify": the message cannot be understood even with the conversation, e.g. a lone fragment with no earlier topic. Put ONE short question in "reply" that helps the user finish it. NEVER clarify when the message can be read as a follow-up of the conversation ("is this signed?", "and the date?", "what about the other one?") — "this/it/they" mean the documents or topic just discussed.
- "standalone": the latest message rewritten as a complete question in the user's language. Keep the user's own key terms (e.g. "discount slabs" stays "discount slabs", never "levels of discounts"). A bare topic ("discount slabs", "payment terms") becomes "List the <topic> in the documents, for each item/product". If it continues the earlier topic (it/this/that/they, "and the…", "what about…", a bare answer to the assistant's question, a short fragment), merge in the needed context from the conversation. If it starts a new topic, ignore earlier turns.
- "queries": 2–4 short keyword search queries, at least one in English AND one in Arabic, using the words contracts actually contain, with synonyms. Keep names, numbers and codes exactly as written.
- "pages": page numbers the user points at ("first page" → [1], "page 3" → [3]). "Top of the page", "top right/left", "header" or "the ID box" without a page number → [1] (IDs and reference numbers sit at the top of the first page). Otherwise [].
- "reply": "" unless intent is chat or clarify.

Examples
Conversation: (none) | Latest: my name is
{"intent":"clarify","standalone":"","queries":[],"pages":[],"reply":"Sure — what is your name?"}
Conversation: User: my name is / Assistant: Sure — what is your name? | Latest: Suhas
{"intent":"chat","standalone":"My name is Suhas.","queries":[],"pages":[],"reply":"Nice to meet you, Suhas! What would you like to know about your documents?"}
Conversation: User: who signed from MenaBev? / Assistant: Farouk Hatem signed for MenaBev [1]. | Latest: and the customer?
{"intent":"search","standalone":"Who signed the agreement on behalf of the customer (second party)?","queries":["customer second party signature signed by representative","توقيع الطرف الثاني العميل الممثل"],"pages":[],"reply":""}
Conversation: User: who signed from menabev and customer side / Assistant: MenaBev: Mr. [illegible] … Customer: … | Latest: is this signed ?
{"intent":"search","standalone":"Are the agreements signed by both parties (MenaBev and the customer)?","queries":["signature signed by both parties representative","التوقيع الطرف الأول الطرف الثاني"],"pages":[],"reply":""}
Conversation: (none) | Latest: what is the ID on the top right of the first page
{"intent":"search","standalone":"What is the ID / reference number printed at the top right of the first page?","queries":["contract number reference number customer ID first page","رقم العقد رقم المرجع رقم العميل"],"pages":[1],"reply":""}
Conversation: (none) | Latest: ID #
{"intent":"clarify","standalone":"","queries":[],"pages":[],"reply":"Which ID do you mean — the contract/reference number, the customer number, or a commercial registration (CR) number?"}`;

// Fixed bilingual expansion for terms that appear in almost every question about these contracts.
// Cheap, deterministic, and keeps working when the LLM rewrite is unavailable.
const TERMS: { match: RegExp; expand: string }[] = [
  { match: /\b(ids?|numbers?|ref(erence)?)\b|#|رقم|مرجع/i, expand: "contract number reference number customer number رقم العقد رقم المرجع رقم العميل" },
  { match: /sign|signature|signator|توقيع|موقع|وقع/i, expand: "signature signed by representative authorized signatory التوقيع الممثل المفوض بالتوقيع" },
  { match: /pay(ment)?|due|credit|invoice|دفع|سداد|فاتور|ائتمان/i, expand: "payment terms due date invoice credit period شروط الدفع السداد الفاتورة مدة الائتمان" },
  { match: /penalt|fine|breach|terminat|compensat|غرام|جزاء|إخلال|اخلال|فسخ|إنهاء|انهاء|تعويض/i, expand: "penalty fine breach termination compensation غرامة جزاء الإخلال فسخ إنهاء تعويض" },
  { match: /discount|slab|tier|rebate|off.?invoice|خصم|شرائح|شريحة/i, expand: "discount slab volume off-invoice rebate شرائح الخصم الخصم الكمية" },
  { match: /duration|\bterm\b|period|expir|validity|\b(start|end)\b|مدة|سريان|انتهاء|تاريخ/i, expand: "agreement term duration effective date expiry مدة العقد سريان تاريخ الانتهاء" },
  { match: /part(y|ies)|customer|client|supplier|company|طرف|عميل|شركة|مورد/i, expand: "first party second party customer company الطرف الأول الطرف الثاني العميل الشركة" },
  { match: /price|cost|amount|value|سعر|أسعار|قيمة|مبلغ/i, expand: "price amount value SAR السعر القيمة المبلغ ريال" },
  { match: /product|sku|pack|منتج|منتجات|عبوة/i, expand: "product pack size SKU المنتج المنتجات العبوة" },
  { match: /obligat|responsib|duty|التزام|مسؤولي/i, expand: "obligations responsibilities shall التزامات مسؤوليات يلتزم" },
];
export function expandTerms(text: string) {
  const extra = TERMS.filter((t) => t.match.test(text)).map((t) => t.expand);
  return extra.length ? extra.slice(0, 3).join(" ") : "";
}

/** Thread text for the rewriter: user turns in full, assistant turns shortened (they can be long tables). */
function threadText(history: Turn[]) {
  if (!history.length) return "(none)";
  return history.map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.role === "user" ? m.content.slice(0, 500) : m.content.slice(0, 350)}`).join("\n");
}

function parse(text: string) {
  const body = text
    .replace(/^```(?:json)?|```$/gm, "")
    .replace(/\/\/[^\n"]*$/gm, "") // stray // comments
    .trim();
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1)) as Partial<Rewrite>;
  } catch {
    return null;
  }
}

const uniq = (qs: string[]) => {
  const seen = new Set<string>();
  return qs.filter((q) => {
    const k = searchNormalize(q).toLowerCase().trim();
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
};

export async function rewriteQuery(message: string, history: Turn[]): Promise<Rewrite> {
  const t0 = Date.now();
  const fallback = (): Rewrite => ({
    intent: "search",
    standalone: message,
    queries: uniq([message, expandTerms(message)]),
    pages: [],
    reply: "",
    source: "fallback",
    ms: Date.now() - t0,
  });
  try {
    const { text } = await completeChat(
      [
        { role: "system", content: SYSTEM },
        { role: "user", content: `Conversation:\n${threadText(history)}\n\nLatest: ${message}` },
      ],
      { maxTokens: 350, signal: AbortSignal.timeout(8_000) },
    );
    const r = parse(text);
    if (!r || !["search", "chat", "clarify"].includes(String(r.intent))) return fallback();
    let intent = r.intent as Rewrite["intent"];
    const reply = typeof r.reply === "string" ? r.reply.trim() : "";
    // Guard: in an ongoing document conversation, a question that has words to search with is searched (with
    // the thread merged in) instead of being bounced back with a clarifying question.
    const lastUser = [...history].reverse().find((m) => m.role === "user")?.content;
    const words = message.trim().split(/\s+/).filter((w) => /[\p{L}\p{N}]{2,}/u.test(w)).length;
    if (intent === "clarify" && lastUser && words >= 2 && !/^(my name|اسمي|میرا نام)/i.test(message.trim())) {
      intent = "search";
      if (!r.standalone || String(r.standalone).trim() === message.trim()) r.standalone = `${message} (context: ${lastUser.slice(0, 200)})`;
    }
    if (intent !== "search" && reply) {
      return { intent, standalone: String(r.standalone || message), queries: [], pages: [], reply, source: "llm", ms: Date.now() - t0 };
    }
    const standalone = typeof r.standalone === "string" && r.standalone.trim() ? r.standalone.trim() : message;
    const llmQueries = Array.isArray(r.queries) ? r.queries.filter((q): q is string => typeof q === "string").slice(0, 4) : [];
    const pages = Array.isArray(r.pages) ? r.pages.filter((p): p is number => Number.isInteger(p) && p > 0 && p < 10000).slice(0, 3) : [];
    return {
      intent: "search",
      standalone,
      // standalone question first (it is also what the reranker scores against), then the LLM's bilingual
      // keyword queries, then the fixed expansion — at most 5 queries (each = 1 BM25 + 1 vector search).
      queries: uniq([standalone, ...llmQueries, expandTerms(`${standalone} ${message}`)]).slice(0, 5),
      pages,
      reply: "",
      source: "llm",
      ms: Date.now() - t0,
    };
  } catch (e) {
    console.warn("[rewrite] failed:", (e as Error).message);
    return fallback();
  }
}
