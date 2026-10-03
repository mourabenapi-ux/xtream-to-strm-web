import { FC } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle, Loader2, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { number, timeAgo, type ActionSpec, type GuideRow, type ProviderRow, type SyncRow } from '@/lib/home';

const Dot: FC<{ tone: 'ok' | 'warn' | 'bad' | 'idle'; label: string }> = ({ tone, label }) => (
    <span role="img" aria-label={label} title={label}
        className={`inline-block h-2.5 w-2.5 rounded-full shrink-0 ${{ ok: 'bg-emerald-500', warn: 'bg-amber-500', bad: 'bg-red-500', idle: 'bg-muted-foreground/40' }[tone]}`} />
);

function syncTone(rows: (SyncRow | null)[]): 'ok' | 'warn' | 'bad' | 'idle' {
    const real = rows.filter(Boolean) as SyncRow[];
    if (!real.length) return 'idle';
    if (real.some(r => r.status === 'failed')) return 'bad';
    if (real.some(r => r.status === 'partial')) return 'warn';
    const newest = Math.max(...real.map(r => (r.at ? new Date(r.at).getTime() : 0)));
    return Date.now() - newest > 7 * 86400000 ? 'warn' : 'ok';
}

function expiry(a: ProviderRow['account']): { text: string; tone: string } | null {
    if (!a) return null;
    if (a.error) return { text: 'Not answering', tone: 'text-amber-600 dark:text-amber-400' };
    if (a.days_left === undefined || a.days_left === null || !a.expires_at) return null;
    const date = new Date(a.expires_at).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
    const days = Math.floor(a.days_left);
    const tone = days < 3 ? 'text-red-500' : days < 14 ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground';
    return { text: days < 0 ? `Expired on ${date}` : `Expires ${date} (${days} day${days === 1 ? '' : 's'})`, tone };
}

export const SourcesPanel: FC<{
    providers: ProviderRow[];
    guides: GuideRow[];
    running: string | null;
    onAction: (a: ActionSpec, id: string) => void;
}> = ({ providers, guides, running, onAction }) => {
    const navigate = useNavigate();
    return (
        <Card className="p-4 space-y-5">
            <div>
                <div className="flex items-center justify-between gap-2 pb-2">
                    <h3 className="text-lg font-semibold">Sources</h3>
                    <Button size="sm" variant="ghost" onClick={() => navigate('/xtreamtv/subscriptions')}>Manage</Button>
                </div>
                <ul className="divide-y">
                    {providers.map(p => {
                        const exp = expiry(p.account);
                        const a = p.account;
                        const tone = a?.error ? 'warn' : syncTone([p.syncs.movies, p.syncs.series]);
                        const last = [p.syncs.movies?.at, p.syncs.series?.at].filter(Boolean).sort().pop();
                        const id = `sync-${p.id}`;
                        return (
                            <li key={p.id} className="py-2.5 flex items-center gap-3">
                                <Dot tone={p.vod ? tone : (a?.error ? 'warn' : 'ok')} label={p.vod ? 'Sync state' : 'Live source'} />
                                <div className="min-w-0 flex-1">
                                    <div className="flex items-center gap-2">
                                        <span className="text-sm font-medium truncate">{p.name}</span>
                                        <span className="text-[10px] uppercase tracking-wide rounded bg-muted px-1.5 py-0.5 text-muted-foreground">{p.kind === 'm3u' ? 'M3U' : 'Xtream'}</span>
                                    </div>
                                    <div className="text-xs text-muted-foreground">
                                        {p.vod
                                            ? <>{number(p.movies)} movies · {number(p.series)} series · {last ? `synced ${timeAgo(last)}` : 'never synced'}
                                                {!p.schedule_enabled && <span className="text-amber-600 dark:text-amber-400"> · no schedule</span>}</>
                                            : 'Live channels only'}
                                    </div>
                                    {(exp || (a && a.max_connections !== undefined && a.max_connections !== null)) && (
                                        <div className="text-xs flex flex-wrap gap-x-3">
                                            {exp && <span className={exp.tone}>{exp.text}</span>}
                                            {a?.max_connections ? <span className="text-muted-foreground">{a.active_cons ?? 0}/{a.max_connections} connection{a.max_connections === 1 ? '' : 's'}</span> : null}
                                        </div>
                                    )}
                                </div>
                                {p.vod && p.is_active && (
                                    <Button size="sm" variant="outline" disabled={running === id}
                                        onClick={() => onAction({ kind: 'sync', label: 'Sync', subscription_id: p.id, type: 'all' }, id)}>
                                        {running === id ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <RefreshCw className="h-4 w-4 mr-1" />} Sync
                                    </Button>
                                )}
                            </li>
                        );
                    })}
                </ul>
            </div>

            <div>
                <div className="flex items-center justify-between gap-2 pb-2">
                    <h3 className="text-lg font-semibold">Guides</h3>
                    <Button size="sm" variant="ghost" onClick={() => navigate('/epg-admin')}>Manage</Button>
                </div>
                <ul className="divide-y">
                    {guides.map(g => {
                        const empty = g.cached_channels === 0;
                        const ageH = g.last_updated ? (Date.now() - new Date(g.last_updated).getTime()) / 3600000 : null;
                        const stale = ageH === null || ageH > 2 * g.refresh_hours + 1;
                        const id = `guide-${g.id}`;
                        return (
                            <li key={g.id} className="py-2.5 flex items-center gap-3">
                                <Dot tone={!g.active ? 'idle' : empty ? 'bad' : stale ? 'warn' : 'ok'} label={empty ? 'Not loaded' : stale ? 'Out of date' : 'Up to date'} />
                                <div className="min-w-0 flex-1">
                                    <div className="text-sm font-medium truncate" title={g.name}>{g.name}</div>
                                    <div className="text-xs text-muted-foreground">
                                        {empty ? <span className="text-red-500">Not loaded</span> : `${number(g.cached_channels ?? g.channel_count)} channels`}
                                        {' · '}refreshed {timeAgo(g.last_updated)}
                                        {g.duplicate_of && <span className="text-amber-600 dark:text-amber-400"> · same file as “{g.duplicate_of.name}”</span>}
                                    </div>
                                </div>
                                {g.active && (
                                    <Button size="icon" variant="ghost" className="h-9 w-9" disabled={running === id} aria-label={`Refresh ${g.name}`}
                                        onClick={() => onAction({ kind: 'refresh_guide', label: 'Refresh', source_id: g.id }, id)}>
                                        {running === id ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                                    </Button>
                                )}
                            </li>
                        );
                    })}
                    {guides.length === 0 && (
                        <li className="py-3 text-sm text-muted-foreground flex items-center gap-2">
                            <AlertTriangle className="h-4 w-4" /> No guide source: players show no programme.
                        </li>
                    )}
                </ul>
            </div>
        </Card>
    );
};
