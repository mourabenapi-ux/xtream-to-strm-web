import { FC } from 'react';
import { bytes, timeAgo, type Overview } from '@/lib/home';

/** Infrastructure on one line. Redis and the workers matter only when they are down. */
export const SystemStrip: FC<{ data: Overview }> = ({ data }) => {
    const { disk, redis, workers } = data.system;
    const pct = disk?.percent ?? 0;
    const bar = pct >= 98 ? 'bg-red-500' : pct >= 95 ? 'bg-amber-500' : 'bg-primary';
    const pill = (ok: boolean, label: string) => (
        <span className="inline-flex items-center gap-1.5">
            <span className={`h-2 w-2 rounded-full ${ok ? 'bg-emerald-500' : 'bg-red-500'}`} aria-hidden="true" />
            {label}
        </span>
    );
    return (
        <footer className="rounded-lg border bg-card px-4 py-3 flex flex-wrap items-center gap-x-6 gap-y-2 text-xs text-muted-foreground">
            {disk && (
                <div className="flex items-center gap-2 min-w-[14rem] flex-1">
                    <span className="shrink-0">Disk</span>
                    <div className="h-1.5 flex-1 rounded-full bg-secondary overflow-hidden" role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
                        <div className={`h-full ${bar}`} style={{ width: `${pct}%` }} />
                    </div>
                    <span className="shrink-0">{pct}% · {bytes(disk.free)} free · this app {bytes(disk.app_bytes)}</span>
                </div>
            )}
            {pill(!!redis?.online, redis?.online ? `Cache ${bytes(redis.used_bytes)}` : 'Cache offline')}
            {pill((workers ?? 0) > 0, workers === null ? 'Workers unknown' : workers ? `${workers} worker${workers === 1 ? '' : 's'}` : 'No worker')}
            <span className="ml-auto">
                Checked {timeAgo(data.computed_at)}{data.duration_ms ? ` in ${(data.duration_ms / 1000).toFixed(0)} s` : ''}
            </span>
        </footer>
    );
};
