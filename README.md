This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## 모델 순위 API

관리자 로그인 후 `/api/top-stocks?model=B`를 조회하면 공식 Daily EOD 순위를 받습니다. A·C·D도 같은 기준을 사용합니다.
`/api/intraday-model-top?model=B`는 14:00 LIVE의 최신 검증 게시본을 조회합니다. 응답의 관측일, 게시 시각, revision 및 PARTIAL 여부를 함께 확인하세요.
과거 14:30 전체 모델 기록에는 `/api/intraday-model-top?model=B&profile=1430`, 예전 단독 B 기록에는 `/api/top-stocks?model=B&basis=archive1430`을 사용합니다.

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
