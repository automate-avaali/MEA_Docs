import mongoose from "mongoose";

type Cache = { conn: typeof mongoose | null; promise: Promise<typeof mongoose> | null };
const g = globalThis as unknown as { _mongoose?: Cache };
const cache: Cache = g._mongoose ?? (g._mongoose = { conn: null, promise: null });

export async function connectDB() {
  if (cache.conn) return cache.conn;
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI is not set. Add it to .env.local");
  if (!cache.promise) {
    cache.promise = mongoose.connect(uri, {
      dbName: process.env.MONGODB_DB || "mea_arabic_chatbot",
      bufferCommands: false,
      maxPoolSize: 10,
    });
  }
  try {
    cache.conn = await cache.promise;
  } catch (e) {
    cache.promise = null;
    throw e;
  }
  return cache.conn;
}

/** Native collection handle (chunks use the driver directly: binary vectors + Atlas Search). */
export async function collection(name: string) {
  const conn = await connectDB();
  return conn.connection.db!.collection(name);
}
