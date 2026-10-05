"use client";
import { Eye, EyeOff } from "lucide-react";
import { useState, type InputHTMLAttributes } from "react";
import { useT } from "@/i18n/client";
import { Input } from "./ui";

export function PasswordInput(props: InputHTMLAttributes<HTMLInputElement>) {
  const { t } = useT();
  const [show, setShow] = useState(false);
  return (
    <div className="relative">
      <Input {...props} dir="ltr" type={show ? "text" : "password"} className="pe-11 text-start" />
      <button
        type="button"
        onClick={() => setShow((s) => !s)}
        aria-label={show ? t("auth.hidePassword") : t("auth.showPassword")}
        className="absolute end-1 top-1/2 -translate-y-1/2 grid size-9 place-items-center rounded-lg text-muted hover:text-ink cursor-pointer"
      >
        {show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
      </button>
    </div>
  );
}

export function strength(pw: string) {
  let s = 0;
  if (pw.length >= 8) s++;
  if (pw.length >= 12) s++;
  if (/[A-Z]/.test(pw) && /[a-z]/.test(pw)) s++;
  if (/\d/.test(pw)) s++;
  if (/[^A-Za-z0-9]/.test(pw)) s++;
  return Math.min(4, s);
}

export function StrengthMeter({ value }: { value: string }) {
  const { messages } = useT();
  if (!value) return null;
  const s = strength(value);
  const colors = ["bg-critical", "bg-serious", "bg-warning", "bg-good", "bg-good"];
  return (
    <div className="mt-2 flex items-center gap-2">
      <div className="flex flex-1 gap-1">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className={`h-1 flex-1 rounded-full ${i < s ? colors[s] : "bg-line"}`} />
        ))}
      </div>
      <span className="w-20 text-end text-xs text-muted">{messages.auth.strength[s]}</span>
    </div>
  );
}
