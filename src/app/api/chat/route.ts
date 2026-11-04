import { Types } from "mongoose";
import { HttpError, handle, requireUser } from "@/lib/auth";
import { oid } from "@/lib/docs";
import { consume, refund } from "@/lib/limits";
import { Conversation, DocumentModel, Message } from "@/lib/models";
import { answer, fitSources, NOT_FOUND, trimHistory } from "@/lib/rag/answer";
import { fuseAndRerank, gatherLists } from "@/lib/rag/retrieve";
import { rewriteQuery } from "@/lib/rag/rewrite";
import { searchNormalize } from "@/lib/text/arabic";
import { detectLang, type Lang } from "@/lib/text/arabic";

export const maxDuration = 300; // long table answers can take Fanar ~1 min (+ automatic continuation)

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

  // Daily quotas (limited accounts only): every question counts; a new conversation also counts as a chat.
  await consume(user, "questions");
  if (!convo) await consume(user, "chats").catch(async (e) => {
    await refund(user, "questions");
    throw e;
  });
  const isNewChat = !convo;
  const requestedDocs: string[] = Array.isArray(body.documentIds) ? body.documentIds : [];
  const docIds = requestedDocs.length
    ? (await DocumentModel.find({ _id: { $in: requestedDocs.map(oid) }, userId: user._id }, { _id: 1 }).lean()).map((d) => d._id as Types.ObjectId)
    : (convo?.documentIds as Types.ObjectId[] | undefined) ?? [];
  if (!convo) convo = await Conversation.create({ userId: user._id, title: question.slice(0, 80), documentIds: docIds });
  else if (requestedDocs.length) await Conversation.updateOne({ _id: convo._id }, { documentIds: docIds });

  const pref = ["ar", "en", "ur"].includes(body.answerLang) ? (body.answerLang as Lang) : null;
  const lang: Lang = pref ?? detectLang(question, (user.locale as Lang) ?? "en");

  // Thread memory: the last 10 Q&A pairs of this conversation.
  const history = await Message.find({ conversationId: convo._id }).sort({ createdAt: -1 }).limit(20).lean();
  history.reverse();
  const turns = history.map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));
  await Message.create({ conversationId: convo._id, userId: user._id, role: "user", content: question, lang });

  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (o: object) => controller.enqueue(enc.encode(JSON.stringify(o) + "\n"));
      let full = "";
      let issues: string[] = [];
      let sources: { n: number; documentId: Types.ObjectId; title: string; page: number; section: string; snippet: string; score: number }[] = [];
      const timings: Record<string, number> = {};
      let query: Record<string, unknown> | undefined;
      try {
        send({ t: "meta", conversationId: String(convo!._id), lang });
        const scope = { userId: user._id, documentIds: docIds };

        // 1. Understand the question (rewrite with the thread) — meanwhile the raw question is already searched.
        const rawLists = gatherLists({ queries: [question], ...scope, timings });
        const rw = await rewriteQuery(question, turns);
        timings.rewrite = rw.ms;
        query = { intent: rw.intent, standalone: rw.standalone, queries: rw.queries, pages: rw.pages, source: rw.source };

        if (rw.intent !== "search") {
          // Small talk / clarifying question: answered from the conversation, no document search.
          full = rw.reply;
          send({ t: "sources", sources: [], mode: rw.intent });
          send({ t: "delta", d: full });
        } else {
          // 2. Sparse + dense for every rewritten query (+ pages the user pointed at) → RRF top 30 → rerank top 20.
          const raw = searchNormalize(question).toLowerCase().trim();
          const more = await gatherLists({ queries: rw.queries.filter((q) => searchNormalize(q).toLowerCase().trim() !== raw), pages: rw.pages, ...scope, timings });
          const r = await fuseAndRerank({ lists: [...(await rawLists), ...more], rerankQuery: rw.standalone, timings });
          timings.retrieval = Date.now() - t0;

          // 3. Keep the thread + as many top sources as fit Fanar's 16K-token window.
          const thread = trimHistory(turns);
          const hits = fitSources(r.hits, { lang, history: thread, question: `${question}\n${rw.standalone}` });
          sources = hits.map((h, i) => ({
            n: i + 1,
            documentId: h.documentId,
            title: h.docTitle,
            page: h.page,
            section: h.section,
            snippet: h.content.slice(0, 600),
            score: Math.round(h.score * 1000) / 1000,
          }));
          send({ t: "sources", sources: sources.map((s) => ({ ...s, documentId: String(s.documentId) })), mode: r.mode });

          if (!hits.length) {
            full = NOT_FOUND[lang];
            send({ t: "delta", d: full });
          } else {
            for await (const ev of answer({ question, standalone: rw.standalone, lang, hits, history: thread })) {
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
          query,
        });
        await Conversation.updateOne({ _id: convo!._id }, { $set: { updatedAt: new Date() } });
        send({ t: "done", messageId: String(saved._id), timings });
      } catch (e) {
        console.error("[chat]", e);
        const code = /llm_/.test((e as Error).message) ? "llm_unavailable" : "server_error";
        if (full.trim()) await Message.create({ conversationId: convo!._id, userId: user._id, role: "assistant", content: full, lang, sources, timings }).catch(() => {});
        else {
          // Nothing was answered → don't charge the quota for it.
          await refund(user, "questions");
          if (isNewChat) await refund(user, "chats");
        }
        send({ t: "error", code });
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no" } });
});
