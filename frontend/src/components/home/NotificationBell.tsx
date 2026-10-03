import { FC, useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertOctagon, AlertTriangle, Bell, CheckCircle2, Info, Loader2, RefreshCw } from 'lucide-react';
import api from '@/lib/api';
import { Button } from '@/components/ui/button';
import { useToast } from '@/contexts/ToastContext';
import { timeAgo, type Condition, type ConditionsPayload, type Severity } from '@/lib/home';
import { useActionRunner } from './actions';
import { usePolling } from './usePolling';

const LOOK: Record<Severity, { icon: typeof Info; text: string; label: string }> = {
    danger: { icon: AlertOctagon, text: 'text-red-600 dark:text-red-400', label: 'Needs you' },
    warning: { icon: AlertTriangle, text: 'text-amber-600 dark:text-amber-400', label: 'Worth a look' },
    info: { icon: Info, text: 'text-muted-foreground', label: 'For information' },
};

/**
 * The notification zone: a bell in the page header, on every screen, with a
 * badge for what needs attention and a panel listing it. One row per problem,
 * with the button that fixes it. Replaces the stack of cards that used to
 * open the dashboard.
 */
export const NotificationBell: FC = () => {
    const navigate = useNavigate();
    const toast = useToast();
    const [data, setData] = useState<ConditionsPayload | null>(null);
    const [open, setOpen] = useState(false);
    const [showInfo, setShowInfo] = useState(false);
    const [checking, setChecking] = useState(false);
    const baseline = useRef<string | null>(null);
    const deadline = useRef(0);
    const root = useRef<HTMLDivElement>(null);

    const load = useCallback(async () => {
        const res = await api.get<ConditionsPayload>('/dashboard/conditions');
        setData(res.data);
        if (checking && (res.data.computed_at !== baseline.current || Date.now() > deadline.current)) setChecking(false);
    }, [checking]);

    const busy = checking || !!data?.refreshing;
    usePolling(load, busy ? 3000 : 30000, [busy, load]);

    const recheck = useCallback(async () => {
        baseline.current = data?.computed_at ?? null;
        deadline.current = Date.now() + 90000;
        setChecking(true);
        try {
            await api.post('/dashboard/refresh');
        } catch (err) {
            setChecking(false);
            toast.apiError('Could not start the check', err);
        }
    }, [data?.computed_at, toast]);

    const { run, running } = useActionRunner(recheck);

    // Close on a click outside or Escape.
    useEffect(() => {
        if (!open) return;
        const onDown = (e: MouseEvent) => { if (root.current && !root.current.contains(e.target as Node)) setOpen(false); };
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
        document.addEventListener('mousedown', onDown);
        document.addEventListener('keydown', onKey);
        return () => {
            document.removeEventListener('mousedown', onDown);
            document.removeEventListener('keydown', onKey);
        };
    }, [open]);

    const conditions = data?.conditions ?? [];
    const serious = conditions.filter(c => c.severity === 'danger');
    const check = conditions.filter(c => c.severity === 'warning');
    const infos = conditions.filter(c => c.severity === 'info');
    const attention = serious.length + check.length;
    const badge = serious.length ? 'bg-red-500' : 'bg-amber-500';

    const go = (c: Condition) => { if (c.link) { setOpen(false); navigate(c.link); } };

    const row = (c: Condition) => {
        const look = LOOK[c.severity];
        const Icon = look.icon;
        return (
            <li key={c.key} className="flex items-start gap-2.5 px-3 py-2.5">
                <Icon className={`h-4 w-4 mt-0.5 shrink-0 ${look.text}`} aria-label={look.label} />
                <div className="min-w-0 flex-1">
                    <div className={`text-sm leading-snug ${c.severity === 'info' ? 'text-muted-foreground' : 'font-medium'}`}>{c.title}</div>
                    {c.detail && <div className="text-xs text-muted-foreground mt-0.5">{c.detail}</div>}
                    <div className="text-[11px] text-muted-foreground/70 mt-0.5">
                        since {timeAgo(c.since)}{c.notified ? ' · sent to your phone' : ''}
                    </div>
                </div>
                <div className="flex flex-col items-end gap-1 shrink-0">
                    {c.action && (
                        <Button size="sm" className="h-7 px-2 text-xs" disabled={running === c.key} onClick={() => run(c.action!, c.key)}>
                            {running === c.key && <Loader2 className="h-3 w-3 mr-1 animate-spin" />}
                            {c.action.label}
                        </Button>
                    )}
                    {c.link && (
                        <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => go(c)} aria-label={`Open: ${c.title}`}>
                            Open
                        </Button>
                    )}
                </div>
            </li>
        );
    };

    return (
        <div ref={root} className="relative">
            <Button variant="ghost" size="icon" className="relative h-9 w-9" onClick={() => setOpen(o => !o)}
                aria-haspopup="dialog" aria-expanded={open}
                aria-label={attention ? `Notifications: ${attention} to look at` : 'Notifications: nothing to look at'}>
                <Bell className="h-5 w-5" />
                {attention > 0 && (
                    <span className={`absolute -top-0.5 -right-0.5 min-w-[1.1rem] h-[1.1rem] px-1 rounded-full text-[10px] font-semibold leading-[1.1rem] text-white text-center ${badge}`}>
                        {attention > 99 ? '99+' : attention}
                    </span>
                )}
                {busy && attention === 0 && <span className="absolute top-1 right-1 h-2 w-2 rounded-full bg-primary animate-pulse" aria-hidden="true" />}
            </Button>

            {open && (
                <div role="dialog" aria-label="Notifications"
                    className="fixed left-3 right-3 top-14 sm:absolute sm:left-auto sm:right-0 sm:top-full sm:mt-2 sm:w-[26rem] z-50 rounded-lg border bg-popover text-popover-foreground shadow-xl flex flex-col max-h-[75vh]">
                    <div className="flex items-center gap-2 px-3 py-2.5 border-b">
                        <span className="font-semibold text-sm">Notifications</span>
                        {serious.length > 0 && <span className="rounded-full bg-red-500/15 text-red-600 dark:text-red-400 px-2 py-0.5 text-xs font-medium">{serious.length} serious</span>}
                        {check.length > 0 && <span className="rounded-full bg-amber-500/15 text-amber-600 dark:text-amber-400 px-2 py-0.5 text-xs font-medium">{check.length} to check</span>}
                        <Button variant="ghost" size="sm" className="ml-auto h-7 px-2 text-xs" onClick={recheck} disabled={busy}
                            title={data?.computed_at ? `Last check ${timeAgo(data.computed_at)}` : undefined}>
                            <RefreshCw className={`h-3.5 w-3.5 mr-1 ${busy ? 'animate-spin' : ''}`} />
                            {busy ? 'Checking' : 'Check now'}
                        </Button>
                    </div>

                    <div className="overflow-y-auto overscroll-contain min-h-0">
                        {attention === 0 && (
                            <div className="px-4 py-6 text-center">
                                <CheckCircle2 className="h-7 w-7 mx-auto text-emerald-500 mb-2" />
                                <div className="text-sm font-medium">{data?.computed_at ? 'Nothing needs you' : 'No check yet'}</div>
                                <div className="text-xs text-muted-foreground">
                                    {data?.computed_at ? `Checked ${timeAgo(data.computed_at)}.` : 'The first check runs a few seconds after the app starts.'}
                                </div>
                            </div>
                        )}
                        {attention > 0 && <ul className="divide-y">{[...serious, ...check].map(row)}</ul>}
                        {infos.length > 0 && (
                            <div className={attention > 0 ? 'border-t' : ''}>
                                <button type="button" onClick={() => setShowInfo(v => !v)} aria-expanded={showInfo}
                                    className="w-full text-left px-3 py-2 text-xs text-muted-foreground hover:bg-muted/50">
                                    {showInfo ? 'Hide' : 'Show'} {infos.length} for information
                                </button>
                                {showInfo && <ul className="divide-y border-t">{infos.map(row)}</ul>}
                            </div>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
};
