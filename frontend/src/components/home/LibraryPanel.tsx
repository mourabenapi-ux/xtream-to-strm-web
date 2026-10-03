import { FC, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Film, HardDrive, Library as LibraryIcon, Loader2, Tv } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { bytes, number, timeAgo, type ActionSpec, type Jellyfin, type Library } from '@/lib/home';

const Tile: FC<{ icon: typeof Film; label: string; value: string; sub: string }> = ({ icon: Icon, label, value, sub }) => (
    <div className="rounded-lg border bg-card p-3 min-w-0">
        <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-muted-foreground">
            <Icon className="h-3.5 w-3.5" /> {label}
        </div>
        <div className="text-2xl font-semibold mt-1">{value}</div>
        <div className="text-xs text-muted-foreground truncate">{sub}</div>
    </div>
);

const Poster: FC<{ id: string; name: string; sub: string }> = ({ id, name, sub }) => {
    const [failed, setFailed] = useState(false);
    return (
        <div className="w-24 shrink-0" title={name}>
            <div className="aspect-[2/3] rounded-md bg-muted overflow-hidden flex items-center justify-center">
                {failed
                    ? <span className="px-1 text-center text-[11px] text-muted-foreground">{name}</span>
                    : <img src={`/api/v1/dashboard/jellyfin/image/${id}`} alt={name} loading="lazy" className="h-full w-full object-cover" onError={() => setFailed(true)} />}
            </div>
            <div className="text-xs font-medium truncate mt-1">{name}</div>
            <div className="text-[11px] text-muted-foreground truncate">{sub}</div>
        </div>
    );
};

export const LibraryPanel: FC<{
    library: Library;
    jellyfin: Jellyfin;
    running: string | null;
    onAction: (a: ActionSpec, id: string) => void;
}> = ({ library, jellyfin, running, onAction }) => {
    const navigate = useNavigate();
    const strm = library.strm;
    const dl = library.downloaded;
    const queue = library.downloads;

    const ours = (role: string | null): number | null => {
        if (role === 'strm_movies') return strm?.movies ?? null;
        if (role === 'strm_series') return strm?.shows ?? null;
        if (role === 'downloads_movies') return dl?.movies ?? null;
        return null;
    };

    return (
        <Card className="p-4 space-y-4">
            <div className="flex items-center justify-between gap-2">
                <h3 className="text-lg font-semibold flex items-center gap-2"><LibraryIcon className="h-5 w-5 text-primary" /> Libraries</h3>
                <Button size="sm" variant="ghost" onClick={() => navigate('/downloads/manager')}>Downloads</Button>
            </div>

            <div className="grid grid-cols-2 gap-2">
                <Tile icon={Film} label="Streamed movies" value={number(strm?.movies)} sub=".strm files written" />
                <Tile icon={Tv} label="Streamed series" value={number(strm?.shows)} sub={`${number(strm?.episodes)} episodes`} />
                <Tile icon={HardDrive} label="Downloaded" value={number((dl?.movies ?? 0) + (dl?.episodes ?? 0))} sub={`${bytes(dl?.bytes)} on disk`} />
                <Tile icon={Loader2} label="Download queue" value={number((queue?.running ?? 0) + (queue?.queued ?? 0))}
                    sub={queue?.failed ? `${queue.failed} failed so far` : `${queue?.completed ?? 0} completed`} />
            </div>

            {!jellyfin.configured ? (
                <div className="rounded-lg border border-dashed p-4 text-sm flex flex-wrap items-center gap-3">
                    <div className="flex-1 min-w-[12rem]">
                        <div className="font-medium">Connect Jellyfin</div>
                        <div className="text-muted-foreground text-xs">See what was added, and whether Jellyfin has picked up everything written here.</div>
                    </div>
                    <Button size="sm" variant="outline" onClick={() => navigate('/admin#integrations')}>Set up</Button>
                </div>
            ) : !jellyfin.ok ? (
                <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm">
                    <div className="font-medium text-amber-700 dark:text-amber-400">Jellyfin does not answer</div>
                    <div className="text-xs text-muted-foreground">{jellyfin.error}</div>
                    <Button size="sm" variant="outline" className="mt-2" onClick={() => navigate('/admin#integrations')}>Check the settings</Button>
                </div>
            ) : (
                <div className="space-y-3">
                    <div className="text-xs text-muted-foreground">
                        {jellyfin.server}{jellyfin.version ? ` ${jellyfin.version}` : ''}
                    </div>
                    <ul className="space-y-1.5">
                        {(jellyfin.libraries ?? []).map(l => {
                            const mine = ours(l.role);
                            const behind = mine !== null && l.count !== null && mine - l.count > Math.max(3, mine * 0.02);
                            return (
                                <li key={l.name} className="flex items-center gap-2 text-sm">
                                    <span className="font-medium truncate">{l.name}</span>
                                    <span className="text-muted-foreground ml-auto shrink-0">
                                        {l.count !== null ? `${number(l.count)} in Jellyfin` : l.type}
                                        {mine !== null && l.count !== null && ` · ${number(mine)} here`}
                                    </span>
                                    {behind && <span className="rounded-full bg-amber-500/15 text-amber-600 dark:text-amber-400 px-2 py-0.5 text-[11px] shrink-0">behind</span>}
                                </li>
                            );
                        })}
                    </ul>
                    <Button size="sm" variant="outline" disabled={running === 'jf-scan'}
                        onClick={() => onAction({ kind: 'jellyfin_scan', label: 'Scan' }, 'jf-scan')}>
                        {running === 'jf-scan' && <Loader2 className="h-4 w-4 mr-1 animate-spin" />} Scan libraries
                    </Button>
                    {(jellyfin.recent ?? []).length > 0 && (
                        <div>
                            <div className="text-xs uppercase tracking-wider text-muted-foreground mb-2">Recently added</div>
                            <div className="flex gap-3 overflow-x-auto pb-2 -mx-1 px-1">
                                {jellyfin.recent!.map(c => (
                                    <Poster key={c.id} id={c.id} name={c.name}
                                        sub={c.type === 'series' ? `${c.episodes} new episode${c.episodes === 1 ? '' : 's'}` : (c.year ? String(c.year) : timeAgo(c.added_at))} />
                                ))}
                            </div>
                        </div>
                    )}
                </div>
            )}
        </Card>
    );
};
