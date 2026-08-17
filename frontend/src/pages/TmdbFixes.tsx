import { useEffect, useMemo, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
    Loader2, Tags, Search, ExternalLink, Save, RotateCcw, AlertTriangle,
    ChevronLeft, ChevronRight,
} from 'lucide-react';
import { useToast } from '@/contexts/ToastContext';
import api from '@/lib/api';

interface Subscription { id: number; name: string; kind?: string; }

interface LibraryItem {
    item_id: string;
    name: string;
    current_tmdb_id: string | null;
    override_tmdb_id: string | null;
    override_id: number | null;
    has_override: boolean;
    pending: boolean;
}

interface LibraryPage {
    items: LibraryItem[];
    total: number;
    page: number;
    pages: number;
    override_count: number;
    pending_count: number;
}

type MediaType = 'movie' | 'series';

/**
 * Corrects the TMDB id a title is written under.
 *
 * The list is the library, not the provider's catalogue: every row is something
 * a sync has actually written to disk, so what is shown is what Jellyfin is
 * reading. Nothing here touches the files — a correction is stored and applied
 * by the next sync of that source, which is also what renames the folder.
 */
export default function TmdbFixes() {
    const toast = useToast();

    const [subscriptions, setSubscriptions] = useState<Subscription[]>([]);
    const [subscriptionId, setSubscriptionId] = useState<number | null>(null);
    const [mediaType, setMediaType] = useState<MediaType>('movie');
    const [search, setSearch] = useState('');
    const [query, setQuery] = useState('');
    const [onlyOverridden, setOnlyOverridden] = useState(false);
    const [page, setPage] = useState(1);

    const [data, setData] = useState<LibraryPage | null>(null);
    const [loading, setLoading] = useState(false);
    const [drafts, setDrafts] = useState<Record<string, string>>({});
    const [saving, setSaving] = useState<string | null>(null);
    const [toClear, setToClear] = useState<LibraryItem | null>(null);

    useEffect(() => {
        (async () => {
            try {
                const res = await api.get<Subscription[]>('/subscriptions');
                setSubscriptions(res.data);
                if (res.data.length > 0) setSubscriptionId(res.data[0].id);
            } catch (error) {
                toast.apiError('Could not load sources', error);
            }
        })();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const load = async () => {
        if (!subscriptionId) return;
        setLoading(true);
        try {
            const res = await api.get<LibraryPage>('/tmdb-overrides/library', {
                params: {
                    subscription_id: subscriptionId,
                    media_type: mediaType,
                    q: query || undefined,
                    only_overridden: onlyOverridden,
                    page,
                    page_size: 50,
                },
            });
            setData(res.data);
            setDrafts({});
        } catch (error) {
            toast.apiError('Could not load the library', error);
            setData(null);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        load();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [subscriptionId, mediaType, query, onlyOverridden, page]);

    // A new filter always starts at the first page; staying on page 7 of a
    // narrower result shows an empty screen that reads like "nothing found".
    useEffect(() => { setPage(1); }, [subscriptionId, mediaType, query, onlyOverridden]);

    /** What is in the box for a row: the pending edit, or what is stored. */
    const valueOf = (item: LibraryItem) =>
        drafts[item.item_id] ?? (item.override_tmdb_id ?? item.current_tmdb_id ?? '');

    const isDirty = (item: LibraryItem) => {
        const draft = drafts[item.item_id];
        if (draft === undefined) return false;
        const stored = item.override_tmdb_id ?? item.current_tmdb_id ?? '';
        return draft.trim() !== stored;
    };

    const save = async (item: LibraryItem) => {
        if (!subscriptionId) return;
        const raw = (drafts[item.item_id] ?? '').trim();
        setSaving(item.item_id);
        try {
            await api.put('/tmdb-overrides', {
                subscription_id: subscriptionId,
                media_type: mediaType,
                item_id: item.item_id,
                label: item.name,
                // An empty box is an answer: "this title has no TMDB entry".
                tmdb_id: raw === '' ? null : raw,
            });
            toast.success('Correction saved',
                `${item.name} → ${raw === '' ? 'no TMDB id' : raw}. Applied on the next sync.`);
            await load();
        } catch (error) {
            toast.apiError('Could not save the correction', error);
        } finally {
            setSaving(null);
        }
    };

    const clearOverride = async () => {
        if (!toClear?.override_id) return;
        try {
            await api.delete(`/tmdb-overrides/${toClear.override_id}`);
            toast.success('Correction removed',
                `${toClear.name} follows the provider again from the next sync.`);
            await load();
        } catch (error) {
            toast.apiError('Could not remove the correction', error);
        } finally {
            setToClear(null);
        }
    };

    const tmdbSearchUrl = (item: LibraryItem) =>
        `https://www.themoviedb.org/search/${mediaType === 'movie' ? 'movie' : 'tv'}` +
        `?query=${encodeURIComponent(item.name)}`;

    const items = data?.items ?? [];
    const summary = useMemo(() => {
        if (!data) return null;
        return { total: data.total, overrides: data.override_count, pending: data.pending_count };
    }, [data]);

    return (
        <div className="space-y-6">
            <div>
                <h1 className="text-3xl font-bold flex items-center gap-2">
                    <Tags className="text-primary" /> TMDB Fixes
                </h1>
                <p className="text-muted-foreground mt-1">
                    The id each title is written under. Correct one here and the next sync
                    of that source renames its folder and rewrites its NFO — nothing on
                    disk changes before that.
                </p>
            </div>

            <Card>
                <CardHeader>
                    <CardTitle className="text-lg">What to look at</CardTitle>
                    <CardDescription>
                        Only titles a sync has already written are listed.
                    </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                    <div className="flex flex-wrap gap-3 items-end">
                        <div className="min-w-[14rem]">
                            <Label htmlFor="tmdb-source">Source</Label>
                            <select
                                id="tmdb-source"
                                className="w-full h-10 px-3 rounded-md border border-input bg-background text-sm"
                                value={subscriptionId ?? ''}
                                onChange={e => setSubscriptionId(Number(e.target.value))}
                            >
                                {subscriptions.map(s => (
                                    <option key={s.id} value={s.id}>{s.name}</option>
                                ))}
                            </select>
                        </div>
                        <div className="flex gap-2">
                            <Button size="sm" variant={mediaType === 'movie' ? 'default' : 'outline'}
                                onClick={() => setMediaType('movie')}>Movies</Button>
                            <Button size="sm" variant={mediaType === 'series' ? 'default' : 'outline'}
                                onClick={() => setMediaType('series')}>Series</Button>
                        </div>
                        <Button size="sm" variant={onlyOverridden ? 'default' : 'outline'}
                            onClick={() => setOnlyOverridden(v => !v)}>
                            Corrected only
                        </Button>
                    </div>

                    <form
                        className="flex gap-2"
                        onSubmit={e => { e.preventDefault(); setQuery(search.trim()); }}
                    >
                        <Input
                            placeholder="Search a title…"
                            value={search}
                            onChange={e => setSearch(e.target.value)}
                        />
                        <Button type="submit" variant="outline">
                            <Search className="h-4 w-4" />
                        </Button>
                    </form>

                    {summary && (
                        <div className="flex flex-wrap gap-4 text-sm text-muted-foreground">
                            <span>{summary.total} title(s)</span>
                            <span>{summary.overrides} corrected</span>
                            {summary.pending > 0 && (
                                <span className="text-amber-500 flex items-center gap-1">
                                    <AlertTriangle size={14} />
                                    {summary.pending} waiting for a sync
                                </span>
                            )}
                        </div>
                    )}
                </CardContent>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle className="text-lg">
                        {mediaType === 'movie' ? 'Movies' : 'Series'} in the library
                    </CardTitle>
                    <CardDescription>
                        Paste the number from a themoviedb.org URL. Empty the box to say the
                        title has no TMDB entry at all.
                    </CardDescription>
                </CardHeader>
                <CardContent>
                    {loading ? (
                        <div className="flex items-center gap-2 text-muted-foreground py-8 justify-center">
                            <Loader2 className="h-4 w-4 animate-spin" /> Reading the library…
                        </div>
                    ) : items.length === 0 ? (
                        <p className="text-muted-foreground py-8 text-center">
                            Nothing here. This source has no synced {mediaType === 'movie' ? 'movies' : 'series'} matching the filters.
                        </p>
                    ) : (
                        <div className="divide-y">
                            {items.map(item => (
                                <div key={item.item_id}
                                    className="flex flex-wrap items-center gap-3 py-2">
                                    <div className="flex-1 min-w-[12rem]">
                                        <div className="truncate">{item.name}</div>
                                        <div className="text-xs text-muted-foreground flex gap-2">
                                            <span>on disk: {item.current_tmdb_id ?? 'no id'}</span>
                                            {item.pending && (
                                                <span className="text-amber-500">
                                                    → {item.override_tmdb_id ?? 'no id'} on next sync
                                                </span>
                                            )}
                                            {item.has_override && !item.pending && (
                                                <span className="text-emerald-600">corrected</span>
                                            )}
                                        </div>
                                    </div>
                                    <Input
                                        className="w-32"
                                        inputMode="numeric"
                                        placeholder="TMDB id"
                                        value={valueOf(item)}
                                        onChange={e => setDrafts(prev => ({
                                            ...prev, [item.item_id]: e.target.value,
                                        }))}
                                    />
                                    <a href={tmdbSearchUrl(item)} target="_blank" rel="noreferrer"
                                        title="Look this title up on themoviedb.org"
                                        className="text-muted-foreground hover:text-foreground">
                                        <ExternalLink size={16} />
                                    </a>
                                    <Button size="sm" variant="outline"
                                        disabled={!isDirty(item) || saving === item.item_id}
                                        onClick={() => save(item)}>
                                        {saving === item.item_id
                                            ? <Loader2 className="h-4 w-4 animate-spin" />
                                            : <Save className="h-4 w-4" />}
                                    </Button>
                                    <Button size="sm" variant="outline"
                                        disabled={!item.has_override}
                                        title="Follow the provider again"
                                        onClick={() => setToClear(item)}>
                                        <RotateCcw className="h-4 w-4" />
                                    </Button>
                                </div>
                            ))}
                        </div>
                    )}

                    {data && data.pages > 1 && (
                        <div className="flex items-center justify-center gap-3 pt-4">
                            <Button size="sm" variant="outline" disabled={page <= 1}
                                onClick={() => setPage(p => p - 1)}>
                                <ChevronLeft className="h-4 w-4" />
                            </Button>
                            <span className="text-sm text-muted-foreground">
                                Page {data.page} of {data.pages}
                            </span>
                            <Button size="sm" variant="outline" disabled={page >= data.pages}
                                onClick={() => setPage(p => p + 1)}>
                                <ChevronRight className="h-4 w-4" />
                            </Button>
                        </div>
                    )}
                </CardContent>
            </Card>

            <ConfirmDialog
                isOpen={toClear !== null}
                onClose={() => setToClear(null)}
                onConfirm={clearOverride}
                title="Remove this correction"
                confirmLabel="Remove"
            >
                <p>
                    <strong>{toClear?.name}</strong> will use whatever TMDB id the provider
                    gives, from the next sync of this source.
                </p>
            </ConfirmDialog>
        </div>
    );
}
