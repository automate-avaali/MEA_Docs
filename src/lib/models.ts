import mongoose, { Schema, type Model, type Types } from "mongoose";

// Explicit interfaces (mongoose's InferSchemaType blows up tsc memory — same approach as vitals.diary).
type Id = Types.ObjectId;
type Stamps = { _id: Id; createdAt: Date; updatedAt: Date };
const lower = (s: string) => s?.toLowerCase().trim();

// ── Users ────────────────────────────────────────────────────────────────────
/** Optional per-account quotas (see lib/limits.ts). Missing = unlimited. */
export interface Limits {
  maxDocuments?: number;
  maxPagesPerDoc?: number;
  maxFileMB?: number;
  chatsPerDay?: number;
  questionsPerDay?: number;
}
export interface UserDoc extends Stamps {
  name: string;
  email: string;
  passwordHash: string;
  locale: "en" | "ar" | "ur";
  sessionVersion: number;
  resetTokenHash?: string;
  resetTokenExpires?: Date;
  limits?: Limits;
}
const UserSchema = new Schema<UserDoc>(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, set: lower },
    passwordHash: { type: String, required: true },
    locale: { type: String, enum: ["en", "ar", "ur"], default: "en" },
    sessionVersion: { type: Number, default: 0 },
    resetTokenHash: String,
    resetTokenExpires: Date,
    limits: {
      type: new Schema<Limits>(
        { maxDocuments: Number, maxPagesPerDoc: Number, maxFileMB: Number, chatsPerDay: Number, questionsPerDay: Number },
        { _id: false },
      ),
      default: undefined,
    },
  },
  { timestamps: true },
);

// ── Documents (one per uploaded file) ────────────────────────────────────────
/** The original uploaded file, kept in Vercel Blob (see lib/storage.ts). */
export interface StoredFile {
  pathname: string;
  contentType?: string;
  size?: number;
  uploadedAt?: Date;
}
export interface DocumentDoc extends Stamps {
  userId: Id;
  title: string;
  fileName?: string;
  mimeType?: string;
  size?: number;
  hash?: string; // sha256 of the file, computed in the browser → resume + dedupe
  pageCount: number;
  pagesDone: number[];
  chunkCount: number;
  status: "processing" | "ready" | "failed";
  language?: string; // ar / en / ur / mixed
  ocr: { gemini: number; tesseract: number; textLayer: number; flagged: number[] };
  pendingEmbeddings: number;
  suggestions?: Partial<Record<"en" | "ar" | "ur", string[]>>; // starter questions this document can answer, per UI language
  file?: StoredFile;
  error?: string;
}
const DocumentSchema = new Schema<DocumentDoc>(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    title: { type: String, required: true, trim: true },
    fileName: String,
    mimeType: String,
    size: Number,
    hash: { type: String, index: true },
    pageCount: { type: Number, default: 0 },
    pagesDone: { type: [Number], default: [] },
    chunkCount: { type: Number, default: 0 },
    status: { type: String, enum: ["processing", "ready", "failed"], default: "processing" },
    language: String,
    ocr: {
      gemini: { type: Number, default: 0 },
      tesseract: { type: Number, default: 0 },
      textLayer: { type: Number, default: 0 },
      flagged: { type: [Number], default: [] },
    },
    pendingEmbeddings: { type: Number, default: 0 },
    suggestions: { type: Schema.Types.Mixed, default: undefined },
    file: {
      type: new Schema<StoredFile>({ pathname: String, contentType: String, size: Number, uploadedAt: Date }, { _id: false }),
      default: undefined,
    },
    error: String,
  },
  { timestamps: true },
);
DocumentSchema.index({ userId: 1, hash: 1 });

// ── Conversations + messages (chat history) ──────────────────────────────────
export interface ConversationDoc extends Stamps {
  userId: Id;
  title: string;
  documentIds: Id[]; // empty = search all of the user's documents
}
const ConversationSchema = new Schema<ConversationDoc>(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    title: { type: String, default: "" },
    documentIds: { type: [Schema.Types.ObjectId], default: [] },
  },
  { timestamps: true },
);
ConversationSchema.index({ userId: 1, updatedAt: -1 });

export interface SourceDoc {
  n: number;
  documentId: Id;
  title: string;
  page: number;
  pageEnd?: number; // chunk spans page..pageEnd
  chunkId?: Id; // full passage for the source viewer (GET /api/documents/[id]/passages)
  section: string;
  snippet: string; // first 600 chars of the chunk (reference cards, hover preview)
  score: number;
}
export interface MessageDoc {
  _id: Id;
  conversationId: Id;
  userId: Id;
  role: "user" | "assistant";
  content: string;
  lang?: string;
  sources?: SourceDoc[];
  issues?: string[];
  timings?: Record<string, number>;
  query?: Record<string, unknown>; // how the question was understood (intent, standalone, search queries, pages)
  llm?: string; // model that wrote the answer, e.g. "mistral/mistral-small-latest" or "fanar/Fanar-C-2-27B"
  createdAt: Date;
}
const SourceSchema = new Schema<SourceDoc>(
  { n: Number, documentId: Schema.Types.ObjectId, chunkId: Schema.Types.ObjectId, title: String, page: Number, pageEnd: Number, section: String, snippet: String, score: Number },
  { _id: false },
);
const MessageSchema = new Schema<MessageDoc>(
  {
    conversationId: { type: Schema.Types.ObjectId, ref: "Conversation", required: true, index: true },
    userId: { type: Schema.Types.ObjectId, required: true },
    role: { type: String, enum: ["user", "assistant"], required: true },
    content: { type: String, required: true },
    lang: String,
    sources: { type: [SourceSchema], default: undefined },
    issues: { type: [String], default: undefined },
    timings: { type: Schema.Types.Mixed },
    query: { type: Schema.Types.Mixed },
    llm: String,
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
MessageSchema.index({ conversationId: 1, createdAt: 1 });

// ── Rate limiting (auth endpoints) — TTL index cleans itself ─────────────────
export interface RateHitDoc {
  key: string;
  at: Date;
}
const RateSchema = new Schema<RateHitDoc>({ key: { type: String, index: true }, at: { type: Date, default: Date.now, expires: 3600 } });

// ── Daily usage counters for limited accounts (one row per user per local day, kept 40 days) ──
export interface UsageDoc {
  userId: Id;
  day: string; // YYYY-MM-DD in the limit time zone
  questions: number;
  chats: number;
  createdAt: Date;
}
const UsageSchema = new Schema<UsageDoc>({
  userId: { type: Schema.Types.ObjectId, required: true },
  day: { type: String, required: true },
  questions: { type: Number, default: 0 },
  chats: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now, expires: 40 * 86400 },
});
UsageSchema.index({ userId: 1, day: 1 }, { unique: true });

function model<T>(name: string, schema: Schema<T>): Model<T> {
  return (mongoose.models[name] as Model<T>) || mongoose.model<T>(name, schema);
}

export const User = model<UserDoc>("User", UserSchema);
export const DocumentModel = model<DocumentDoc>("Document", DocumentSchema);
export const Conversation = model<ConversationDoc>("Conversation", ConversationSchema);
export const Message = model<MessageDoc>("Message", MessageSchema);
export const RateHit = model<RateHitDoc>("RateHit", RateSchema);
export const Usage = model<UsageDoc>("Usage", UsageSchema);

/** Chunks live in a plain collection (binary vectors + Atlas Search indexes), see lib/rag/store.ts. */
export const CHUNKS = "chunks";
