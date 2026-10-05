"use client";
import Link from "next/link";
import { useState } from "react";
import { AuthCard } from "@/components/AuthCard";
import { PasswordInput, StrengthMeter } from "@/components/PasswordInput";
import { Button, ErrorNote, Input, Label, api, errorCode } from "@/components/ui";
import { useT } from "@/i18n/client";

export default function SignupPage() {
  const { t, tError, locale } = useT();
  const [form, setForm] = useState({ name: "", email: "", password: "", confirm: "" });
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (form.password.length < 8) return setError(tError("weak_password"));
    if (form.password !== form.confirm) return setError(tError("password_mismatch"));
    setLoading(true);
    try {
      await api("/api/auth/signup", { method: "POST", json: { name: form.name, email: form.email, password: form.password, locale } });
      window.location.href = "/documents";
    } catch (err) {
      setError(tError(errorCode(err)));
      setLoading(false);
    }
  }

  return (
    <AuthCard
      title={t("auth.signup.title")}
      accent={t("auth.signup.accent")}
      sub={t("auth.signup.sub")}
      footer={
        <>
          {t("auth.signup.haveAccount")}{" "}
          <Link href="/login" className="font-semibold text-coral-ink hover:underline">
            {t("common.signIn")}
          </Link>
        </>
      }
    >
      <form onSubmit={submit} className="space-y-4">
        <ErrorNote>{error}</ErrorNote>
        <div>
          <Label htmlFor="name">{t("auth.signup.name")}</Label>
          <Input id="name" autoComplete="name" required value={form.name} onChange={set("name")} placeholder={t("auth.signup.namePh")} />
        </div>
        <div>
          <Label htmlFor="email">{t("auth.email")}</Label>
          <Input id="email" type="email" dir="ltr" autoComplete="email" required value={form.email} onChange={set("email")} placeholder="you@company.com" className="text-start" />
        </div>
        <div>
          <Label htmlFor="password" hint={t("auth.signup.passwordHint")}>
            {t("auth.password")}
          </Label>
          <PasswordInput id="password" autoComplete="new-password" required value={form.password} onChange={set("password")} />
          <StrengthMeter value={form.password} />
        </div>
        <div>
          <Label htmlFor="confirm">{t("auth.signup.confirm")}</Label>
          <PasswordInput id="confirm" autoComplete="new-password" required value={form.confirm} onChange={set("confirm")} />
        </div>
        <Button variant="coral" size="lg" className="w-full" loading={loading}>
          {t("auth.signup.submit")}
        </Button>
      </form>
    </AuthCard>
  );
}
