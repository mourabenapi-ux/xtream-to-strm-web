import { FC, useEffect, useMemo, useRef, useState } from 'react';
import { Search, Loader2, Plus, ShoppingBasket, CornerDownLeft, ListTree, Check } from 'lucide-react';
import api from '@/lib/api';
import { useLiveSelection, streamKey, BasketItem, Stream } from '@/contexts/LiveSelectionContext';

interface ProviderHits {
    subscription_id: number;
    subscription_name: string;
    total: number;
    items: (Stream & { stream_id: string; category_name: string })[];
    error?: string;
}

type Entry =
    | { kind: 'channel'; id: number; label: string; group: string; number: number }
    | { kind: 'stream'; item: BasketItem; provider: string; category: string; inGroup?: string };

const norm = (text: string) => text.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();

/**
 * One search for everything: the channels already in the playlist ("where is
 * TF1?") and every provider's catalogue at once. Enter adds the highlighted
 * stream to the chosen group, Shift+Enter puts it in the basket.
 */
export const CommandPalette: FC<{ isOpen: boolean; onClose: () => void }> = ({ isOpen, onClose }) => {
    const {
        playlist, selectedBouquetId, bouquetLabel, channelLabel, membership, addStreams,
        toggleBasket, basket, revealChannel,
    } = useLiveSelection();
    const [query, setQuery] = useState('');
    const [remote, setRemote] = useState<ProviderHits[] | null>(null);
    const [loading, setLoading] = useState(false);
    const [active, setActive] = useState(0);
    const [target, setTarget] = useState<number | null>(null);
    const inputRef = useRef<HTMLInputElement>(null);
    const listRef = useRef<HTMLDivElement>(null);
    const request = useRef(0);

    useEffect(() => {
        if (!isOpen) return;
        setTarget(selectedBouquetId);
        setActive(0);
        setTimeout(() => inputRef.current?.select(), 0);
    }, [isOpen, selectedBouquetId]);

    // Provider search, debounced; a slower answer never replaces a newer one.
    useEffect(() => {
        const q = query.trim();
        if (!isOpen || q.length < 2) { setRemote(null); setLoading(false); return; }
        const id = ++request.current;
        setLoading(true);
        const timer = setTimeout(async () => {
            try {
                const res = await api.get<ProviderHits[]>('/live/search', { params: { q, limit: 25 } });
                if (id === request.current) setRemote(res.data);
            } catch {
                if (id === request.current) setRemote([]);
            } finally {
                if (id === request.current) setLoading(false);
            }
        }, 250);
        return () => clearTimeout(timer);
    }, [query, isOpen]);

    const local: Entry[] = useMemo(() => {
        const words = norm(query.trim()).split(/\s+/).filter(Boolean);
        if (!playlist || !words.length) return [];
        const out: Entry[] = [];
        for (const b of playlist.bouquets) {
            for (const c of b.channels) {
                const label = channelLabel(c);
                const text = norm(`${label} ${c.order}`);
                // A number matches as a whole number: "france 2" is not "France 24".
                if (words.every(w => (/^\d+$/.test(w) ? new RegExp(`(^|\\D)${w}(\\D|$)`).test(text) : text.includes(w)))) {
                    out.push({ kind: 'channel', id: c.id, label, group: bouquetLabel(b), number: c.order });
                    if (out.length >= 8) return out;
                }
            }
        }
        return out;
    }, [query, playlist, channelLabel, bouquetLabel]);

    const providerEntries: { provider: ProviderHits; entries: Entry[] }[] = useMemo(() => (remote ?? []).map(p => ({
        provider: p,
        entries: p.items.map(s => {
            const key = streamKey(p.subscription_id, s.stream_id);
            return {
                kind: 'stream' as const,
                item: { key, subscription_id: p.subscription_id, stream: s },
                provider: p.subscription_name,
                category: s.category_name,
                inGroup: membership.get(key),
            };
        }),
    })), [remote, membership]);

    const flat: Entry[] = useMemo(() => [...local, ...providerEntries.flatMap(p => p.entries)], [local, providerEntries]);

    useEffect(() => { setActive(0); }, [query]);
    useEffect(() => {
        listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
    }, [active]);

    if (!isOpen) return null;

    const perform = (entry: Entry | undefined, basketOnly = false) => {
        if (!entry) return;
        if (entry.kind === 'channel') {
            revealChannel(entry.id);
            onClose();
            return;
        }
        if (basketOnly || !target) toggleBasket(entry.item);
        else addStreams([entry.item], target);
    };

    const onKey = (e: React.KeyboardEvent) => {
        if (e.key === 'ArrowDown') { e.preventDefault(); setActive(i => Math.min(i + 1, flat.length - 1)); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(i => Math.max(i - 1, 0)); }
        else if (e.key === 'Enter') { e.preventDefault(); perform(flat[active], e.shiftKey); }
        else if (e.key === 'Escape') { e.preventDefault(); onClose(); }
    };

    let index = -1;
    const row = (entry: Entry) => {
        index++;
        const i = index;
        const isActive = i === active;
        if (entry.kind === 'channel') {
            return (
                <button key={`c${entry.id}`} data-index={i} type="button" onMouseEnter={() => setActive(i)} onClick={() => perform(entry)}
                    className={`w-full flex items-center gap-2 px-3 py-1.5 text-left text-sm ${isActive ? 'bg-primary/10' : ''}`}>
                    <span className="w-12 text-right font-mono text-xs text-muted-foreground">{entry.number}</span>
                    <span className="flex-1 truncate font-medium">{entry.label}</span>
                    <span className="text-xs text-muted-foreground truncate max-w-[12rem]">{entry.group}</span>
                    {isActive && <span className="text-[10px] text-muted-foreground flex items-center gap-1"><CornerDownLeft className="h-3 w-3" /> show</span>}
                </button>
            );
        }
        const picked = basket.has(entry.item.key);
        return (
            <div key={`s${entry.item.key}`} data-index={i} onMouseEnter={() => setActive(i)}
                className={`flex items-center gap-2 px-3 py-1.5 text-sm ${isActive ? 'bg-primary/10' : ''}`}>
                {entry.item.stream.stream_icon
                    ? <img src={entry.item.stream.stream_icon} alt="" className="h-5 w-5 object-contain rounded bg-muted" loading="lazy" />
                    : <span className="h-5 w-5" />}
                <button type="button" className="flex-1 min-w-0 text-left" onClick={() => perform(entry)}>
                    <span className="block truncate">{entry.item.stream.name}</span>
                    <span className="block truncate text-[10px] text-muted-foreground">
                        {entry.category}{entry.inGroup && <span className="text-emerald-600 dark:text-emerald-400"> · in {entry.inGroup}</span>}
                    </span>
                </button>
                {entry.inGroup && <Check className="h-3.5 w-3.5 text-emerald-500 flex-shrink-0" />}
                <button type="button" title="Basket (Shift+Enter)" onClick={() => toggleBasket(entry.item)}
                    className={`p-1 rounded hover:bg-muted ${picked ? 'text-primary' : 'text-muted-foreground'}`}>
                    <ShoppingBasket className="h-3.5 w-3.5" />
                </button>
                <button type="button" title="Add to the group (Enter)" disabled={!target} onClick={() => perform(entry)}
                    className="p-1 rounded hover:bg-muted text-primary disabled:opacity-30">
                    <Plus className="h-4 w-4" />
                </button>
            </div>
        );
    };

    return (
        <div className="fixed inset-0 z-50 flex items-start justify-center pt-[10vh] p-4 bg-black/50 backdrop-blur-sm" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
            <div className="w-full max-w-2xl bg-background border rounded-lg shadow-2xl overflow-hidden flex flex-col max-h-[75vh]" role="dialog" aria-label="Search channels">
                <div className="flex items-center gap-2 px-3 border-b">
                    <Search className="h-4 w-4 text-muted-foreground" />
                    <input ref={inputRef} value={query} onChange={e => setQuery(e.target.value)} onKeyDown={onKey}
                        placeholder="Search the playlist and every provider…" className="flex-1 h-12 bg-transparent outline-none text-sm" />
                    {loading && <Loader2 className="h-4 w-4 animate-spin text-primary" />}
                </div>
                <div className="flex items-center gap-2 px-3 py-1.5 border-b text-xs bg-muted/30">
                    <ListTree className="h-3.5 w-3.5 text-muted-foreground" />
                    <span className="text-muted-foreground">Enter adds to</span>
                    <select className="border rounded px-1 py-0.5 bg-background text-xs" value={target ?? ''}
                        onChange={e => setTarget(e.target.value ? Number(e.target.value) : null)}>
                        <option value="">the basket only</option>
                        {playlist?.bouquets.map(b => <option key={b.id} value={b.id}>{bouquetLabel(b)}</option>)}
                    </select>
                    <span className="ml-auto text-muted-foreground">↑↓ move · Enter add · Shift+Enter basket · Esc close</span>
                </div>
                <div ref={listRef} className="overflow-y-auto">
                    {query.trim().length < 2 ? (
                        <p className="p-6 text-center text-sm text-muted-foreground">Type at least two letters. Accents and case do not matter.</p>
                    ) : (
                        <>
                            {local.length > 0 && (
                                <div>
                                    <div className="px-3 pt-2 pb-1 text-[10px] font-bold uppercase tracking-wider text-muted-foreground">In this playlist</div>
                                    {local.map(row)}
                                </div>
                            )}
                            {providerEntries.map(({ provider, entries }) => (
                                <div key={provider.subscription_id}>
                                    <div className="px-3 pt-2 pb-1 text-[10px] font-bold uppercase tracking-wider text-muted-foreground flex justify-between">
                                        <span>{provider.subscription_name}</span>
                                        <span>{provider.error ? 'unavailable' : provider.total > entries.length ? `${entries.length} of ${provider.total}` : provider.total}</span>
                                    </div>
                                    {entries.map(row)}
                                </div>
                            ))}
                            {!loading && remote && flat.length === 0 && (
                                <p className="p-6 text-center text-sm text-muted-foreground">Nothing found for “{query}”.</p>
                            )}
                        </>
                    )}
                </div>
            </div>
        </div>
    );
};
