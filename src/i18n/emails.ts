import type { Locale } from "./config";

type Mail = { subject: string; html: (name: string, link: string) => string; text: (link: string) => string };
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export const RESET_EMAIL: Record<Locale, Mail> = {
  en: {
    subject: "Reset your Avagama MiddleEast Docs password",
    html: (n, l) => `<p>Hi ${esc(n)},</p><p>Use the link below to choose a new password. It expires in 30 minutes.</p><p><a href="${l}">Reset password →</a></p><p>If you didn't ask for this, you can ignore this email.</p>`,
    text: (l) => `Reset your password: ${l}`,
  },
  ar: {
    subject: "إعادة تعيين كلمة مرور Avagama MiddleEast Docs",
    html: (n, l) => `<div dir="rtl"><p>مرحبًا ${esc(n)}،</p><p>استخدم الرابط أدناه لاختيار كلمة مرور جديدة. تنتهي صلاحيته خلال 30 دقيقة.</p><p><a href="${l}">إعادة تعيين كلمة المرور ←</a></p><p>إذا لم تطلب ذلك، يمكنك تجاهل هذه الرسالة.</p></div>`,
    text: (l) => `إعادة تعيين كلمة المرور: ${l}`,
  },
  ur: {
    subject: "Avagama MiddleEast Docs کا پاس ورڈ ری سیٹ کریں",
    html: (n, l) => `<div dir="rtl"><p>السلام علیکم ${esc(n)}،</p><p>نیا پاس ورڈ منتخب کرنے کے لیے نیچے دیا گیا لنک استعمال کریں۔ یہ 30 منٹ میں ختم ہو جائے گا۔</p><p><a href="${l}">پاس ورڈ ری سیٹ کریں ←</a></p><p>اگر آپ نے یہ درخواست نہیں کی تو اس ای میل کو نظر انداز کر دیں۔</p></div>`,
    text: (l) => `پاس ورڈ ری سیٹ کریں: ${l}`,
  },
};
