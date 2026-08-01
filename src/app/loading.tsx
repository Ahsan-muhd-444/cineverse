export default function Loading() {
  return (
    <div className="grid min-h-dvh place-items-center bg-ink-950">
      <div className="flex flex-col items-center gap-5">
        {/* One spinner. Was a royal pulse ring wrapped around a cyan-edged
            spinner — two looping decorations for a state that only needs to say
            "working". The label carries the meaning; the ring carried nothing.
            `animate-spin` is collapsed by the global prefers-reduced-motion rule
            in globals.css, and the label still explains the state without it. */}
        <span className="h-8 w-8 animate-spin rounded-full border-2 border-white/15 border-t-gold-400" />
        <span className="text-eyebrow uppercase text-supporting">Warming the projector</span>
      </div>
    </div>
  );
}
