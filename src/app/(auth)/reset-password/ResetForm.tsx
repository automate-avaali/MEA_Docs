"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { AuthCard } from "@/components/AuthCard";
import { PasswordInput, StrengthMeter } from "@/components/PasswordInput";
import { Button, ErrorNote, Label, api, errorCode } from "@/components/ui";
import { useT } from "@/i18n/client";

export function ResetForm({ token }: { token: string }) {
  const { t, tError } = useT();
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<{ code: string } | null>(null);
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (password.length < 8) return setError({ code: "weak_password" });
    if (password !== confirm) return setError({ code: "password_mismatch" });
    setLoading(true);
    try {
      await api("/api/auth/reset-password", { method: "POST", json: { token, password } });
      router.push("/login?reset=1");
    } catch (err) {
      setError({ code: errorCode(err) });
      setLoading(false);
    }
  }

  if (!token)
    return (
      <AuthCard title={t("auth.reset.expiredTitle")} accent={t("auth.reset.expiredAccent")} sub={t("auth.reset.missing")}>
        <Link href="/forgot-password" className="btn-coral flex h-12 items-center justify-center rounded-xl font-semibold">
          {t("auth.reset.requestNew")}
        </Link>
      </AuthCard>
    );

  return (
    <AuthCard title={t("auth.reset.title")} accent={t("auth.reset.accent")} sub={t("auth.reset.sub")}>
      <form onSubmit={submit} className="space-y-4">
        <ErrorNote>
          {error && tError(error.code)}
          {error?.code === "reset_invalid" && (
            <>
              {" "}
              <Link href="/forgot-password" className="underline">
                {t("auth.reset.requestNew")}
              </Link>
            </>
          )}
        </ErrorNote>
        <div>
          <Label htmlFor="pw" hint={t("auth.signup.passwordHint")}>
            {t("auth.reset.newPassword")}
          </Label>
          <PasswordInput id="pw" autoComplete="new-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
          <StrengthMeter value={password} />
        </div>
        <div>
          <Label htmlFor="pw2">{t("auth.reset.confirm")}</Label>
          <PasswordInput id="pw2" autoComplete="new-password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </div>
        <Button variant="coral" size="lg" className="w-full" loading={loading}>
          {t("auth.reset.submit")}
        </Button>
      </form>
    </AuthCard>
  );
}
