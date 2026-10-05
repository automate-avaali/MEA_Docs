"use client";
import Link from "next/link";
import { useState } from "react";
import { AuthCard } from "@/components/AuthCard";
import { Button, ErrorNote, Input, Label, SuccessNote, api, errorCode } from "@/components/ui";
import { useT } from "@/i18n/client";

export default function ForgotPasswordPage() {
  const { t, tError } = useT();
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [devLink, setDevLink] = useState<string>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const r = await api<{ devLink?: string }>("/api/auth/forgot-password", { method: "POST", json: { email } });
      setSent(true);
      setDevLink(r.devLink);
    } catch (err) {
      setError(tError(errorCode(err)));
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthCard
      title={t("auth.forgot.title")}
      accent={t("auth.forgot.accent")}
      sub={t("auth.forgot.sub")}
      footer={
        <Link href="/login" className="font-semibold text-coral-ink hover:underline">
          {t("auth.forgot.back")}
        </Link>
      }
    >
      {sent ? (
        <div className="space-y-4">
          <SuccessNote>{t("auth.forgot.sent")}</SuccessNote>
          {devLink && (
            <div className="rounded-xl border border-dashed border-line p-3 text-sm text-ink-2">
              <div className="font-mono text-[11px] uppercase tracking-wider text-muted">{t("auth.forgot.devMode")}</div>
              <Link href={devLink.replace(/^https?:\/\/[^/]+/, "")} className="mt-1 block break-all text-coral-ink underline">
                {t("auth.forgot.openLink")}
              </Link>
            </div>
          )}
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-4">
          <ErrorNote>{error}</ErrorNote>
          <div>
            <Label htmlFor="email">{t("auth.email")}</Label>
            <Input id="email" type="email" dir="ltr" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" className="text-start" />
          </div>
          <Button variant="coral" size="lg" className="w-full" loading={loading}>
            {t("auth.forgot.submit")}
          </Button>
        </form>
      )}
    </AuthCard>
  );
}
