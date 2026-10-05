import nodemailer from "nodemailer";

export function mailConfigured() {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

export async function sendMail(to: string, subject: string, html: string, text?: string) {
  if (!mailConfigured()) {
    console.log(`\n[mail:not-configured] To: ${to}\nSubject: ${subject}\n${text ?? html}\n`);
    return false;
  }
  const port = Number(process.env.SMTP_PORT || 587);
  const transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: port === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  await transport.sendMail({ from: process.env.SMTP_FROM || `mea.docs <${process.env.SMTP_USER}>`, to, subject, html, text });
  return true;
}

export function appUrl() {
  return (process.env.APP_URL || "http://localhost:3000").replace(/\/$/, "");
}
