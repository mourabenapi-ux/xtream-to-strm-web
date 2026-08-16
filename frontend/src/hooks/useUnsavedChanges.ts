import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Guards work that lives only in React state until an explicit Save.
 *
 * Two protections:
 *  - the browser's own "leave site?" prompt on reload/close/back
 *  - `guard(action)`, which defers any in-page action that would wipe that
 *    state (switching subscription, switching media type, reloading a list)
 *    until the user confirms in the app's own dialog
 *
 * `dirty` is read through a ref so the beforeunload listener always sees the
 * current value without being torn down and re-attached on every change.
 *
 * Usage:
 *   const guard = useUnsavedChanges(selection.size > 0);
 *   <select onChange={e => guard.run(() => setSubId(Number(e.target.value)))} />
 *   <ConfirmDialog isOpen={guard.isPrompting} onClose={guard.cancel} onConfirm={guard.proceed} ... />
 */
export function useUnsavedChanges(dirty: boolean) {
    const dirtyRef = useRef(dirty);
    dirtyRef.current = dirty;

    const [pending, setPending] = useState<(() => void) | null>(null);

    useEffect(() => {
        const handler = (e: BeforeUnloadEvent) => {
            if (!dirtyRef.current) return;
            e.preventDefault();
            // Browsers ignore custom text now, but returnValue must be set
            // for the native prompt to appear at all.
            e.returnValue = '';
        };
        window.addEventListener('beforeunload', handler);
        return () => window.removeEventListener('beforeunload', handler);
    }, []);

    /** Runs `action` immediately when clean; queues it behind a prompt when dirty. */
    const run = useCallback((action: () => void) => {
        if (!dirtyRef.current) {
            action();
            return;
        }
        // Stored via updater form: setState would otherwise *call* the function.
        setPending(() => action);
    }, []);

    const proceed = useCallback(() => {
        pending?.();
        setPending(null);
    }, [pending]);

    const cancel = useCallback(() => setPending(null), []);

    return { run, proceed, cancel, isPrompting: pending !== null };
}
