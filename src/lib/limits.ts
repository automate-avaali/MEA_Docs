import "server-only";
import { HttpError } from "./auth";
import { DocumentModel, Usage, type Limits, type UserDoc } from "./models";

// Per-account quotas. Accounts without `limits` are unlimited; a limited account (e.g. a client demo account)
// gets its numbers from the user record — set them with scripts/set-user.mjs.
//
// Days run midnight→midnight in the client's time zone (Riyadh, UTC+3, no daylight saving). The counter lives
// in its own collection, so deleting a conversation does not give questions back.
const TZ_OFFSET_MS = 3 * 3600_000;
export const LIMIT_TIMEZONE = "Asia/Riyadh";

export function dayKey(now = Date.now()) {
  return new Date(now + TZ_OFFSET_MS).toISOString().slice(0, 10);
}
/** Next local midnight, as an absolute time. */
export function resetsAt(now = Date.now()) {
  const local = new Date(now + TZ_OFFSET_MS);
  return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + 1) - TZ_OFFSET_MS);
}

type Counter = "questions" | "chats";
const LIMIT_OF: Record<Counter, keyof Limits> = { questions: "questionsPerDay", chats: "chatsPerDay" };
const ERROR_OF: Record<Counter, string> = { questions: "daily_question_limit", chats: "daily_chat_limit" };

/** Takes one unit of today's quota, atomically (two tabs can't both take the last question). */
export async function consume(user: UserDoc, counter: Counter) {
  const max = user.limits?.[LIMIT_OF[counter]];
  if (max == null) return;
  const key = { userId: user._id, day: dayKey() };
  await Usage.updateOne(key, { $setOnInsert: { questions: 0, chats: 0 } }, { upsert: true }).catch((e) => {
    if (e?.code !== 11000) throw e; // concurrent first request of the day created it — fine
  });
  const r = await Usage.updateOne({ ...key, [counter]: { $lt: max } }, { $inc: { [counter]: 1 } });
  if (!r.modifiedCount) throw new HttpError(429, ERROR_OF[counter]);
}

/** Gives a unit back when the request failed before producing an answer. */
export async function refund(user: UserDoc, counter: Counter) {
  if (user.limits?.[LIMIT_OF[counter]] == null) return;
  await Usage.updateOne({ userId: user._id, day: dayKey(), [counter]: { $gt: 0 } }, { $inc: { [counter]: -1 } }).catch(() => {});
}

/** Upload checks, run when a new document is registered (re-uploads that resume are not counted again). */
export async function checkUpload(user: UserDoc, file: { size?: number; pageCount: number }) {
  const l = user.limits;
  if (!l) return;
  if (l.maxPagesPerDoc != null && file.pageCount > l.maxPagesPerDoc) throw new HttpError(413, "page_limit");
  if (l.maxFileMB != null && (file.size ?? 0) > l.maxFileMB * 1024 * 1024) throw new HttpError(413, "file_too_large");
  if (l.maxDocuments != null && (await DocumentModel.countDocuments({ userId: user._id })) >= l.maxDocuments) throw new HttpError(403, "doc_limit");
}

export async function usageSummary(user: UserDoc) {
  const [today, documents] = await Promise.all([
    Usage.findOne({ userId: user._id, day: dayKey() }).lean(),
    DocumentModel.countDocuments({ userId: user._id }),
  ]);
  return {
    limits: user.limits ?? null,
    used: { questions: today?.questions ?? 0, chats: today?.chats ?? 0, documents },
    resetsAt: resetsAt().toISOString(),
    timezone: LIMIT_TIMEZONE,
  };
}
