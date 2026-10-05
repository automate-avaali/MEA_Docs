import { Types } from "mongoose";
import { HttpError, handle, requireUser } from "@/lib/auth";
import { oid } from "@/lib/docs";
import { Conversation, DocumentModel, Message } from "@/lib/models";
import { answer, NOT_FOUND, retrievalQueries } from "@/lib/rag/answer";
import { retrieve } from "@/lib/rag/retrieve";
import { detectLang, type Lang } from "@/lib/text/arabic";

export const maxDuration = 120;

// Streams NDJSON events so the UI can show progress immediately:
//   {t:"meta"} → {t:"sources"} (right after retrieval, before the LLM starts) → {t:"delta"}… → {t:"verify"} → {t:"done"}
export const POST = handle(async (req: Request) => {
  const user = await requireUser();
  const body = await req.json();
  const question = String(body.message ?? "").trim();
  if (!question) throw new HttpError(400, "empty_question");
  if (question.length > 4000) throw new HttpError(400, "question_too_long");
  const t0 = Date.now();

  // Conversation (new or existing) + scope
  let convo = body.conversationId ? await Conversation.findOne({ _id: oid(body.conversationId), userId: user._id }) : null;
  if (body.conversationId && !convo) throw new HttpError(404, "not_found");
  const requestedDocs: string[] = Array.isArray(body.documentIds) ? body.documentIds : [];
  const docIds = requestedDocs.length
    ? (await DocumentModel.find({ _id: { $in: requestedDocs.map(oid) }, userId: user._id }, { _id: 1 }).lean()).map((d) => d._id as Types.ObjectId)
    : (convo?.documentIds as Types.ObjectId[] | undefined) ?? [];
  if (!convo) convo = await Conversation.create({ userId: user._id, title: question.slice(0, 80), documentIds: docIds });
  else if (requestedDocs.length) await Conversation.updateOne({ _id: convo._id }, { documentIds: docIds });

  const pref = ["ar", "en", "ur"].includes(body.answerLang) ? (body.answerLang as Lang) : null;
  const lang: Lang = pref ?? detectLang(question, (user.locale as Lang) ?? "en");

  const history = await Message.find({ conversationId: convo._id }).sort({ createdAt: -1 }).limit(6).lean();
  history.reverse();
  await Message.create({ conversationId: convo._id, userId: user._id, role: "user", content: question, lang });

  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (o: object) => controller.enqueue(enc.encode(JSON.stringify(o) + "\n"));
      let full = "";
      let issues: string[] = [];
      let sources: { n: number; documentId: Types.ObjectId; title: string; page: number; section: string; snippet: string; score: number }[] = [];
      const timings: Record<string, number> = {};
      try {
        send({ t: "meta", conversationId: String(convo!._id), lang });
        const r = await retrieve({ queries: retrievalQueries(question, history), userId: user._id, documentIds: docIds });
        Object.assign(timings, { retrieval: r.timings.total ?? Date.now() - t0, rerank: r.timings.rerank ?? 0 });
        sources = r.hits.map((h, i) => ({
          n: i + 1,
          documentId: h.documentId,
          title: h.docTitle,
          page: h.page,
          section: h.section,
          snippet: h.content.slice(0, 600),
          score: Math.round(h.score * 1000) / 1000,
        }));
        send({ t: "sources", sources: sources.map((s) => ({ ...s, documentId: String(s.documentId) })), mode: r.mode });

        if (!r.hits.length) {
          full = NOT_FOUND[lang];
          send({ t: "delta", d: full });
        } else {
          for await (const ev of answer({ question, lang, hits: r.hits, history: history.map((m) => ({ role: m.role as "user" | "assistant", content: m.content })) })) {
            if (ev.t === "delta") send(ev);
            else if (ev.t === "verify") {
              issues = ev.issues;
              send(ev);
            } else if (ev.t === "done") {
              full = ev.text;
              Object.assign(timings, { firstToken: (timings.retrieval ?? 0) + ev.firstTokenMs, llm: ev.llmMs, retriedLanguage: ev.retried ? 1 : 0 });
            }
          }
        }
        timings.total = Date.now() - t0;
        const saved = await Message.create({
          conversationId: convo!._id,
          userId: user._id,
          role: "assistant",
          content: full || NOT_FOUND[lang],
          lang,
          sources,
          issues: issues.length ? issues : undefined,
          timings,
        });
        await Conversation.updateOne({ _id: convo!._id }, { $set: { updatedAt: new Date() } });
        send({ t: "done", messageId: String(saved._id), timings });
      } catch (e) {
        console.error("[chat]", e);
        const code = /llm_/.test((e as Error).message) ? "llm_unavailable" : "server_error";
        if (full.trim()) await Message.create({ conversationId: convo!._id, userId: user._id, role: "assistant", content: full, lang, sources, timings }).catch(() => {});
        send({ t: "error", code });
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no" } });
});
