"use client";
import { useEffect, useState } from "react";
import { useApp } from "@/components/AppShell";
import { LanguageSelect, ThemeToggle } from "@/components/brand";
import { PasswordInput, StrengthMeter } from "@/components/PasswordInput";
import { Button, Card, ErrorNote, Input, Label, PageHeader, SuccessNote, Tag, api, errorCode } from "@/components/ui";
import { useT } from "@/i18n/client";

type Health = { db: string; dbMs: number; providers: Record<string, string> };

export default function SettingsPage() {
  const { t, tError } = useT();
  const { user, setUser } = useApp();

  const [name, setName] = useState(user.name);
  const [nameMsg, setNameMsg] = useState("");
  const [pw, setPw] = useState({ current: "", next: "", confirm: "" });
  const [pwMsg, setPwMsg] = useState<{ ok?: string; err?: string }>({});
  const [pwBusy, setPwBusy] = useState(false);
  const [del, setDel] = useState("");
  const [delErr, setDelErr] = useState("");
  const [health, setHealth] = useState<Health | null>(null);

  useEffect(() => {
    fetch("/api/health")
      .then((r) => r.json())
      .then(setHealth)
      .catch(() => {});
  }, []);

  async function saveName(e: React.FormEvent) {
    e.preventDefault();
    const r = await api<{ user: typeof user }>("/api/auth/me", { method: "PATCH", json: { name } }).catch(() => null);
    if (r) {
      setUser(r.user);
      setNameMsg(t("common.saved"));
      setTimeout(() => setNameMsg(""), 2000);
    }
  }

  async function changePassword(e: React.FormEvent) {
    e.preventDefault();
    setPwMsg({});
    if (pw.next.length < 8) return setPwMsg({ err: tError("weak_password") });
    if (pw.next !== pw.confirm) return setPwMsg({ err: tError("password_mismatch") });
    setPwBusy(true);
    try {
      await api("/api/auth/change-password", { method: "POST", json: { currentPassword: pw.current, newPassword: pw.next } });
      setPw({ current: "", next: "", confirm: "" });
      setPwMsg({ ok: t("settings.changed") });
    } catch (err) {
      setPwMsg({ err: tError(errorCode(err)) });
    } finally {
      setPwBusy(false);
    }
  }

  async function deleteAccount(e: React.FormEvent) {
    e.preventDefault();
    setDelErr("");
    try {
      await api("/api/account", { method: "DELETE", json: { password: del } });
      window.location.href = "/";
    } catch (err) {
      setDelErr(tError(errorCode(err)));
    }
  }

  return (
    <div className="max-w-3xl">
      <PageHeader eyebrow={t("settings.eyebrow")} title={t("settings.title")} accent={t("settings.accent")} />

      <div className="space-y-6">
        <Card className="p-5 sm:p-6">
          <Tag n={1}>{t("settings.profile")}</Tag>
          <form onSubmit={saveName} className="mt-4 grid gap-4 sm:grid-cols-2">
            <div>
              <Label htmlFor="name">{t("settings.name")}</Label>
              <Input id="name" value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div>
              <Label>{t("settings.email")}</Label>
              <Input value={user.email} disabled dir="ltr" className="text-start opacity-70" />
            </div>
            <div className="flex items-center gap-3 sm:col-span-2">
              <Button disabled={!name.trim() || name === user.name}>{t("common.save")}</Button>
              {nameMsg && <span className="text-sm text-good">{nameMsg}</span>}
            </div>
          </form>
        </Card>

        <Card className="p-5 sm:p-6">
          <Tag n={2}>{t("settings.language")}</Tag>
          <p className="mt-2 text-sm text-ink-2">{t("settings.languageHint")}</p>
          <div className="mt-4 flex flex-wrap items-center gap-4">
            <LanguageSelect />
            <span className="flex items-center gap-2 text-sm text-ink-2">
              {t("settings.appearance")} <ThemeToggle />
            </span>
          </div>
        </Card>

        <Card className="p-5 sm:p-6">
          <Tag n={3}>{t("settings.password")}</Tag>
          <form onSubmit={changePassword} className="mt-4 space-y-4">
            <ErrorNote>{pwMsg.err}</ErrorNote>
            <SuccessNote>{pwMsg.ok}</SuccessNote>
            <div>
              <Label htmlFor="cur">{t("settings.current")}</Label>
              <PasswordInput id="cur" autoComplete="current-password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} required />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <Label htmlFor="new">{t("settings.newPassword")}</Label>
                <PasswordInput id="new" autoComplete="new-password" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} required />
                <StrengthMeter value={pw.next} />
              </div>
              <div>
                <Label htmlFor="conf">{t("settings.confirm")}</Label>
                <PasswordInput id="conf" autoComplete="new-password" value={pw.confirm} onChange={(e) => setPw({ ...pw, confirm: e.target.value })} required />
              </div>
            </div>
            <Button loading={pwBusy}>{t("settings.changePassword")}</Button>
          </form>
        </Card>

        <Card className="p-5 sm:p-6">
          <Tag n={4}>{t("settings.system")}</Tag>
          <p className="mt-2 text-sm text-ink-2">{t("settings.systemHint")}</p>
          {health && (
            <dl className="mt-4 grid gap-px overflow-hidden rounded-lg border border-line bg-line font-mono text-xs sm:grid-cols-2" dir="ltr">
              {[["database", `${health.db} · ${health.dbMs} ms`], ...Object.entries(health.providers)].map(([k, v]) => (
                <div key={k} className="flex justify-between gap-3 bg-surface px-3 py-2">
                  <dt className="uppercase tracking-wider text-muted">{k}</dt>
                  <dd className="truncate text-ink">{v}</dd>
                </div>
              ))}
            </dl>
          )}
        </Card>

        <Card className="border-critical/30 p-5 sm:p-6">
          <Tag n={5} className="text-critical">
            {t("settings.danger")}
          </Tag>
          <p className="mt-2 text-sm text-ink-2">{t("settings.dangerBody")}</p>
          <form onSubmit={deleteAccount} className="mt-4 space-y-3">
            <ErrorNote>{delErr}</ErrorNote>
            <div className="max-w-sm">
              <Label htmlFor="delpw">{t("settings.dangerConfirm")}</Label>
              <PasswordInput id="delpw" autoComplete="current-password" value={del} onChange={(e) => setDel(e.target.value)} required />
            </div>
            <Button variant="danger" disabled={!del}>
              {t("settings.deleteAccount")}
            </Button>
          </form>
        </Card>
      </div>
    </div>
  );
}
