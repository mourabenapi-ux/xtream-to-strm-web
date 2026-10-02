import { FC, useEffect, useState } from 'react';
import { Dialog } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Loader2, SearchX } from 'lucide-react';
import api from '@/lib/api';
import { useLiveSelection } from '@/contexts/LiveSelectionContext';

interface Candidate {
    subscription_id: number;
    subscription_name: string;
    stream_id: string;
    name: string;
    category_id: string;
    quality: string;
    same_provider: boolean;
    in_playlist: boolean;
}

/**
 * The other feeds that carry the same channel: another quality, the other
 * provider, or the same channel under a new id. Used both to repair a channel
 * the provider dropped and to switch a working one to a better feed. The
 * channel keeps its row: number, name, guide mapping and position stay.
 */
export const ReplacementDialog: FC<{ channelId: number | null; onClose: () => void; mode?: 'repair' | 'variants' }> =
    ({ channelId, onClose, mode = 'repair' }) => {
        const { playlist, replaceChannel, channelLabel, effectiveOf } = useLiveSelection();
        const [candidates, setCandidates] = useState<Candidate[] | null>(null);
        const channel = playlist?.bouquets.flatMap(b => b.channels).find(c => c.id === channelId) ?? null;

        useEffect(() => {
            if (channelId === null || !playlist) return;
            setCandidates(null);
            api.get<Candidate[]>(`/live/playlists/${playlist.id}/channels/${channelId}/replacements`)
                .then(r => setCandidates(r.data))
                .catch(() => setCandidates([]));
            // eslint-disable-next-line react-hooks/exhaustive-deps
        }, [channelId]);

        const name = channel ? channelLabel(channel) : '';
        const served = channelId !== null && effectiveOf(channelId)?.served !== false;

        return (
            <Dialog isOpen={channelId !== null} onClose={onClose}
                title={mode === 'variants' ? `Other feeds of ${name}` : `Replace the stream of ${name}`} size="lg">
                <div className="space-y-3">
                    <p className="text-xs text-muted-foreground">
                        {mode === 'variants' && served
                            ? 'The same channel in another quality or at another provider. Switching keeps the number, the name and the guide mapping. Ctrl+Z switches back.'
                            : 'The provider no longer lists this stream. Pick another one carrying the same channel: the number, name and guide mapping are kept.'}
                    </p>
                    {candidates === null ? (
                        <div className="py-10 flex justify-center"><Loader2 className="h-6 w-6 animate-spin text-primary" /></div>
                    ) : candidates.length === 0 ? (
                        <div className="py-10 flex flex-col items-center gap-2 text-muted-foreground text-sm">
                            <SearchX className="h-8 w-8 opacity-30" />
                            No other feed carries a channel with this name. Search with Ctrl+K.
                        </div>
                    ) : (
                        <div className="divide-y border rounded max-h-[55vh] overflow-y-auto">
                            {candidates.map(c => (
                                <div key={`${c.subscription_id}:${c.stream_id}`} className="flex items-center gap-3 p-2 text-sm">
                                    <span className="w-12 text-center text-[10px] font-bold rounded bg-muted py-0.5">{c.quality || '—'}</span>
                                    <div className="flex-1 min-w-0">
                                        <div className="font-medium truncate">{c.name}</div>
                                        <div className="text-[11px] text-muted-foreground">
                                            {c.subscription_name}
                                            {c.same_provider && (mode === 'variants' ? ' · same provider' : ' · same provider, new id')}
                                            {c.in_playlist && ' · already elsewhere in this playlist'}
                                        </div>
                                    </div>
                                    <Button size="sm" variant={c.in_playlist ? 'outline' : 'default'} onClick={async () => {
                                        await replaceChannel(channelId!, c.subscription_id, c.stream_id);
                                        onClose();
                                    }}>Use this one</Button>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            </Dialog>
        );
    };
