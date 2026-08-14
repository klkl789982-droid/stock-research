import fs from "fs";
import path from "path";
import JSZip from "jszip";

const apiKey = process.env.DART_API_KEY;

if (!apiKey) {
  console.error("DART_API_KEY가 없습니다.");
  process.exit(1);
}

const response = await fetch(
  `https://opendart.fss.or.kr/api/corpCode.xml?crtfc_key=${apiKey}`
);

if (!response.ok) {
  throw new Error("DART 기업코드 파일 다운로드 실패");
}

const buffer = await response.arrayBuffer();

const zip = await JSZip.loadAsync(buffer);

const xmlFile = zip.file("CORPCODE.xml");

if (!xmlFile) {
  throw new Error("CORPCODE.xml을 찾을 수 없습니다.");
}

const xml = await xmlFile.async("string");

const lists = xml.match(/<list>[\s\S]*?<\/list>/g) ?? [];

const getTagValue = (xml, tag) => {
  const match = xml.match(
    new RegExp(`<${tag}>(.*?)</${tag}>`)
  );

  return match ? match[1].trim() : "";
};

const corpMap = {};

for (const itemXml of lists) {
  const corpCode = getTagValue(itemXml, "corp_code");
  const corpName = getTagValue(itemXml, "corp_name");
  const stockCode = getTagValue(itemXml, "stock_code");

  if (!stockCode) continue;

  corpMap[stockCode] = {
    corpCode,
    corpName,
  };
}

const outputDir = path.join(
  process.cwd(),
  "data"
);

fs.mkdirSync(outputDir, {
  recursive: true,
});

const outputPath = path.join(
  outputDir,
  "corp-map.json"
);

fs.writeFileSync(
  outputPath,
  JSON.stringify(corpMap, null, 2),
  "utf-8"
);

console.log(
  `완료: ${Object.keys(corpMap).length}개 기업 저장`
);

console.log(outputPath);