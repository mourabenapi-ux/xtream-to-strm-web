import { FC, useEffect, useRef, useState } from 'react';
import { Dialog } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Loader2, CheckCircle2, XCircle, AlertTriangle } from 'lucide-react';
import api from '@/lib/api';
import { useLiveSelection } from '@/contexts/LiveSelectionContext';

interface ProbeResult {
    ok: boolean;
    seconds: number;
    error?: string;
    video?: { codec: string; width: number; height: number; fps: number | null } | null;
    audio?: { codec: string; channels: number } | null;
    bitrate_kbps?: number | null;
    image?: string | null;
}

const quality = (h?: number) => (!h ? '' : h >= 2000 ? '4K' : h >= 1000 ? 'Full HD' : h >= 700 ? 'HD' : 'SD');

/**
 * Opens each stream the way a player would and reports what it found: does it
 * play, in which resolution, how long before the first image, and the image.
 * One stream at a time — providers often allow a single connection per
 * account, so testing while the TV watches can interrupt it.
 */
export const ProbeDialog: FC<{ channelIds: number[]; onClose: () => void }> = ({ channelIds, onClose }) => {
    const { playlist, channelLabel, setMappingId } = useLiveSelection();
    const [results, setResults] = useState<Record<number, ProbeResult | 'running' | 'waiting'>>({});
    const cancelled = useRef(false);
    const open = channelIds.length > 0;

    useEffect(() => {
        if (!open || !playlist) return;
        cancelled.current = false;
        setResults(Object.fromEntries(channelIds.map(id => [id, 'waiting'])));
        (async () => {
            for (const id of channelIds) {
                if (cancelled.current) break;
                setResults(prev => ({ ...prev, [id]: 'running' }));
                try {
                    const res = await api.post<ProbeResult>(`/live/playlists/${playlist.id}/channels/${id}/probe`);
                    setResults(prev => ({ ...prev, [id]: res.data }));
                } catch (error: any) {
                    setResults(prev => ({ ...prev, [id]: { ok: false, seconds: 0, error: error?.response?.data?.detail ?? 'Request failed' } }));
                }
            }
        })();
        return () => { cancelled.current = true; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [channelIds.join(',')]);

    const channels = (playlist?.bouquets ?? []).flatMap(b => b.channels);
    const single = channelIds.length === 1;

    return (
        <Dialog isOpen={open} onClose={() => { cancelled.current = true; onClose(); }} title={single ? 'Stream test' : `Testing ${channelIds.length} streams`} size={single ? 'lg' : 'xl'}>
            <div className="space-y-3 text-sm">
                <p className="text-[11px] text-muted-foreground flex gap-1.5">
                    <AlertTriangle className="h-3.5 w-3.5 text-amber-500 flex-shrink-0" />
                    Each test opens the stream for a few seconds. If your provider allows only one connection, a TV watching the same account may be interrupted.
                </p>
                <div className={single ? '' : 'max-h-[60vh] overflow-y-auto divide-y border rounded'}>
                    {channelIds.map(id => {
                        const channel = channels.find(c => c.id === id);
                        const r = results[id];
                        return (
                            <div key={id} className={`flex gap-3 ${single ? 'flex-col' : 'items-center p-2'}`}>
                                {!single && <span className="w-48 truncate font-medium">{channel ? channelLabel(channel) : id}</span>}
                                {r === 'waiting' || r === undefined ? <span className="text-xs text-muted-foreground">waiting…</span>
                                    : r === 'running' ? <span className="text-xs flex items-center gap-1.5"><Loader2 className="h-3.5 w-3.5 animate-spin" /> opening the stream (up to 25 s)…</span>
                                        : (
                                            <div className={`flex ${single ? 'flex-col' : 'items-center'} gap-3 flex-1 min-w-0`}>
                                                {r.image && <img src={r.image} alt="" className={`${single ? 'w-full' : 'h-12'} rounded border bg-black object-contain`} />}
                                                <div className="text-xs space-y-0.5 min-w-0">
                                                    <div className="flex items-center gap-1.5 font-semibold">
                                                        {r.ok ? <CheckCircle2 className="h-4 w-4 text-emerald-500" /> : <XCircle className="h-4 w-4 text-destructive" />}
                                                        {r.ok ? `Plays — ${quality(r.video?.height)} ${r.video ? `${r.video.width}×${r.video.height}` : 'audio only'}` : 'Does not play'}
                                                    </div>
                                                    {r.ok ? (
                                                        <div className="text-muted-foreground">
                                                            {r.video?.codec}{r.video?.fps ? ` · ${r.video.fps} fps` : ''}
                                                            {r.audio ? ` · ${r.audio.codec}${r.audio.channels ? ` ${r.audio.channels}ch` : ''}` : ' · no audio'}
                                                            {r.bitrate_kbps ? ` · ${(r.bitrate_kbps / 1000).toFixed(1)} Mb/s` : ''}
                                                            {` · answered in ${r.seconds} s`}
                                                            {!r.image && ' · no picture captured'}
                                                        </div>
                                                    ) : (
                                                        <div className="text-destructive break-words">{r.error} {r.seconds ? `(after ${r.seconds} s)` : ''}</div>
                                                    )}
                                                </div>
                                            </div>
                                        )}
                            </div>
                        );
                    })}
                </div>
                {single && channelIds[0] && (
                    <div className="flex justify-end gap-2">
                        <Button size="sm" variant="ghost" onClick={() => { setMappingId(String(channelIds[0])); onClose(); }}>Guide mapping</Button>
                        <Button size="sm" variant="outline" onClick={onClose}>Close</Button>
                    </div>
                )}
            </div>
        </Dialog>
    );
};
