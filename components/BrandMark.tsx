import Image from "next/image";

type BrandMarkProps = {
  compact?: boolean;
  inverse?: boolean;
  hero?: boolean;
  symbolOnly?: boolean;
};

export default function BrandMark({ compact = false, inverse = false, hero = false, symbolOnly = false }: BrandMarkProps) {
  const symbolSize = hero ? 256 : compact ? 44 : 52;

  return (
    <span className={`inline-flex items-center ${hero ? "gap-0" : "gap-2.5"}`} aria-hidden="true">
      <span className={`${hero ? "h-48 w-48 sm:h-56 sm:w-56" : compact ? "h-10 w-10" : "h-11 w-11"} tb-brand-mark relative inline-flex shrink-0 items-center justify-center`}>
        <Image src="/tb-mark-v3.png" alt="" width={symbolSize} height={symbolSize} priority={!compact} className="h-full w-full object-contain" />
      </span>
      {!compact && !symbolOnly && !hero && (
        <span className={`text-[17px] font-medium tracking-[-0.035em] ${inverse ? "text-[#eef1f5]" : "text-[var(--tb-text)]"}`}>
          Tight <span className="font-light">Budget</span>
        </span>
      )}
    </span>
  );
}
