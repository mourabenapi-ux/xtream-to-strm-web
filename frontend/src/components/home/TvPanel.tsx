import { FC, useCallback, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Camera, Loader2, Radio, RefreshCw, Tv } from 'lucide-react';
import api from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { useToast } from '@/contexts/ToastContext';
import { clock, timeAgo, type OnAirChannel, type PlaylistRow, type TonightChannel, type Wall } from '@/lib/home';
import { usePolling } from './usePolling';

type Tab = 'now' | 'tonight' | 'wall';
const TIMES = ['20:00', '21:00', '22:00'];
const PAGE = 12;

const Logo: FC<{ src: string | null; name: string; className?: string }> = ({ src, name, className = 'h-9 w-9' }) => {
    const [failed, setFailed] = useState(false);
    if (!src || failed) {
        return (
            <div className={`${className} shrink-0 rounded-md bg-muted flex items-center justify-center text-[11px] font-semibold text-muted-foreground`}>
                {name.trim().slice(0, 2).toUpperCase()}
            </div>
        );
    }
    return <img src={src} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)}
        className={`${className} shrink-0 rounded-md bg-white object-contain p-0.5`} />;
};

const Number_: FC<{ n: number | null }> = ({ n }) =>
    n ? <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] font-mono text-muted-foreground">{n}</span> : null;

function useStored(key: string, initial: string): [string, (v: string) => void] {
    const [value, setValue] = useState(() => { try { return localStorage.getItem(key) || initial; } catch { return initial; } });
    const set = (v: string) => { setValue(v); try { localStorage.setItem(key, v); } catch { /* not remembered */ } };
    return [value, set];
}

// ---------------------------------------------------------------------------

const NowGrid: FC<{ playlistId: number }> = ({ playlistId }) => {
    const [channels, setChannels] = useState<OnAirChannel[] | null>(null);
    const [error, setError] = useState(false);
    const [shown, setShown] = useState(PAGE);
    const [, setTick] = useState(0);

    usePolling(async () => {
        try {
            const res = await api.get<{ channels: OnAirChannel[] }>('/dashboard/on-air', { params: { playlist_id: playlistId, limit: 120 } });
            setChannels(res.data.channels);
            setError(false);
        } catch { setError(true); }
        setTick(t => t + 1);
    }, 30000, [playlistId]);

    if (error && !channels) return <p className="text-sm text-muted-foreground p-4">The guide could not be read.</p>;
    if (!channels) return <div className="p-8 flex justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>;
    if (!channels.length) return <p className="text-sm text-muted-foreground p-4">This playlist serves no channel.</p>;

    const nowSec = Date.now() / 1000;
    return (
        <>
            <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                {channels.slice(0, shown).map(c => {
                    const live = c.guide === 'live' && c.now;
                    const pct = live && c.now_start && c.now_stop
                        ? Math.min(100, Math.max(0, ((nowSec - c.now_start) / (c.now_stop - c.now_start)) * 100)) : 0;
                    return (
                        <div key={`${c.channel_id}-${c.name}`} className="rounded-lg border bg-card p-3 flex gap-3 min-w-0">
                            <Logo src={c.logo} name={c.name} className="h-10 w-10" />
                            <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-2">
                                    <Number_ n={c.number} />
                                    <span className="text-xs text-muted-foreground truncate">{c.name}</span>
                                </div>
                                {live ? (
                                    <>
                                        <div className="text-sm font-medium truncate" title={c.now!}>{c.now}</div>
                                        <div className="h-1 rounded-full bg-secondary overflow-hidden my-1.5" role="progressbar"
                                            aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
                                            <div className="h-full bg-primary transition-all" style={{ width: `${pct}%` }} />
                                        </div>
                                        <div className="flex justify-between gap-2 text-[11px] text-muted-foreground">
                                            <span className="shrink-0">{clock(c.now_start)} – {clock(c.now_stop)}</span>
                                            {c.next && <span className="truncate" title={c.next}>then {c.next}</span>}
                                        </div>
                                    </>
                                ) : (
                                    <div className="text-sm text-muted-foreground/70 italic">
                                        {c.guide === 'none' ? 'No guide id' : 'No programme in the guide'}
                                    </div>
                                )}
                            </div>
                        </div>
                    );
                })}
            </div>
            {channels.length > shown && (
                <div className="pt-3 text-center">
                    <Button variant="ghost" size="sm" onClick={() => setShown(s => s + 24)}>
                        Show more ({channels.length - shown} left)
                    </Button>
                </div>
            )}
        </>
    );
};

// ---------------------------------------------------------------------------

const TonightGrid: FC<{ playlistId: number }> = ({ playlistId }) => {
    const [at, setAt] = useStored('home-tonight-at', '21:00');
    const [items, setItems] = useState<TonightChannel[] | null>(null);
    const [error, setError] = useState(false);

    usePolling(async () => {
        try {
            const res = await api.get<{ channels: TonightChannel[] }>('/dashboard/tonight', { params: { playlist_id: playlistId, at, limit: 40 } });
            setItems(res.data.channels);
            setError(false);
        } catch { setError(true); }
    }, 10 * 60000, [playlistId, at]);

    return (
        <>
            <div className="flex items-center gap-1 pb-3" role="group" aria-label="Time">
                {TIMES.map(t => (
                    <Button key={t} size="sm" variant={t === at ? 'default' : 'outline'} onClick={() => { setItems(null); setAt(t); }}>{t}</Button>
                ))}
            </div>
            {error && !items ? <p className="text-sm text-muted-foreground p-4">The guide could not be read.</p>
                : !items ? <div className="p-8 flex justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
                : !items.length ? <p className="text-sm text-muted-foreground p-4">No programme at {at} in this playlist's guide.</p>
                : (
                    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                        {items.map(c => (
                            <div key={`${c.channel_id}-${c.name}`} className="rounded-lg border bg-card overflow-hidden flex flex-col min-w-0">
                                {c.icon && (
                                    <img src={c.icon} alt="" loading="lazy" referrerPolicy="no-referrer"
                                        className="h-24 w-full object-cover bg-muted"
                                        onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }} />
                                )}
                                <div className="p-3 space-y-1 flex-1">
                                    <div className="flex items-center gap-2">
                                        <Logo src={c.logo} name={c.name} className="h-6 w-6" />
                                        <Number_ n={c.number} />
                                        <span className="text-xs text-muted-foreground truncate">{c.name}</span>
                                    </div>
                                    <div className="text-sm font-semibold leading-snug">{c.title}</div>
                                    {c.sub && <div className="text-xs text-muted-foreground">{c.sub}</div>}
                                    <div className="text-[11px] text-muted-foreground flex flex-wrap gap-x-2 gap-y-1 items-center">
                                        <span>{clock(c.start)} – {clock(c.stop)}</span>
                                        {c.category && <span className="rounded-full bg-muted px-2 py-0.5">{c.category}</span>}
                                    </div>
                                    {c.desc && <p className="text-xs text-muted-foreground line-clamp-3">{c.desc}</p>}
                                </div>
                            </div>
                        ))}
                    </div>
                )}
        </>
    );
};

// ---------------------------------------------------------------------------

const WallGrid: FC<{ playlistId: number }> = ({ playlistId }) => {
    const toast = useToast();
    const navigate = useNavigate();
    const [wall, setWall] = useState<Wall | null>(null);
    const [starting, setStarting] = useState(false);

    const load = useCallback(async () => {
        const res = await api.get<Wall>('/dashboard/wall', { params: { playlist_id: playlistId } });
        setWall(res.data);
    }, [playlistId]);

    usePolling(load, wall?.running ? 4000 : 60000, [playlistId, wall?.running]);

    const capture = async () => {
        setStarting(true);
        try {
            const res = await api.post<Wall>('/dashboard/wall/refresh', null, { params: { playlist_id: playlistId } });
            setWall(res.data);
        } catch (err) {
            toast.apiError('Could not start the capture', err);
        } finally {
            setStarting(false);
        }
    };

    if (!wall) return <div className="p-8 flex justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>;
    if (!wall.enabled) {
        return (
            <div className="p-4 text-sm text-muted-foreground">
                The TV wall is switched off. <Button variant="link" className="px-1" onClick={() => navigate('/admin')}>Turn it on in Administration</Button>
            </div>
        );
    }
    if (!wall.channels.length) {
        return (
            <p className="text-sm text-muted-foreground p-4">
                No free channel in this playlist. The wall only opens streams from free M3U sources, never from a paid provider: those allow one connection, and a capture would cut your television off ({wall.paid_channels} paid channels skipped).
            </p>
        );
    }
    const failed = wall.channels.filter(c => c.ok === false).length;
    return (
        <>
            <div className="flex flex-wrap items-center gap-2 pb-3 text-xs text-muted-foreground">
                <Button size="sm" variant="outline" disabled={wall.running || starting} onClick={capture}>
                    {wall.running ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Camera className="h-4 w-4 mr-1" />}
                    {wall.running ? 'Capturing…' : 'Capture now'}
                </Button>
                <span>
                    {wall.finished_at ? `Last capture ${timeAgo(wall.finished_at)}` : 'No capture yet'}
                    {failed > 0 && <span className="text-red-500"> · {failed} without picture</span>}
                    {wall.paid_channels > 0 && ` · ${wall.paid_channels} paid channels not tested`}
                </span>
            </div>
            <div className="grid gap-2 grid-cols-2 md:grid-cols-3 xl:grid-cols-4">
                {wall.channels.map(c => (
                    <div key={c.channel_id} className="rounded-lg border bg-card overflow-hidden">
                        <div className="aspect-video bg-black/80 flex items-center justify-center">
                            {c.has_image ? (
                                <img src={`/api/v1/dashboard/wall/${playlistId}/${c.channel_id}.jpg?t=${encodeURIComponent(c.checked_at || '')}`}
                                    alt={`Picture of ${c.name}`} loading="lazy" className="h-full w-full object-cover" />
                            ) : c.ok === false ? (
                                <span className="px-2 text-center text-[11px] text-red-400" title={c.error || ''}>No picture</span>
                            ) : (
                                <span className="text-[11px] text-muted-foreground">{wall.running ? 'Waiting…' : 'Not captured'}</span>
                            )}
                        </div>
                        <div className="px-2 py-1.5 flex items-center gap-2 min-w-0">
                            <Number_ n={c.number} />
                            <span className="text-xs truncate" title={c.error || c.name}>{c.name}</span>
                            {c.ok === false && <span className="ml-auto h-2 w-2 rounded-full bg-red-500 shrink-0" aria-label="Down" />}
                            {c.ok === true && <span className="ml-auto h-2 w-2 rounded-full bg-emerald-500 shrink-0" aria-label="Up" />}
                        </div>
                    </div>
                ))}
            </div>
        </>
    );
};

// ---------------------------------------------------------------------------

export const TvPanel: FC<{ playlists: PlaylistRow[]; featuredId: number | null; computedAt: string | null }> = ({ playlists, featuredId }) => {
    const [tab, setTab] = useStored('home-tv-tab', 'now');
    const [chosen, setChosen] = useStored('home-tv-playlist', '');
    const usable = useMemo(() => playlists.filter(p => p.served > 0), [playlists]);
    const current = usable.find(p => String(p.id) === chosen) ?? usable.find(p => p.id === featuredId) ?? usable[0];

    const tabs: { id: Tab; label: string; icon: typeof Tv }[] = [
        { id: 'now', label: 'On air', icon: Radio },
        { id: 'tonight', label: 'Tonight', icon: Tv },
        { id: 'wall', label: 'Wall', icon: Camera },
    ];

    return (
        <Card className="p-4 space-y-4">
            <div className="flex flex-wrap items-center gap-3">
                <div className="flex items-center gap-2">
                    <Tv className="h-5 w-5 text-primary" />
                    <h3 className="text-lg font-semibold">On TV</h3>
                </div>
                <div className="flex rounded-md border p-0.5" role="tablist" aria-label="TV views">
                    {tabs.map(t => (
                        <button key={t.id} role="tab" aria-selected={tab === t.id}
                            onClick={() => setTab(t.id)}
                            className={`flex items-center gap-1.5 rounded px-3 py-1 text-sm transition-colors ${tab === t.id ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'}`}>
                            <t.icon className="h-3.5 w-3.5" /> {t.label}
                        </button>
                    ))}
                </div>
                {usable.length > 1 && (
                    <select value={current?.id ?? ''} onChange={e => setChosen(e.target.value)} aria-label="Playlist"
                        className="ml-auto h-9 max-w-[14rem] rounded-md border border-input bg-background px-2 text-sm">
                        {usable.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                    </select>
                )}
                {usable.length === 1 && <span className="ml-auto text-sm text-muted-foreground">{usable[0].name}</span>}
            </div>
            {!current ? (
                <p className="text-sm text-muted-foreground p-4 flex items-center gap-2"><RefreshCw className="h-4 w-4" /> No playlist serves a channel yet.</p>
            ) : tab === 'now' ? <NowGrid key={current.id} playlistId={current.id} />
                : tab === 'tonight' ? <TonightGrid key={current.id} playlistId={current.id} />
                    : <WallGrid key={current.id} playlistId={current.id} />}
        </Card>
    );
};
