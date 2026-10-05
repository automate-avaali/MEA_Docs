"use client";
import Link from "next/link";
import { useState } from "react";
import { AuthCard } from "@/components/AuthCard";
import { PasswordInput } from "@/components/PasswordInput";
import { Button, ErrorNote, Input, Label, SuccessNote, api, errorCode } from "@/components/ui";
import { useT } from "@/i18n/client";

export function LoginForm({ next, reset }: { next: string; reset: boolean }) {
  const { t, tError } = useT();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      await api("/api/auth/login", { method: "POST", json: { email, password } });
      window.location.href = next; // full load so the server shell picks up the cookie + saved language
    } catch (err) {
      setError(tError(errorCode(err)));
      setLoading(false);
    }
  }

  return (
    <AuthCard
      title={t("auth.login.title")}
      accent={t("auth.login.accent")}
      sub={t("auth.login.sub")}
      footer={
        <>
          {t("auth.login.newHere")}{" "}
          <Link href="/signup" className="font-semibold text-coral-ink hover:underline">
            {t("auth.login.create")}
          </Link>
        </>
      }
    >
      <form onSubmit={submit} className="space-y-4">
        {reset && <SuccessNote>{t("auth.login.resetDone")}</SuccessNote>}
        <ErrorNote>{error}</ErrorNote>
        <div>
          <Label htmlFor="email">{t("auth.email")}</Label>
          <Input id="email" type="email" dir="ltr" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" className="text-start" />
        </div>
        <div>
          <Label
            htmlFor="password"
            hint={
              <Link href="/forgot-password" className="text-coral-ink hover:underline">
                {t("auth.login.forgot")}
              </Link>
            }
          >
            {t("auth.password")}
          </Label>
          <PasswordInput id="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
        <Button variant="coral" size="lg" className="w-full" loading={loading}>
          {t("auth.login.submit")}
        </Button>
      </form>
    </AuthCard>
  );
}
