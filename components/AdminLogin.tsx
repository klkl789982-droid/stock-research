"use client";
import { FormEvent, useState } from "react";
import BrandMark from "./BrandMark";

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
  return <main className="tb-page-ambient flex min-h-dvh items-center justify-center px-4 py-8">
    <section className="tb-card w-full max-w-md rounded-2xl p-6 sm:p-8" aria-labelledby="login-heading">
      <div className="mb-7"><BrandMark /><h1 id="login-heading" className="mt-4 text-lg font-medium text-slate-900">관리자 로그인</h1></div>
      <form onSubmit={submit} className="space-y-4">
        <div><label htmlFor="admin-username" className="mb-1.5 block text-sm text-slate-700">아이디</label><input id="admin-username" name="username" autoComplete="username" required maxLength={100} disabled={pending} className="tb-focus w-full rounded-xl border border-slate-400/30 bg-white/60 px-4 py-3 text-sm text-slate-900" /></div>
        <div><label htmlFor="admin-password" className="mb-1.5 block text-sm text-slate-700">비밀번호</label><input id="admin-password" name="password" type="password" autoComplete="current-password" required maxLength={1024} disabled={pending} className="tb-focus w-full rounded-xl border border-slate-400/30 bg-white/60 px-4 py-3 text-sm text-slate-900" /></div>
        {error && <p role="alert" className="text-sm leading-relaxed text-red-800">{error}</p>}
        <button type="submit" disabled={pending} className="tb-focus w-full rounded-xl bg-[var(--tb-orange)] px-4 py-3 text-sm font-medium text-white hover:brightness-105 disabled:cursor-wait disabled:opacity-60">{pending ? "로그인 확인 중…" : "로그인"}</button>
      </form>
      <p className="mt-5 text-xs leading-relaxed text-slate-600">회원가입은 제공하지 않습니다. 인증되지 않은 요청에는 분석 데이터가 제공되지 않습니다.</p>
    </section>
  </main>;
}
