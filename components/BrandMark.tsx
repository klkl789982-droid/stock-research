type BrandMarkProps = {
  compact?: boolean;
  inverse?: boolean;
};

export default function BrandMark({ compact = false, inverse = false }: BrandMarkProps) {
  return (
    <span className="inline-flex items-center gap-3" aria-hidden="true">
      <span className={`${compact ? "h-10 w-10" : "h-12 w-12"} tb-brand-mark relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-[14px]`}>
        <span className="relative z-10 text-[15px] font-black tracking-[-0.14em] text-white">TB</span>
      </span>
      {!compact && (
        <span className={`text-lg font-extrabold tracking-[-0.04em] ${inverse ? "text-white" : "text-[var(--tb-text)]"}`}>
          Tight <span className="font-medium">Budget</span>
        </span>
      )}
    </span>
  );
}
