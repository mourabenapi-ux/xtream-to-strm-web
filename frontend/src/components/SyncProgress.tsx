interface SyncProgressProps {
    status?: string;
    phase?: string | null;
    done?: number;
    total?: number;
}

/**
 * How far the sync currently running has got.
 *
 * A sync can spend several minutes in its per-item loop, and a spinner says
 * nothing about whether that is 3 titles or 3000. Rendered only while the run
 * is in flight; the backend clears the counters when it ends.
 *
 * Until the item count is known — the catalogue is still being read, or the
 * phase has no denominator, like the disk sweep — the bar shows an
 * indeterminate stripe rather than a fake 0%.
 */
export function SyncProgress({ status, phase, done = 0, total = 0 }: SyncProgressProps) {
    if (status !== 'running') return null;

    const determinate = total > 0;
    const pct = determinate ? Math.min(100, Math.round((done / total) * 100)) : 0;

    return (
        <div className="mt-3 space-y-1">
            <div className="flex justify-between text-xs text-muted-foreground">
                <span className="truncate">{phase || 'Working…'}</span>
                {determinate && (
                    <span className="font-medium tabular-nums whitespace-nowrap">
                        {done} / {total} ({pct}%)
                    </span>
                )}
            </div>
            <div className="w-full bg-secondary rounded-full h-1.5 overflow-hidden">
                {determinate ? (
                    <div
                        className="h-full bg-blue-500 transition-all"
                        style={{ width: `${pct}%` }}
                    />
                ) : (
                    <div className="h-full w-1/3 bg-blue-500 animate-pulse rounded-full" />
                )}
            </div>
        </div>
    );
}
