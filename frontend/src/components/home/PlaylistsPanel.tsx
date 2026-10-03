import { FC, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Check, Copy, Pencil, Tv2 } from 'lucide-react';
import api from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { useToast } from '@/contexts/ToastContext';
import { copyText, isLocalOnly, number, shortUrls, timeAgo, type PlaylistRow } from '@/lib/home';

/** The real guide coverage as a ring: channels with a programme, not channels with an id. */
const Ring: FC<{ percent: number; bad: boolean }> = ({ percent, bad }) => {
    const r = 15;
    const c = 2 * Math.PI * r;
    const color = bad ? 'stroke-red-500' : percent >= 60 ? 'stroke-emerald-500' : percent >= 20 ? 'stroke-amber-500' : 'stroke-red-500';
    return (
        <svg width="40" height="40" viewBox="0 0 40 40" className="shrink-0" role="img" aria-label={`${percent}% of channels have a programme`}>
            <circle cx="20" cy="20" r={r} fill="none" strokeWidth="4" className="stroke-secondary" />
            <circle cx="20" cy="20" r={r} fill="none" strokeWidth="4" strokeLinecap="round" className={color}
                strokeDasharray={`${(c * percent) / 100} ${c}`} transform="rotate(-90 20 20)" />
            <text x="20" y="24" textAnchor="middle" fontSize="11" className="fill-foreground font-medium">{percent}</text>
        </svg>
    );
};

function playerLine(p: PlaylistRow): { text: string; tone: string } {
    const m3u = p.players.filter(x => x.kind === 'm3u');
    const real = m3u.filter(x => !['Browser', 'Unknown', 'curl', 'wget', 'Script', 'FFmpeg'].includes(x.client));
    const best = (real.length ? real : m3u)[0];
    if (!best) return { text: 'No player yet', tone: 'text-muted-foreground/70' };
    const xml = p.players.find(x => x.kind === 'xml' && x.client === best.client);
    const stale = best.last_at ? Date.now() - new Date(best.last_at).getTime() > 3 * 86400000 : true;
    return {
        text: `${best.client} · playlist ${timeAgo(best.last_at)}${xml ? ` · guide ${timeAgo(xml.last_at)}` : ''}`,
        tone: stale ? 'text-amber-600 dark:text-amber-400' : 'text-emerald-600 dark:text-emerald-400',
    };
}

const TvModeDialog: FC<{ playlist: PlaylistRow | null; onClose: () => void; onSaved: () => void }> = ({ playlist, onClose, onSaved }) => {
    const toast = useToast();
    const [alias, setAlias] = useState('');
    const [busy, setBusy] = useState(false);
    const [seen, setSeen] = useState<number | null>(null);

    if (playlist && seen !== playlist.id) { setSeen(playlist.id); setAlias(playlist.short_name || ''); }
    if (!playlist) {
        if (seen !== null) setSeen(null); // reopening the same playlist starts from what is saved
        return null;
    }

    const clean = alias.trim().toLowerCase();
    const urls = shortUrls({ key: clean || playlist.public_id || String(playlist.id) });
    const local = isLocalOnly(urls.m3u);
    const changed = clean !== (playlist.short_name || '');

    const save = async () => {
        setBusy(true);
        try {
            await api.put(`/live/playlists/${playlist.id}`, { short_name: clean || null });
            toast.success('Short name saved', clean ? `/p/${clean}.m3u` : 'Back to the automatic name.');
            onSaved();
        } catch (err) {
            toast.apiError('Could not save the short name', err);
        } finally {
            setBusy(false);
        }
    };

    return (
        <Dialog isOpen onClose={onClose} title={`Type it on the remote: ${playlist.name}`} size="lg">
            <div className="space-y-5">
                {local && (
                    <p className="text-sm rounded-md bg-amber-500/10 border border-amber-500/30 p-3 text-amber-700 dark:text-amber-400">
                        These addresses start with <code>localhost</code>, which a TV cannot reach. Set the address of this machine
                        (for example <code>http://192.168.1.20</code>) in Administration, under Integrations.
                    </p>
                )}
                {([['Playlist', urls.m3u], ['Guide', urls.xml]] as const).map(([label, url]) => (
                    <div key={label}>
                        <div className="text-xs uppercase tracking-wider text-muted-foreground mb-1">{label}</div>
                        <div className="font-mono text-2xl sm:text-3xl font-semibold break-all leading-tight select-all">{url}</div>
                    </div>
                ))}
                <div className="border-t pt-4 space-y-2">
                    <label className="text-sm font-medium" htmlFor="alias">Short name</label>
                    <div className="flex gap-2">
                        <Input id="alias" value={alias} maxLength={20} placeholder={playlist.public_id || 'fr'}
                            onChange={e => setAlias(e.target.value)} />
                        <Button onClick={save} disabled={busy || !changed}>Save</Button>
                    </div>
                    <p className="text-xs text-muted-foreground">
                        1 to 20 lowercase letters, digits, - or _. The old addresses keep working.
                    </p>
                </div>
            </div>
        </Dialog>
    );
};

export const PlaylistsPanel: FC<{ playlists: PlaylistRow[]; onChanged: () => void }> = ({ playlists, onChanged }) => {
    const navigate = useNavigate();
    const toast = useToast();
    const [copied, setCopied] = useState<string | null>(null);
    const [tvMode, setTvMode] = useState<PlaylistRow | null>(null);

    const copy = async (url: string, id: string) => {
        if (!(await copyText(url))) { toast.error('Could not copy', 'Open the TV view and read the address from there.'); return; }
        setCopied(id);
        setTimeout(() => setCopied(c => (c === id ? null : c)), 1800);
    };

    return (
        <Card className="p-4">
            <div className="flex items-center justify-between gap-2 pb-2">
                <h3 className="text-lg font-semibold">Playlists, as the player receives them</h3>
                <Button size="sm" variant="ghost" onClick={() => navigate('/live-playlists')}>Manage</Button>
            </div>
            {playlists.length === 0 && <p className="text-sm text-muted-foreground py-4">No playlist yet. Create one in Live Playlists.</p>}
            <ul className="divide-y">
                {playlists.map(p => {
                    const urls = shortUrls(p);
                    const line = playerLine(p);
                    const allDead = p.rows > 0 && p.served === 0;
                    const issues = p.issues.filter(i => i.severity !== 'info');
                    return (
                        <li key={p.id} className="py-3 flex flex-wrap sm:flex-nowrap items-center gap-3">
                            <Ring percent={p.schedule_percentage} bad={allDead || p.rows === 0} />
                            <div className="min-w-[10rem] flex-1">
                                <div className="flex items-center gap-2">
                                    <button className="font-medium truncate hover:underline text-left"
                                        onClick={() => navigate(`/live-selection?playlist_id=${p.id}`)}>{p.name}</button>
                                    {p.short_name && <span className="text-[11px] font-mono text-muted-foreground">/p/{p.short_name}</span>}
                                </div>
                                <div className="text-xs text-muted-foreground">
                                    {p.rows === 0 ? 'Empty' : <>
                                        {number(p.served)} served
                                        {p.dead > 0 && <span className="text-red-500"> · {p.dead} down</span>}
                                        {issues.length > 0 && <span className="text-amber-600 dark:text-amber-400"> · {issues.length} to check</span>}
                                        {' · '}guide on {p.schedule_percentage}%
                                    </>}
                                </div>
                                <div className={`text-xs ${line.tone}`}>{line.text}</div>
                            </div>
                            <div className="flex items-center gap-1 shrink-0">
                                <Button size="sm" variant="outline" onClick={() => copy(urls.m3u, `${p.id}-m3u`)} aria-label={`Copy the playlist address of ${p.name}`}>
                                    {copied === `${p.id}-m3u` ? <Check className="h-4 w-4 mr-1 text-emerald-500" /> : <Copy className="h-4 w-4 mr-1" />} M3U
                                </Button>
                                <Button size="sm" variant="outline" onClick={() => copy(urls.xml, `${p.id}-xml`)} aria-label={`Copy the guide address of ${p.name}`}>
                                    {copied === `${p.id}-xml` ? <Check className="h-4 w-4 mr-1 text-emerald-500" /> : <Copy className="h-4 w-4 mr-1" />} EPG
                                </Button>
                                <Button size="icon" variant="ghost" className="h-9 w-9" onClick={() => setTvMode(p)} aria-label={`Show the addresses of ${p.name} in large type`} title="Large type, for the remote">
                                    <Tv2 className="h-4 w-4" />
                                </Button>
                                <Button size="icon" variant="ghost" className="h-9 w-9" onClick={() => navigate(`/live-selection?playlist_id=${p.id}`)} aria-label={`Edit ${p.name}`} title="Open the editor">
                                    <Pencil className="h-4 w-4" />
                                </Button>
                            </div>
                        </li>
                    );
                })}
            </ul>
            <TvModeDialog playlist={tvMode} onClose={() => setTvMode(null)} onSaved={() => { setTvMode(null); onChanged(); }} />
        </Card>
    );
};
