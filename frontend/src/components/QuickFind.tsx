import { FC, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { CornerDownLeft, FileText, Loader2, Search, Tv } from 'lucide-react';
import api from '@/lib/api';
import { Dialog } from '@/components/ui/dialog';
import type { FindHit } from '@/lib/home';

const norm = (text: string) => text.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();

type Entry =
    | { kind: 'page'; label: string; path: string }
    | { kind: 'channel'; hit: FindHit };

/**
 * Ctrl+K from any screen: "where is TF1?" answers with the playlists that
 * carry it, its number and what it is showing now; a page name jumps there.
 * The playlist editor has its own Ctrl+K (it searches the providers and adds
 * channels), so this one stays out of its way.
 */
export const QuickFind: FC<{ pages: Record<string, string> }> = ({ pages }) => {
    const location = useLocation();
    const navigate = useNavigate();
    const onEditor = location.pathname === '/live-selection';
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState('');
    const [hits, setHits] = useState<FindHit[]>([]);
    const [loading, setLoading] = useState(false);
    const [active, setActive] = useState(0);
    const request = useRef(0);
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k' && !onEditor) {
                e.preventDefault();
                setOpen(o => !o);
            }
        };
        const onOpen = () => { if (!onEditor) setOpen(true); };
        window.addEventListener('keydown', onKey);
        window.addEventListener('open-quickfind', onOpen);
        return () => {
            window.removeEventListener('keydown', onKey);
            window.removeEventListener('open-quickfind', onOpen);
        };
    }, [onEditor]);

    useEffect(() => { setOpen(false); }, [location.pathname]);
    useEffect(() => {
        if (open) { setQuery(''); setHits([]); setActive(0); setTimeout(() => inputRef.current?.focus(), 0); }
    }, [open]);

    useEffect(() => {
        const q = query.trim();
        if (!open || q.length < 1) { setHits([]); setLoading(false); return; }
        const id = ++request.current;
        setLoading(true);
        const timer = setTimeout(async () => {
            try {
                const res = await api.get<FindHit[]>('/dashboard/find', { params: { q } });
                if (id === request.current) { setHits(res.data); setActive(0); }
            } catch {
                if (id === request.current) setHits([]);
            } finally {
                if (id === request.current) setLoading(false);
            }
        }, 200);
        return () => clearTimeout(timer);
    }, [query, open]);

    const entries: Entry[] = useMemo(() => {
        const words = norm(query.trim()).split(/\s+/).filter(Boolean);
        const matching: Entry[] = words.length
            ? Object.entries(pages)
                .filter(([path, label]) => path !== '/live-selection' && words.every(w => norm(label).includes(w)))
                .slice(0, 4).map(([path, label]) => ({ kind: 'page' as const, label, path }))
            : [];
        return [...hits.map(hit => ({ kind: 'channel' as const, hit })), ...matching];
    }, [hits, query, pages]);

    const choose = (entry: Entry | undefined) => {
        if (!entry) return;
        setOpen(false);
        navigate(entry.kind === 'page' ? entry.path : `/live-selection?playlist_id=${entry.hit.playlist_id}`);
    };

    const onKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'ArrowDown') { e.preventDefault(); setActive(a => Math.min(a + 1, entries.length - 1)); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(a => Math.max(a - 1, 0)); }
        else if (e.key === 'Enter') { e.preventDefault(); choose(entries[active]); }
    };

    return (
        <Dialog isOpen={open} onClose={() => setOpen(false)} title="Find a channel or a page" size="lg">
            <div className="space-y-3">
                <div className="relative">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                    <input ref={inputRef} value={query} onChange={e => setQuery(e.target.value)} onKeyDown={onKeyDown}
                        placeholder="TF1, France 2, 332, logs…" aria-label="Search"
                        className="flex h-10 w-full rounded-md border border-input bg-background pl-9 pr-9 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" />
                    {loading && <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 animate-spin text-muted-foreground" />}
                </div>
                <ul className="space-y-0.5" role="listbox">
                    {entries.map((e, i) => (
                        <li key={e.kind === 'page' ? `p-${e.path}` : `c-${e.hit.playlist_id}-${e.hit.channel_id}-${i}`} role="option" aria-selected={i === active}>
                            <button onMouseEnter={() => setActive(i)} onClick={() => choose(e)}
                                className={`w-full flex items-center gap-3 rounded-md px-3 py-2 text-left ${i === active ? 'bg-accent' : ''}`}>
                                {e.kind === 'page' ? (
                                    <>
                                        <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
                                        <span className="text-sm">{e.label}</span>
                                    </>
                                ) : (
                                    <>
                                        <Tv className="h-4 w-4 text-muted-foreground shrink-0" />
                                        {e.hit.number ? <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] font-mono shrink-0">{e.hit.number}</span> : null}
                                        <div className="min-w-0 flex-1">
                                            <div className="text-sm truncate">{e.hit.name}</div>
                                            <div className="text-xs text-muted-foreground truncate">
                                                {e.hit.playlist}{e.hit.group ? ` · ${e.hit.group}` : ''}
                                                {e.hit.now ? ` · now: ${e.hit.now}` : e.hit.guide === 'none' ? ' · no guide id' : ' · no programme'}
                                            </div>
                                        </div>
                                    </>
                                )}
                                {i === active && <CornerDownLeft className="h-3.5 w-3.5 text-muted-foreground shrink-0" />}
                            </button>
                        </li>
                    ))}
                </ul>
                {query.trim() && !loading && entries.length === 0 && (
                    <p className="text-sm text-muted-foreground text-center py-4">No channel or page matches “{query.trim()}”.</p>
                )}
                {!query.trim() && (
                    <p className="text-xs text-muted-foreground text-center py-2">
                        Type a channel name or number to see which playlists carry it, or a page name to go there.
                    </p>
                )}
            </div>
        </Dialog>
    );
};
