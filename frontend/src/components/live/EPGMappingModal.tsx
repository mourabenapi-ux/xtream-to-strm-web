import { useState, useEffect, FC } from 'react';
import { Dialog } from '@/components/ui/dialog';
import { Button } from "@/components/ui/button";
import { Search, Loader2, Unlink, RotateCcw } from 'lucide-react';
import api from '@/lib/api';
import { useLiveSelection, EPGMatchDebugResponse } from '@/contexts/LiveSelectionContext';

/** Name without the provider's decorations, as a first search. */
const searchable = (name: string) => name
    .replace(/^\s*[^|:]{1,8}\s*[|:]\s*/, '')
    .replace(/\((?:\d{3,4}p|[^)]*)\)/gi, '')
    .replace(/\b(fhd|uhd|hd|sd|4k|8k|hevc|h265|raw)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();

const STATE_TEXT: Record<string, string> = {
    live: 'has a schedule',
    listed: 'is named by a guide, but no programme is published for it',
    unknown: 'is not known by any guide source linked to this playlist',
    none: 'no id',
    detached: 'detached on purpose (no id is published)',
};

export const EPGMappingModal: FC = () => {
    const {
        mappingId, setMappingId, selectEPG, epgSources, playlist, channelLabel,
        effectiveOf, getEPGDebugInfo, setGuideMode,
    } = useLiveSelection();

    const channelId = mappingId ? Number(mappingId) : null;
    const channel = channelId ? playlist?.bouquets.flatMap(b => b.channels).find(c => c.id === channelId) ?? null : null;
    const effective = channelId ? effectiveOf(channelId) : undefined;

    const [query, setQuery] = useState("");
    const [results, setResults] = useState<any[]>([]);
    const [loading, setLoading] = useState(false);
    const [suggestions, setSuggestions] = useState<EPGMatchDebugResponse | null>(null);

    useEffect(() => {
        if (!channel) return;
        setQuery(searchable(channelLabel(channel)));
        setSuggestions(null);
        getEPGDebugInfo(channel.id).then(setSuggestions);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [channel?.id]);

    useEffect(() => {
        if (!channel) return;
        const timer = setTimeout(async () => {
            if (query.trim().length < 2) { setResults([]); return; }
            setLoading(true);
            try {
                const res = await api.get(`/live/epg/search?q=${encodeURIComponent(query.trim())}`);
                setResults(res.data);
            } catch (error) {
                console.error("EPG search failed", error);
                setResults([]);
            } finally {
                setLoading(false);
            }
        }, 300);
        return () => clearTimeout(timer);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [query, channel?.id]);

    if (!channel) return null;
    const close = () => setMappingId(null);

    const pick = (epgId: string) => selectEPG(epgId);

    return (
        <Dialog isOpen onClose={close} title={`Guide for ${channelLabel(channel)}`} size="lg">
            <div className="space-y-3 text-sm">
                <div className="p-2 rounded border bg-muted/30 text-xs space-y-1">
                    <div>
                        Published id: <span className="font-mono">{effective?.epg_id || '—'}</span>
                        {effective?.epg_id && effective.epg_source === 'provider' && ' (inherited from the provider)'}
                        {effective?.guide && <> — {STATE_TEXT[effective.guide] ?? effective.guide}</>}
                    </div>
                    {effective?.now && <div>On air now: <strong>{effective.now}</strong></div>}
                    {epgSources.length === 0 && <div className="text-amber-600">No guide source is linked to this playlist: link one in Guide sources &amp; mapping.</div>}
                    <div className="flex gap-2 pt-1">
                        <Button size="sm" variant="outline" className="h-7 text-xs gap-1"
                            onClick={() => { setGuideMode([channel.id], 'detach'); close(); }}
                            title="Publish no tvg-id: better than a wrong schedule">
                            <Unlink className="h-3.5 w-3.5" /> No guide
                        </Button>
                        {channel.epg_channel_id && (
                            <Button size="sm" variant="ghost" className="h-7 text-xs gap-1"
                                onClick={() => { setGuideMode([channel.id], 'inherit'); close(); }}
                                title="Forget the mapping and use whatever id the provider declares">
                                <RotateCcw className="h-3.5 w-3.5" /> Use the provider's id
                            </Button>
                        )}
                    </div>
                </div>

                {suggestions && suggestions.candidates.length > 0 && (
                    <div>
                        <div className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground mb-1">Suggestions</div>
                        <div className="divide-y border rounded">
                            {suggestions.candidates.slice(0, 5).map(c => (
                                <button key={`${c.epg_id}-${c.source_name}`} type="button" onClick={() => pick(c.epg_id)}
                                    className="w-full flex items-center gap-3 p-2 text-left hover:bg-muted/50">
                                    <span className="flex-1 min-w-0">
                                        <span className="block font-medium truncate">{c.display_name}</span>
                                        <span className="block text-[11px] text-muted-foreground font-mono truncate">{c.epg_id} · {c.source_name}</span>
                                    </span>
                                    <span className="text-xs text-muted-foreground">{Math.round(c.composite_score)}</span>
                                </button>
                            ))}
                        </div>
                    </div>
                )}

                <div className="relative">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                    <input
                        autoFocus
                        type="text"
                        placeholder="Search the guides by channel name or id…"
                        className="w-full pl-9 p-2 bg-background border rounded-md"
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                    />
                </div>
                <div className="max-h-[40vh] overflow-y-auto border rounded divide-y">
                    {loading ? (
                        <div className="p-8 flex justify-center"><Loader2 className="h-6 w-6 animate-spin text-primary" /></div>
                    ) : results.length > 0 ? (
                        results.map((r: any) => (
                            <button key={`${r.epg_id}-${r.source_name}`} type="button" onClick={() => pick(r.epg_id)}
                                className="w-full p-2 hover:bg-muted/50 flex items-center justify-between text-left">
                                <span className="min-w-0">
                                    <span className="block font-medium truncate">{r.name}</span>
                                    <span className="block text-[11px] text-muted-foreground font-mono truncate">{r.epg_id} · {r.source_name}</span>
                                </span>
                            </button>
                        ))
                    ) : (
                        <p className="p-6 text-center text-muted-foreground text-xs">
                            {query.trim().length < 2 ? 'Type to search.' : `No guide channel matches “${query}”. Guides often use another name: try a shorter word, or the city / country.`}
                        </p>
                    )}
                </div>
            </div>
        </Dialog>
    );
};
