"use client";
import Link from "next/link";
import { useEffect, useState } from "react";

type Receipt = { status: string; run: string; sha256: string; hashVerified: boolean; universe: number; calculated: number;
  collectionStartedAt: string; collectionCompletedAt: string; seedReferenceDate: string;
  models: { model: string; modelVersion: string; records: { ticker: string; companyName: string; rank: number; score: number }[] }[] };
const time = (value: string) => new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", dateStyle: "short", timeStyle: "medium" }).format(new Date(value)) + " KST";

export default function CloudVerificationPage() {
  const [receipt, setReceipt] = useState<Receipt | null>(null), [failed, setFailed] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const r = await fetch("/api/private-cloud-verification", { cache: "no-store", signal: controller.signal });
        if (!r.ok) throw new Error("unavailable");
        const value: Receipt = await r.json();
        if (value.status !== "VERIFIED_OFF_HOURS" || !value.hashVerified) throw new Error("invalid");
        if (!controller.signal.aborted) setReceipt(value);
      } catch { if (!controller.signal.aborted) setFailed(true); }
    })();
    return () => controller.abort();
  }, []);
  return <main className="mx-auto max-w-6xl space-y-4 p-4 md:p-8">
    <Link className="text-sm underline" href="/">홈 대시보드로</Link>
    <h1 className="text-xl font-semibold">관리자 전용 · Cloud 장외 검증 기록</h1>
    <p className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm">실제 KIS 장외 시험입니다. 14:00 정식 관측·공식 EOD·현재 순위가 아닙니다. 기존 LIVE 결과와 최신 포인터는 변경하지 않습니다.</p>
    {!receipt ? <p role="status">{failed ? "인증된 Cloud 기록 조회 실패 · 정상 결과로 대체하지 않습니다." : "비공개 저장소의 고정된 증거와 SHA256 확인 중"}</p> : <>
      <dl className="grid gap-2 text-sm sm:grid-cols-2"><div><dt>실제 관측 시작</dt><dd>{time(receipt.collectionStartedAt)}</dd></div><div><dt>실제 관측 종료</dt><dd>{time(receipt.collectionCompletedAt)}</dd></div><div><dt>공식 EOD 입력 기준일</dt><dd>{receipt.seedReferenceDate}</dd></div><div><dt>수집 / 모델 계산</dt><dd>{receipt.universe}종목 / {receipt.calculated}종목</dd></div></dl>
      <p className="break-all text-xs">원격 파일 SHA256 일치: {receipt.sha256}</p>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{receipt.models.map(model => <section key={model.model} className="tb-card p-4"><h2 className="font-semibold">{model.modelVersion} · 장외 TOP5</h2><ol className="mt-3 space-y-3 text-sm">{model.records.map(row => <li key={row.ticker} className="flex justify-between gap-2"><span>{row.rank}. {row.companyName}<span className="block text-xs text-slate-500">{row.ticker}</span></span><span>{row.score.toFixed(2)}</span></li>)}</ol></section>)}</div>
      <p className="text-xs text-slate-500">{receipt.run} · 미래 수익률·상승 확률 및 14:00 예약 성공을 검증한 결과가 아닙니다.</p>
    </>}
  </main>;
}
