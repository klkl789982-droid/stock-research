if (!process.argv.includes("--fixture")) throw new Error("실제 DART 동기화는 아직 승인되지 않았습니다. 이 단계에서는 외부 API를 호출하지 않습니다.");
console.log("fixture 전용 동기화 인터페이스 준비 완료");
