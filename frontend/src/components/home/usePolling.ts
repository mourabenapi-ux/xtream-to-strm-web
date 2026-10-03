import { useEffect, useRef } from 'react';

/**
 * Calls `fn` now and then every `ms`, but only while the tab is visible, and
 * once more the moment it becomes visible again. A dashboard left open on a
 * second screen overnight otherwise keeps asking for data nobody sees.
 * `ms` null runs it once.
 */
export function usePolling(fn: () => Promise<void> | void, ms: number | null, deps: unknown[]) {
    const latest = useRef(fn);
    latest.current = fn;

    useEffect(() => {
        const tick = async () => {
            if (document.visibilityState === 'hidden') return;
            try { await latest.current(); } catch { /* the caller reports its own errors */ }
        };
        tick();
        if (!ms) return;
        const id = setInterval(tick, ms);
        const onVisible = () => { if (document.visibilityState === 'visible') tick(); };
        document.addEventListener('visibilitychange', onVisible);
        return () => {
            clearInterval(id);
            document.removeEventListener('visibilitychange', onVisible);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, deps);
}
