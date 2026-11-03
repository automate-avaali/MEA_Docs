// Creates or updates an account, optionally with usage limits (sign-up is closed on client deployments).
//
//   USER_PASSWORD='…' node scripts/set-user.mjs --email client@company.com --name "Client" \
//     --max-docs 15 --max-pages 50 --max-mb 25 --questions 60
//
//   node scripts/set-user.mjs --email client@company.com --no-limits      (remove limits)
//
// The password is read from USER_PASSWORD (never from the command line, so it doesn't land in shell history).
// Changing the password signs the account out everywhere. Uses MONGODB_URI / MONGODB_DB from .env.local.
import { config } from "dotenv";
import bcrypt from "bcryptjs";
import { MongoClient } from "mongodb";

config({ path: ".env.local" });

const args = process.argv.slice(2);
const arg = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const num = (name) => (arg(name) == null ? undefined : Number(arg(name)));

const email = arg("email")?.toLowerCase().trim();
if (!email) {
  console.error("Missing --email");
  process.exit(1);
}
const limits = Object.fromEntries(
  Object.entries({
    maxDocuments: num("max-docs"),
    maxPagesPerDoc: num("max-pages"),
    maxFileMB: num("max-mb"),
    chatsPerDay: num("chats"),
    questionsPerDay: num("questions"),
  }).filter(([, v]) => v != null && Number.isFinite(v)),
);

const client = new MongoClient(process.env.MONGODB_URI);
await client.connect();
const users = client.db(process.env.MONGODB_DB || "mea_arabic_chatbot").collection("users");
const existing = await users.findOne({ email });
const password = process.env.USER_PASSWORD;
if (!existing && !password) {
  console.error("New account: set USER_PASSWORD");
  process.exit(1);
}
if (password && password.length < 8) {
  console.error("USER_PASSWORD must be at least 8 characters");
  process.exit(1);
}

const set = { updatedAt: new Date() };
const unset = {};
if (arg("name")) set.name = arg("name");
if (password) set.passwordHash = await bcrypt.hash(password, 11);
if (args.includes("--no-limits")) unset.limits = "";
else if (Object.keys(limits).length) set.limits = { ...(existing?.limits ?? {}), ...limits };

if (existing) {
  await users.updateOne(
    { _id: existing._id },
    { $set: set, ...(Object.keys(unset).length && { $unset: unset }), ...(password && { $inc: { sessionVersion: 1 } }) },
  );
} else {
  await users.insertOne({ name: arg("name") || email.split("@")[0], email, locale: "en", sessionVersion: 0, createdAt: new Date(), ...set });
}
const saved = await users.findOne({ email }, { projection: { _id: 1, name: 1, email: 1, limits: 1 } });
console.log(`${existing ? "Updated" : "Created"}:`, JSON.stringify(saved));
await client.close();
