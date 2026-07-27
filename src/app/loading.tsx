export default function Loading() {
  return (
    <div className="grid min-h-dvh place-items-center bg-ink-900">
      <div className="flex flex-col items-center gap-5">
        <span className="relative grid h-12 w-12 place-items-center">
          <span className="absolute inset-0 animate-pulse-ring rounded-full border border-royal-400/50" />
          <span className="h-7 w-7 animate-spin rounded-full border-2 border-white/15 border-t-electric-400" />
        </span>
        <span className="text-eyebrow uppercase text-white/25">Warming the projector</span>
      </div>
    </div>
  );
}
