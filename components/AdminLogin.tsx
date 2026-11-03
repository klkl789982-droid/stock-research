"use client";
import { FormEvent, useState } from "react";

export default function AdminLogin() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (pending) return;
    const form = new FormData(event.currentTarget);
    setPending(true); setError(null);
    try {
      const response = await fetch("/api/auth/login", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: form.get("username"), password: form.get("password") }), cache: "no-store" });
      if (response.ok) { window.location.replace("/"); return; }
      setError(response.status === 503 ? "관리자 인증 설정 또는 연결이 준비되지 않았습니다. 운영 설정을 확인해 주세요." : response.status === 429 ? "로그인 시도가 많습니다. 15분 후 다시 시도해 주세요." : "아이디 또는 비밀번호를 확인해 주세요.");
    } catch { setError("연결을 확인한 뒤 다시 시도해 주세요."); }
    setPending(false);
  }
  return <main className="min-h-dvh bg-[var(--tb-page)] text-[var(--tb-text)]">
    <header className="border-b border-[var(--tb-border)] bg-white px-5 py-4 text-[21px] font-bold tracking-tight sm:px-8">Tight Budget</header>
    <div className="grid min-h-[calc(100dvh-65px)] place-items-center px-4 py-8">
    <section className="tb-card w-full max-w-md p-6 sm:p-8" aria-labelledby="login-heading">
      <h1 id="login-heading" className="mb-6 text-2xl font-bold tracking-tight">관리자 로그인</h1>
      <form onSubmit={submit} className="space-y-4">
        <div><label htmlFor="admin-username" className="mb-1.5 block text-sm text-slate-700">아이디</label><input id="admin-username" name="username" autoComplete="username" required maxLength={100} disabled={pending} className="tb-focus w-full rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-900" /></div>
        <div><label htmlFor="admin-password" className="mb-1.5 block text-sm text-slate-700">비밀번호</label><input id="admin-password" name="password" type="password" autoComplete="current-password" required maxLength={1024} disabled={pending} className="tb-focus w-full rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-900" /></div>
        {error && <p role="alert" className="text-sm leading-relaxed text-red-800">{error}</p>}
        <button type="submit" disabled={pending} className="tb-focus w-full rounded-xl bg-[var(--tb-blue)] px-4 py-3 text-sm font-medium text-white hover:brightness-105 disabled:cursor-wait disabled:opacity-60">{pending ? "로그인 확인 중…" : "로그인"}</button>
      </form>
    </section></div>
  </main>;
}
