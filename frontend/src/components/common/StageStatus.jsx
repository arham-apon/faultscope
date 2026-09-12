import React, { useEffect, useState } from "react";
import { formatDuration } from "../../lib/pipeline";

/**
 * The in-flight readout for a stage.
 *
 * The backend runs each reasoning stage as one blocking call — its internal
 * ThreadPoolExecutor gives no per-file progress events — so this deliberately
 * shows elapsed time rather than a percentage it would have to invent.
 */
export default function StageStatus({ active, label }) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!active) {
      setElapsed(0);
      return undefined;
    }
    const startedAt = Date.now();
    const timer = setInterval(() => setElapsed(Date.now() - startedAt), 1000);
    return () => clearInterval(timer);
  }, [active]);

  if (!active) return null;

  return (
    <div className="animate-rise space-y-3 py-6">
      <div className="relative h-px w-full overflow-hidden bg-hairline">
        <div className="absolute inset-y-0 w-1/4 animate-sweep bg-accent" />
      </div>
      <div className="flex items-baseline justify-between font-mono text-[11px] uppercase tracking-[0.14em] text-muted">
        <span>{label || "Working"}</span>
        <span className="tabular-nums">{formatDuration(elapsed)}</span>
      </div>
    </div>
  );
}
