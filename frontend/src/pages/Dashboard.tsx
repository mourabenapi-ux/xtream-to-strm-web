import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, RefreshCw, ServerCrash } from 'lucide-react';
import api from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { useToast } from '@/contexts/ToastContext';
import { setPublicBase, timeAgo, type Overview } from '@/lib/home';
import { useActionRunner } from '@/components/home/actions';
import { usePolling } from '@/components/home/usePolling';
import { TvPanel } from '@/components/home/TvPanel';
import { PlaylistsPanel } from '@/components/home/PlaylistsPanel';
import { SourcesPanel } from '@/components/home/SourcesPanel';
import { LibraryPanel } from '@/components/home/LibraryPanel';
import { ActivityPanel } from '@/components/home/ActivityPanel';
import { SystemStrip } from '@/components/home/SystemStrip';

/**
 * What your television and Jellyfin receive, right now.
 *
 * The page reads one stored snapshot (GET /dashboard/overview), which the
 * server rebuilds every five minutes by running the playlist editor's own
 * health check on every playlist. The previous dashboard counted what the app
 * intended — a channel with a guide id was "covered" — and showed 100 % on a
 * playlist where none of the channels had a programme.
 */
export default function Dashboard() {
    const toast = useToast();
    const [data, setData] = useState<Overview | null>(null);
    const [failed, setFailed] = useState(false);
    const [waiting, setWaiting] = useState(false);
    const baseline = useRef<string | null>(null);
    const deadline = useRef(0);
    const [clockNow, setClockNow] = useState(() => new Date());

    useEffect(() => {
        const id = setInterval(() => setClockNow(new Date()), 30000);
        return () => clearInterval(id);
    }, []);

    const load = useCallback(async () => {
        try {
            const res = await api.get<Overview>('/dashboard/overview');
            setData(res.data);
            setFailed(false);
            setPublicBase(res.data.settings.public_base_url);
            if (waiting && (res.data.computed_at !== baseline.current || Date.now() > deadline.current)) setWaiting(false);
        } catch {
            setFailed(true);
        }
    }, [waiting]);

    const busy = !!data && (data.pending || data.refreshing || waiting);
    usePolling(load, busy ? 3000 : 10000, [busy, load]);

    /** Ask the server for a fresh look, then follow it until it lands. */
    const recheck = useCallback(async () => {
        baseline.current = data?.computed_at ?? null;
        deadline.current = Date.now() + 90000;
        setWaiting(true);
        try {
            await api.post('/dashboard/refresh');
        } catch (err) {
            setWaiting(false);
            toast.apiError('Could not start the check', err);
        }
    }, [data?.computed_at, toast]);

    const { run, running } = useActionRunner(recheck);

    const raw = clockNow.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' });
    const heading = raw.charAt(0).toUpperCase() + raw.slice(1);
    const time = clockNow.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    if (!data && !failed) {
        return <div className="flex items-center justify-center h-[50vh]"><Loader2 className="h-8 w-8 animate-spin text-primary" /></div>;
    }
    if (!data) {
        return (
            <Card className="max-w-lg mx-auto mt-16 p-8 text-center space-y-3">
                <ServerCrash className="h-10 w-10 mx-auto text-red-500" />
                <h2 className="text-xl font-semibold">The server does not answer</h2>
                <p className="text-sm text-muted-foreground">The dashboard will load by itself as soon as it comes back. If this lasts, look at the container's logs.</p>
                <Button variant="outline" onClick={load}>Try again</Button>
            </Card>
        );
    }

    return (
        <div className="space-y-5 pb-10 max-w-7xl mx-auto">
            <div className="flex flex-wrap items-end justify-between gap-3">
                <div>
                    <h2 className="text-2xl sm:text-3xl font-bold tracking-tight">{heading} <span className="text-muted-foreground font-normal normal-case">· {time}</span></h2>
                    <p className="text-muted-foreground text-sm">What your TV and Jellyfin receive, right now.</p>
                </div>
                <div className="flex items-center gap-2">
                    <Button variant="outline" size="sm" onClick={recheck} disabled={busy} title={data.computed_at ? `Last check ${timeAgo(data.computed_at)}` : undefined}>
                        <RefreshCw className={`h-4 w-4 mr-2 ${busy ? 'animate-spin' : ''}`} />
                        {busy ? 'Checking…' : 'Check now'}
                    </Button>
                </div>
            </div>

            {failed && (
                <p className="text-xs rounded-md bg-amber-500/10 border border-amber-500/30 text-amber-700 dark:text-amber-400 px-3 py-2">
                    The server stopped answering. What follows may be out of date.
                </p>
            )}

            {data.pending ? (
                <Card className="p-8 text-center space-y-3">
                    <Loader2 className="h-8 w-8 mx-auto animate-spin text-primary" />
                    <h3 className="text-lg font-semibold">First check in progress</h3>
                    <p className="text-sm text-muted-foreground max-w-md mx-auto">
                        Looking at every playlist, guide and library. It takes about twenty seconds, and only happens after a restart.
                    </p>
                </Card>
            ) : (
                <>
                    <TvPanel playlists={data.playlists} featuredId={data.featured_playlist_id} computedAt={data.computed_at} />
                    <PlaylistsPanel playlists={data.playlists} onChanged={recheck} />
                    <div className="grid gap-5 lg:grid-cols-2 items-start">
                        <SourcesPanel providers={data.providers} guides={data.guides} running={running} onAction={run} />
                        <LibraryPanel library={data.library} jellyfin={data.jellyfin} running={running} onAction={run} />
                    </div>
                    <ActivityPanel tasks={data.tasks} events={data.events} />
                    <SystemStrip data={data} />
                </>
            )}
        </div>
    );
}
