import mongoose, { Schema, type Model, type Types } from "mongoose";

// Explicit interfaces (mongoose's InferSchemaType blows up tsc memory — same approach as vitals.diary).
type Id = Types.ObjectId;
type Stamps = { _id: Id; createdAt: Date; updatedAt: Date };
const lower = (s: string) => s?.toLowerCase().trim();

// ── Users ────────────────────────────────────────────────────────────────────
export interface UserDoc extends Stamps {
  name: string;
  email: string;
  passwordHash: string;
  locale: "en" | "ar" | "ur";
  sessionVersion: number;
  resetTokenHash?: string;
  resetTokenExpires?: Date;
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
  },
  { timestamps: true },
);

// ── Documents (one per uploaded file) ────────────────────────────────────────
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
  section: string;
  snippet: string;
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
  createdAt: Date;
}
const SourceSchema = new Schema<SourceDoc>(
  { n: Number, documentId: Schema.Types.ObjectId, title: String, page: Number, section: String, snippet: String, score: Number },
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

function model<T>(name: string, schema: Schema<T>): Model<T> {
  return (mongoose.models[name] as Model<T>) || mongoose.model<T>(name, schema);
}

export const User = model<UserDoc>("User", UserSchema);
export const DocumentModel = model<DocumentDoc>("Document", DocumentSchema);
export const Conversation = model<ConversationDoc>("Conversation", ConversationSchema);
export const Message = model<MessageDoc>("Message", MessageSchema);
export const RateHit = model<RateHitDoc>("RateHit", RateSchema);

/** Chunks live in a plain collection (binary vectors + Atlas Search indexes), see lib/rag/store.ts. */
export const CHUNKS = "chunks";
