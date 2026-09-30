import { createContext, useContext, useState, useCallback, FC, ReactNode, useMemo, useRef } from 'react';
import api from '@/lib/api';
import { arrayMove } from '@dnd-kit/sortable';
import { useToast } from '@/contexts/ToastContext';

// Types
interface Category {
    category_id: string;
    category_name: string;
    parent_id: number;
}

interface Stream {
    num: number;
    name: string;
    stream_type: string;
    stream_id: number | string;
    stream_icon: string;
    epg_channel_id: string;
    category_id: string;
}

interface PlaylistChannel {
    id: number;
    stream_id: string;
    subscription_id: number | null;
    custom_name: string | null;
    order: number;
    is_excluded: boolean;
    epg_channel_id: string | null;
}

interface PlaylistBouquet {
    id: number;
    category_id: string | null;
    subscription_id: number | null;
    custom_name: string | null;
    order: number;
    channels: PlaylistChannel[];
}

interface Playlist {
    id: number;
    public_id: string | null;
    subscription_id: number | null;
    name: string;
    description: string | null;
    use_channel_numbers?: boolean;
    bouquets: PlaylistBouquet[];
}

interface EPGSource {
    id: number;
    name: string;
    source_type: string;
    source_url: string | null;
    is_active: boolean;
}

interface EPGMatchCandidate {
    epg_id: string;
    display_name: string;
    fuzzy_score: number;
    priority: number;
    composite_score: number;
    source_name: string;
}

export interface EPGMatchDebugResponse {
    target_name: string;
    candidates: EPGMatchCandidate[];
}

/** Groups and channels share one edit slot, so the kind is part of the id. */
export const editKey = (kind: 'b' | 'c', id: number) => `${kind}:${id}`;

const HISTORY_LIMIT = 50;

// Context State
interface LiveSelectionContextType {
    // Core State
    playlist: Playlist | null;
    selectedBouquetId: number | null;
    setSelectedBouquetId: (id: number | null) => void;

    // Stream Library
    categories: Category[];
    streams: Stream[];
    selectedCategory: string | null;
    setSelectedCategory: (id: string | null) => void;
    setStreams: (streams: Stream[]) => void;
    sourceSubscriptionId: number | null;
    setSourceSubscriptionId: (id: number | null) => void;
    sourceSubscriptionName: string;
    allSubscriptions: any[];

    // EPG
    epgSources: EPGSource[];
    mappingId: string | null;
    setMappingId: (id: string | null) => void;

    // Labels (one place decides what a row is called)
    bouquetLabel: (b: PlaylistBouquet) => string;
    channelLabel: (c: PlaylistChannel) => string;
    channelEditableName: (c: PlaylistChannel) => string;
    /** `subscription:stream` -> name of the group that already holds it. */
    membership: Map<string, string>;

    // UI/UX States
    includedCategoryIds: string[];
    excludedStreamIds: Set<string>;
    sourceNames: Record<string, string>;
    editingId: string | null;
    editValue: string;
    setEditValue: (val: string) => void;
    compactMode: boolean;
    setCompactMode: (val: boolean) => void;

    // Statistics
    stats: {
        totalChannels: number;
        totalGroups: number;
        epgMappedCount: number;
        epgPercentage: number;
    };

    // Loading / saving states
    loading: boolean;
    loadingCategories: boolean;
    loadingStreams: boolean;
    /** True while at least one write is on its way to the server. */
    saving: boolean;
    /** Set when the last write failed; the screen was then reloaded from the server. */
    syncError: string | null;
    totalStreams: number;
    streamsPage: number;
    totalStreamsPages: number;
    useChannelNumbers: boolean;
    setUseChannelNumbers: (value: boolean) => Promise<void>;

    // Actions
    fetchPlaylist: (id: number) => Promise<void>;
    fetchCategories: (subId: number) => Promise<void>;
    fetchStreams: (subId: number, catId: string, page?: number) => Promise<void>;
    resetPlaylist: () => void;
    startEditing: (id: string, value: string) => void;
    cancelEditing: () => void;
    saveEdit: () => Promise<void>;

    // Bouquet Actions
    addVirtualBouquet: (name: string) => Promise<void>;
    deleteBouquet: (id: number) => Promise<void>;
    reorderBouquets: (activeId: number, overId: number) => Promise<void>;

    // Channel Actions
    addStreamToBouquet: (stream: Stream) => Promise<void>;
    bulkAddStreamsToBouquet: (streams: Stream[]) => Promise<void>;
    removeStreamFromBouquet: (channelId: number) => Promise<void>;
    reorderChannels: (activeId: number, overId: number) => Promise<void>;
    jumpToChannelPosition: (channelId: number, newPosition: number) => Promise<void>;
    moveChannelToBouquet: (channelId: number, targetBouquetId: number) => Promise<void>;
    duplicateBouquet: (id: number) => Promise<void>;

    // Selection & Bulk Actions
    selectedChannelIds: Set<number>;
    setSelectedChannelIds: (ids: Set<number>) => void;
    toggleChannelSelection: (id: number) => void;
    bulkDeleteChannels: (ids: number[]) => Promise<void>;
    bulkMoveChannels: (channelIds: number[], targetBouquetId: number) => Promise<void>;
    exportBouquet: (id: number) => void;
    importBouquet: (file: File) => Promise<void>;

    // EPG Actions
    selectEPG: (epgId: string) => void;
    getEPGDebugInfo: (channelId: number) => Promise<EPGMatchDebugResponse | null>;

    // History Actions
    undo: () => void;
    redo: () => void;
    canUndo: boolean;
    canRedo: boolean;
}

const LiveSelectionContext = createContext<LiveSelectionContextType | undefined>(undefined);

const sortedBouquets = (bouquets: PlaylistBouquet[]): PlaylistBouquet[] =>
    [...bouquets]
        .sort((a, b) => a.order - b.order)
        .map(b => ({ ...b, channels: [...b.channels].sort((x, y) => x.order - y.order) }));

const streamKey = (subscriptionId: number | null | undefined, streamId: string | number) =>
    `${subscriptionId ?? ''}:${streamId}`;

export const LiveSelectionProvider: FC<{ children: ReactNode }> = ({ children }) => {
    const toast = useToast();

    const [playlist, setPlaylistState] = useState<Playlist | null>(null);
    // Handlers run several times between two renders (a bulk move, a drag that
    // ends while a save is still in flight), so they read the latest playlist
    // from here rather than from the render they were created in.
    const playlistRef = useRef<Playlist | null>(null);

    const [categories, setCategories] = useState<Category[]>([]);
    const [streams, setStreams] = useState<Stream[]>([]);
    const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
    const [sourceNames, setSourceNames] = useState<Record<string, string>>({});
    const [editingId, setEditingId] = useState<string | null>(null);
    const [editValue, setEditValue] = useState("");
    const editingRef = useRef<{ id: string | null; value: string }>({ id: null, value: "" });
    const [compactMode, setCompactMode] = useState(false);

    const [selectedBouquetId, setSelectedBouquetId] = useState<number | null>(null);
    const [sourceSubscriptionId, setSourceSubscriptionId] = useState<number | null>(null);
    const [allSubscriptions, setAllSubscriptions] = useState<any[]>([]);
    const [selectedChannelIds, setSelectedChannelIds] = useState<Set<number>>(new Set());

    const [mappingId, setMappingId] = useState<string | null>(null);
    const [epgSources, setEpgSources] = useState<EPGSource[]>([]);
    const [useChannelNumbers, setUseChannelNumbersState] = useState(false);

    const [loading, setLoading] = useState(false);
    const [loadingCategories, setLoadingCategories] = useState(false);
    const [loadingStreams, setLoadingStreams] = useState(false);
    const [pending, setPending] = useState(0);
    const [syncError, setSyncError] = useState<string | null>(null);
    const [totalStreams, setTotalStreams] = useState(0);
    const [streamsPage, setStreamsPage] = useState(1);
    const [totalStreamsPages, setTotalStreamsPages] = useState(1);
    const streamRequest = useRef(0);

    // History: whole-playlist snapshots. Replaying one also rewrites the server
    // (see `undo`), so what the screen shows is always what the player gets.
    const past = useRef<Playlist[]>([]);
    const future = useRef<Playlist[]>([]);
    const [historySize, setHistorySize] = useState({ past: 0, future: 0 });
    const syncHistorySize = () => setHistorySize({ past: past.current.length, future: future.current.length });

    const show = (next: Playlist | null) => {
        playlistRef.current = next;
        setPlaylistState(next);
    };

    /** Applies a change on screen and records the state it replaces. */
    const commit = (next: Playlist) => {
        if (playlistRef.current) {
            past.current.push(playlistRef.current);
            if (past.current.length > HISTORY_LIMIT) past.current.shift();
        }
        future.current = [];
        show(next);
        syncHistorySize();
    };

    const resetHistory = () => {
        past.current = [];
        future.current = [];
        syncHistorySize();
    };

    // ---- server writes -----------------------------------------------------
    // Writes are applied on screen first and sent one at a time, in order. If
    // one fails the screen is reloaded from the server, so it can never keep
    // showing a change that was not saved.
    const queue = useRef<Promise<unknown>>(Promise.resolve());

    const loadPlaylist = useCallback(async (id: number, keepContext: boolean) => {
        if (!keepContext) setLoading(true);
        try {
            const [res, subs] = await Promise.all([
                api.get<Playlist>(`/live/playlists/${id}`),
                keepContext ? Promise.resolve(null) : api.get<any[]>('/subscriptions/'),
            ]);
            const data: Playlist = { ...res.data, bouquets: sortedBouquets(res.data.bouquets) };
            show(data);
            resetHistory();
            setUseChannelNumbersState(!!res.data.use_channel_numbers);
            setSelectedChannelIds(new Set());
            setSelectedBouquetId(prev =>
                prev !== null && data.bouquets.some(b => b.id === prev)
                    ? prev
                    : (data.bouquets[0]?.id ?? null));

            if (!keepContext && subs) {
                setAllSubscriptions(subs.data);
                // A playlist built by the organiser has no subscription of its
                // own. Browse the provider most of its channels come from, else
                // the first one, instead of an empty explorer.
                const tally = new Map<number, number>();
                data.bouquets.forEach(b => b.channels.forEach(c => {
                    const sub = c.subscription_id ?? b.subscription_id;
                    if (sub) tally.set(sub, (tally.get(sub) ?? 0) + 1);
                }));
                const dominant = [...tally.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
                const source = data.subscription_id ?? dominant ?? subs.data[0]?.id ?? null;
                setSourceSubscriptionId(source);
                if (source) fetchCategoriesRef.current(source);

                api.get<any[]>(`/live/playlists/${id}/epg-sources`)
                    .then(r => setEpgSources(r.data.map(link => link.epg_source).filter(s => s && s.is_active)))
                    .catch(err => console.error("Failed to fetch EPG sources", err));
                // Names come from the provider, not from our tables, so they are
                // resolved separately. A failure only means channels keep
                // showing their stream id.
                api.get<Record<string, string>>(`/live/playlists/${id}/channel-names`)
                    .then(r => setSourceNames(r.data))
                    .catch(err => console.error("Failed to resolve channel names", err));
            }
        } finally {
            if (!keepContext) setLoading(false);
        }
    }, []);

    const enqueue = useCallback((label: string, job: () => Promise<unknown>): Promise<void> => {
        setPending(n => n + 1);
        const run = queue.current.then(job).then(() => {
            setSyncError(null);
        }).catch(async (error) => {
            console.error(`${label} failed`, error);
            toast.apiError(`${label} failed — the screen was reloaded from the server`, error);
            setSyncError(`${label} failed`);
            const current = playlistRef.current;
            if (current) {
                try { await loadPlaylist(current.id, true); } catch (e) { console.error(e); }
            }
        }).finally(() => setPending(n => n - 1));
        queue.current = run;
        return run;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [loadPlaylist]);

    /** Change the screen now, tell the server in order. */
    const mutate = (label: string, compute: (p: Playlist) => Playlist | null,
        remote: () => Promise<unknown>): Promise<void> => {
        const current = playlistRef.current;
        if (!current) return Promise.resolve();
        const next = compute(current);
        if (!next) return Promise.resolve();
        commit(next);
        return enqueue(label, remote);
    };

    const replaceBouquet = (p: Playlist, id: number, change: (b: PlaylistBouquet) => PlaylistBouquet): Playlist => ({
        ...p, bouquets: p.bouquets.map(b => (b.id === id ? change(b) : b)),
    });

    /**
     * After a reorder, the channels take over the order values the group already
     * had, in the new sequence. On a numbered playlist `order` is the channel
     * number a player shows (Info starts at 350, Secours at 20000), so writing
     * 0..n-1 would wipe the numbering; permuting the existing values keeps it.
     * Only when the values are not distinct (plain positions) is 0..n-1 used.
     */
    const reassignOrders = (before: PlaylistChannel[], after: PlaylistChannel[]) => {
        const slots = before.map(c => c.order).sort((a, b) => a - b);
        const distinct = new Set(slots).size === slots.length;
        return after.map((c, i) => ({ ...c, order: distinct ? slots[i] : i }));
    };

    /** Smallest number above `from` that no channel of the playlist uses yet. */
    const nextFreeNumber = (p: Playlist, from: number, taken?: Set<number>) => {
        const used = taken ?? new Set(p.bouquets.flatMap(b => b.channels.map(c => c.order)));
        let n = from + 1;
        while (used.has(n)) n++;
        used.add(n);
        return n;
    };

    const snapshotOf = (p: Playlist) => ({
        bouquets: p.bouquets.map(b => ({
            id: b.id, subscription_id: b.subscription_id, category_id: b.category_id,
            custom_name: b.custom_name, order: b.order,
            channels: b.channels.map(c => ({
                id: c.id, stream_id: String(c.stream_id), subscription_id: c.subscription_id,
                custom_name: c.custom_name, order: c.order, is_excluded: c.is_excluded,
                epg_channel_id: c.epg_channel_id,
            })),
        })),
    });

    const replay = (target: Playlist) => {
        show(target);
        setSelectedBouquetId(prev =>
            prev !== null && target.bouquets.some(b => b.id === prev) ? prev : (target.bouquets[0]?.id ?? null));
        setSelectedChannelIds(new Set());
        syncHistorySize();
        return enqueue('Undo/redo', () => api.put(`/live/playlists/${target.id}/snapshot`, snapshotOf(target)));
    };

    const undo = useCallback(() => {
        const current = playlistRef.current;
        const previous = past.current.pop();
        if (!current || !previous) return;
        future.current.push(current);
        replay(previous);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [enqueue]);

    const redo = useCallback(() => {
        const current = playlistRef.current;
        const next = future.current.pop();
        if (!current || !next) return;
        past.current.push(current);
        replay(next);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [enqueue]);

    // ---- library ------------------------------------------------------------
    const fetchCategories = useCallback(async (subId: number) => {
        setLoadingCategories(true);
        try {
            const res = await api.get<Category[]>(`/live/categories?subscription_id=${subId}`);
            setCategories(res.data);
        } catch (error) {
            console.error("Failed to fetch categories", error);
            setCategories([]);
        } finally {
            setLoadingCategories(false);
        }
    }, []);
    const fetchCategoriesRef = useRef(fetchCategories);
    fetchCategoriesRef.current = fetchCategories;

    const fetchStreams = useCallback(async (subId: number, catId: string, page: number = 1) => {
        const request = ++streamRequest.current;
        setLoadingStreams(true);
        try {
            const res = await api.get<any>(`/live/streams/${catId}`, {
                params: { subscription_id: subId, page, page_size: 200 }
            });
            // A slower answer for a category the user already left must not
            // overwrite the one on screen.
            if (request !== streamRequest.current) return;
            if (page === 1) setStreams(res.data.items);
            else setStreams(prev => [...prev, ...res.data.items]);
            setTotalStreams(res.data.total);
            setStreamsPage(res.data.page);
            setTotalStreamsPages(res.data.pages);
        } catch (error) {
            console.error("Failed to fetch streams", error);
        } finally {
            if (request === streamRequest.current) setLoadingStreams(false);
        }
    }, []);

    const selectCategory = useCallback((id: string | null) => {
        setSelectedCategory(id);
        if (id && sourceSubscriptionId) {
            fetchStreams(sourceSubscriptionId, id);
        } else {
            streamRequest.current++;
            setStreams([]);
            setLoadingStreams(false);
        }
    }, [sourceSubscriptionId, fetchStreams]);

    const fetchPlaylist = useCallback(async (id: number) => {
        try {
            await loadPlaylist(id, false);
        } catch (error) {
            console.error("Failed to fetch playlist", error);
            toast.apiError('Could not load the playlist', error);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [loadPlaylist]);

    const resetPlaylist = useCallback(() => {
        const current = playlistRef.current;
        if (current) fetchPlaylist(current.id);
    }, [fetchPlaylist]);

    // ---- labels -------------------------------------------------------------
    const bouquetLabel = useCallback((b: PlaylistBouquet) => {
        if (b.custom_name) return b.custom_name;
        if (b.category_id) {
            const category = categories.find(c => c.category_id === b.category_id);
            return category ? category.category_name : 'Smart group';
        }
        return 'Untitled group';
    }, [categories]);

    const channelLabel = useCallback((c: PlaylistChannel) =>
        c.custom_name || sourceNames[String(c.id)] || `Channel ${c.stream_id}`, [sourceNames]);

    const channelEditableName = useCallback((c: PlaylistChannel) =>
        c.custom_name || sourceNames[String(c.id)] || '', [sourceNames]);

    const membership = useMemo(() => {
        const map = new Map<string, string>();
        if (!playlist) return map;
        playlist.bouquets.forEach(b => b.channels.forEach(c => {
            const key = streamKey(c.subscription_id ?? b.subscription_id ?? playlist.subscription_id, c.stream_id);
            if (!map.has(key)) map.set(key, bouquetLabel(b));
        }));
        return map;
    }, [playlist, bouquetLabel]);

    const includedCategoryIds = useMemo(
        () => (playlist?.bouquets ?? []).filter(b => b.category_id).map(b => b.category_id as string),
        [playlist]);

    const excludedStreamIds = useMemo(() => {
        const excluded = new Set<string>();
        playlist?.bouquets.forEach(b => b.channels.forEach(c => {
            if (c.is_excluded) excluded.add(streamKey(c.subscription_id ?? b.subscription_id ?? playlist.subscription_id, c.stream_id));
        }));
        return excluded;
    }, [playlist]);

    const stats = useMemo(() => {
        if (!playlist) return { totalChannels: 0, totalGroups: 0, epgMappedCount: 0, epgPercentage: 0 };
        let total = 0;
        let mapped = 0;
        playlist.bouquets.forEach(b => b.channels.forEach(c => {
            total++;
            if (c.epg_channel_id) mapped++;
        }));
        return {
            totalChannels: total,
            totalGroups: playlist.bouquets.length,
            epgMappedCount: mapped,
            epgPercentage: total > 0 ? Math.round((mapped / total) * 100) : 0,
        };
    }, [playlist]);

    const sourceSubscriptionName = useMemo(
        () => allSubscriptions.find(s => s.id === sourceSubscriptionId)?.name ?? '',
        [allSubscriptions, sourceSubscriptionId]);

    // ---- groups -------------------------------------------------------------
    const addVirtualBouquet = async (name: string) => {
        const current = playlistRef.current;
        if (!name.trim() || !current) return;
        await enqueue('Adding the group', async () => {
            const res = await api.post(`/live/playlists/${current.id}/bouquets`, [{
                custom_name: name.trim(),
                order: playlistRef.current!.bouquets.length,
                subscription_id: sourceSubscriptionId,
            }]);
            const created: PlaylistBouquet = { channels: [], ...res.data[0] };
            commit({ ...playlistRef.current!, bouquets: [...playlistRef.current!.bouquets, created] });
            setSelectedBouquetId(created.id);
        });
    };

    const deleteBouquet = async (id: number) => {
        const current = playlistRef.current;
        if (!current) return;
        const index = current.bouquets.findIndex(b => b.id === id);
        const neighbour = current.bouquets[index + 1] ?? current.bouquets[index - 1];
        if (selectedBouquetId === id) setSelectedBouquetId(neighbour?.id ?? null);
        await mutate('Deleting the group',
            p => ({ ...p, bouquets: p.bouquets.filter(b => b.id !== id) }),
            () => api.delete(`/live/playlists/${current.id}/bouquets/${id}`));
    };

    const reorderBouquets = async (activeId: number, overId: number) => {
        await mutate('Reordering the groups', p => {
            const oldIndex = p.bouquets.findIndex(b => b.id === activeId);
            const newIndex = p.bouquets.findIndex(b => b.id === overId);
            if (oldIndex === -1 || newIndex === -1 || oldIndex === newIndex) return null;
            return { ...p, bouquets: arrayMove(p.bouquets, oldIndex, newIndex).map((b, i) => ({ ...b, order: i })) };
        }, () => api.patch(`/live/playlists/${playlistRef.current!.id}/bouquets/reorder`,
            playlistRef.current!.bouquets.map((b, i) => ({ id: b.id, order: i }))));
    };

    const duplicateBouquet = async (id: number) => {
        const current = playlistRef.current;
        if (!current) return;
        await enqueue('Duplicating the group', async () => {
            const res = await api.post(`/live/playlists/${current.id}/bouquets/${id}/duplicate`);
            const copy: PlaylistBouquet = { ...res.data, channels: sortedBouquets([res.data])[0].channels };
            commit({ ...playlistRef.current!, bouquets: [...playlistRef.current!.bouquets, copy] });
            setSelectedBouquetId(copy.id);
        });
    };

    // ---- channels -----------------------------------------------------------
    /** The group that receives additions, or a message saying why there is none. */
    const targetBouquet = (): PlaylistBouquet | null => {
        const current = playlistRef.current;
        const target = current?.bouquets.find(b => b.id === selectedBouquetId) ?? null;
        if (!target) toast.info('Select a group first', 'Pick the group on the right that should receive the channels.');
        return target;
    };

    const addStreamToBouquet = async (stream: Stream) => {
        const target = targetBouquet();
        const current = playlistRef.current;
        if (!target || !current) return;
        const key = streamKey(sourceSubscriptionId, stream.stream_id);
        if (target.channels.some(c => streamKey(c.subscription_id ?? target.subscription_id ?? current.subscription_id, c.stream_id) === key)) {
            toast.info('Already in this group', `${stream.name} is already in ${bouquetLabel(target)}.`);
            return;
        }
        await enqueue('Adding the channel', async () => {
            const live = playlistRef.current!;
            const group = live.bouquets.find(b => b.id === target.id);
            if (!group) return;
            const res = await api.post(`/live/bouquets/${target.id}/channels/add`, {
                stream_id: String(stream.stream_id),
                subscription_id: sourceSubscriptionId,
                custom_name: stream.name,
                order: useChannelNumbers
                    ? nextFreeNumber(live, Math.max(-1, ...group.channels.map(c => c.order)))
                    : group.channels.length,
                is_excluded: false,
            });
            if (group.channels.some(c => c.id === res.data.id)) return;
            commit(replaceBouquet(live, target.id, b => ({ ...b, channels: [...b.channels, res.data] })));
        });
    };

    const bulkAddStreamsToBouquet = async (streamsToAdd: Stream[]) => {
        const target = targetBouquet();
        const current = playlistRef.current;
        if (!target || !current || streamsToAdd.length === 0) return;
        const have = new Set(target.channels.map(c =>
            streamKey(c.subscription_id ?? target.subscription_id ?? current.subscription_id, c.stream_id)));
        const fresh = streamsToAdd.filter(s => !have.has(streamKey(sourceSubscriptionId, s.stream_id)));
        const skipped = streamsToAdd.length - fresh.length;
        if (fresh.length === 0) {
            toast.info('Nothing to add', `All ${skipped} channel(s) are already in ${bouquetLabel(target)}.`);
            return;
        }
        await enqueue('Adding the channels', async () => {
            const live = playlistRef.current!;
            const group = live.bouquets.find(b => b.id === target.id);
            if (!group) return;
            const taken = new Set(live.bouquets.flatMap(b => b.channels.map(c => c.order)));
            let last = Math.max(-1, ...group.channels.map(c => c.order));
            const res = await api.post(`/live/playlists/${live.id}/bouquets/${target.id}/channels`,
                fresh.map((s, i) => {
                    if (useChannelNumbers) last = nextFreeNumber(live, last, taken);
                    return {
                        stream_id: String(s.stream_id),
                        subscription_id: sourceSubscriptionId,
                        custom_name: s.name,
                        order: useChannelNumbers ? last : group.channels.length + i,
                        is_excluded: false,
                    };
                }));
            const returned: PlaylistChannel[] = res.data;
            const ids = new Set(returned.map(c => c.id));
            commit(replaceBouquet(live, target.id, b => ({
                ...b,
                channels: [...b.channels.filter(c => !ids.has(c.id)), ...returned].sort((x, y) => x.order - y.order),
            })));
            toast.success(`${returned.length} channel(s) added to ${bouquetLabel(target)}`,
                skipped ? `${skipped} already there.` : undefined);
        });
    };

    const findChannel = (p: Playlist, channelId: number) => {
        for (const b of p.bouquets) {
            const channel = b.channels.find(c => c.id === channelId);
            if (channel) return { bouquet: b, channel };
        }
        return null;
    };

    const removeStreamFromBouquet = async (channelId: number) => {
        const current = playlistRef.current;
        if (!current) return;
        await mutate('Removing the channel',
            p => ({ ...p, bouquets: p.bouquets.map(b => ({ ...b, channels: b.channels.filter(c => c.id !== channelId) })) }),
            () => api.delete(`/live/playlists/${current.id}/channels/${channelId}`));
    };

    const sendChannelOrder = (bouquetId: number) => () => {
        const p = playlistRef.current!;
        const b = p.bouquets.find(x => x.id === bouquetId);
        return api.patch(`/live/playlists/${p.id}/bouquets/${bouquetId}/channels/reorder`,
            (b?.channels ?? []).map(c => ({ id: c.id, order: c.order })));
    };

    const reorderChannels = async (activeId: number, overId: number) => {
        const bouquetId = selectedBouquetId;
        if (bouquetId === null) return;
        await mutate('Reordering the channels', p => {
            const bouquet = p.bouquets.find(b => b.id === bouquetId);
            if (!bouquet) return null;
            const oldIndex = bouquet.channels.findIndex(c => c.id === activeId);
            const newIndex = bouquet.channels.findIndex(c => c.id === overId);
            if (oldIndex === -1 || newIndex === -1 || oldIndex === newIndex) return null;
            return replaceBouquet(p, bouquetId, b => ({
                ...b, channels: reassignOrders(b.channels, arrayMove(b.channels, oldIndex, newIndex)),
            }));
        }, sendChannelOrder(bouquetId));
    };

    /**
     * The box next to a channel. On a numbered playlist it sets the channel's
     * number (refused when another channel already has it); otherwise it moves
     * the channel to that 1-based position in the full group, not in a filtered
     * view.
     */
    const jumpToChannelPosition = async (channelId: number, value: number) => {
        const bouquetId = selectedBouquetId;
        const current = playlistRef.current;
        if (bouquetId === null || !current) return;

        if (useChannelNumbers) {
            if (!Number.isInteger(value) || value < 1) return;
            const owner = current.bouquets.flatMap(b => b.channels).find(c => c.order === value && c.id !== channelId);
            if (owner) {
                toast.error(`Number ${value} is taken`, `${channelLabel(owner)} already has it.`);
                return;
            }
            await mutate('Changing the channel number', p => replaceBouquet(p, bouquetId, b => ({
                ...b,
                channels: b.channels.map(c => (c.id === channelId ? { ...c, order: value } : c))
                    .sort((x, y) => x.order - y.order),
            })), sendChannelOrder(bouquetId));
            return;
        }

        await mutate('Moving the channel', p => {
            const bouquet = p.bouquets.find(b => b.id === bouquetId);
            if (!bouquet) return null;
            const oldIndex = bouquet.channels.findIndex(c => c.id === channelId);
            const newIndex = Math.max(0, Math.min(value - 1, bouquet.channels.length - 1));
            if (oldIndex === -1 || oldIndex === newIndex) return null;
            return replaceBouquet(p, bouquetId, b => ({
                ...b, channels: reassignOrders(b.channels, arrayMove(b.channels, oldIndex, newIndex)),
            }));
        }, sendChannelOrder(bouquetId));
    };

    const moveChannels = async (channelIds: number[], targetBouquetId: number) => {
        const current = playlistRef.current;
        if (!current || channelIds.length === 0) return;
        const target = current.bouquets.find(b => b.id === targetBouquetId);
        if (!target) return;
        await mutate('Moving the channels', p => {
            const moving = new Set(channelIds);
            const outside = new Map<number, PlaylistChannel>();
            p.bouquets.forEach(b => {
                if (b.id !== targetBouquetId) b.channels.forEach(c => outside.set(c.id, c));
            });
            // Same order as the request, which is the order the server appends in.
            const incoming = channelIds.map(id => outside.get(id)).filter((c): c is PlaylistChannel => !!c);
            if (incoming.length === 0) return null;
            const targetKeys = new Set(
                p.bouquets.find(b => b.id === targetBouquetId)!.channels
                    .map(c => streamKey(c.subscription_id, c.stream_id)));
            // A channel the target already holds is merged into it, never doubled.
            const fresh = incoming.filter(c => !targetKeys.has(streamKey(c.subscription_id, c.stream_id)));
            // Numbered playlist: the channel keeps its number. Otherwise it is
            // a position and goes to the end. Mirrors the server.
            let tail = Math.max(-1, ...p.bouquets.find(b => b.id === targetBouquetId)!.channels.map(c => c.order));
            const adding = useChannelNumbers ? fresh : fresh.map(c => ({ ...c, order: ++tail }));
            return {
                ...p,
                bouquets: p.bouquets.map(b => {
                    if (b.id === targetBouquetId) {
                        return { ...b, channels: [...b.channels, ...adding].sort((x, y) => x.order - y.order) };
                    }
                    return { ...b, channels: b.channels.filter(c => !moving.has(c.id)) };
                }),
            };
        }, () => api.post(`/live/playlists/${current.id}/channels/move`, {
            channel_ids: channelIds, target_bouquet_id: targetBouquetId,
        }));
    };

    const moveChannelToBouquet = (channelId: number, targetBouquetId: number) =>
        moveChannels([channelId], targetBouquetId);

    const bulkMoveChannels = async (channelIds: number[], targetBouquetId: number) => {
        await moveChannels(channelIds, targetBouquetId);
        setSelectedChannelIds(new Set());
    };

    const bulkDeleteChannels = async (ids: number[]) => {
        const current = playlistRef.current;
        if (!current || ids.length === 0) return;
        const doomed = new Set(ids);
        setSelectedChannelIds(new Set());
        await mutate('Removing the channels',
            p => ({ ...p, bouquets: p.bouquets.map(b => ({ ...b, channels: b.channels.filter(c => !doomed.has(c.id)) })) }),
            () => api.post(`/live/playlists/${current.id}/channels/bulk`, { channel_ids: ids }));
    };

    const toggleChannelSelection = (id: number) => {
        setSelectedChannelIds(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    };

    // ---- renaming -----------------------------------------------------------
    const startEditing = (id: string, value: string) => {
        editingRef.current = { id, value };
        setEditingId(id);
        setEditValue(value);
    };

    const cancelEditing = () => {
        editingRef.current = { id: null, value: "" };
        setEditingId(null);
        setEditValue("");
    };

    const changeEditValue = (value: string) => {
        editingRef.current.value = value;
        setEditValue(value);
    };

    const saveEdit = async () => {
        // Enter and the blur it causes both land here; only the first counts.
        const { id, value } = editingRef.current;
        const current = playlistRef.current;
        cancelEditing();
        if (!id || !current) return;
        const [kind, rawId] = id.split(':');
        const targetId = Number(rawId);

        if (kind === 'b') {
            const name = value.trim();
            const bouquet = current.bouquets.find(b => b.id === targetId);
            if (!bouquet || !name || name === bouquet.custom_name) return;
            await mutate('Renaming the group',
                p => replaceBouquet(p, targetId, b => ({ ...b, custom_name: name })),
                () => api.post(`/live/playlists/${current.id}/bouquets`, [{
                    id: targetId, category_id: bouquet.category_id, subscription_id: bouquet.subscription_id,
                    custom_name: name, order: bouquet.order,
                }]));
        } else {
            const found = findChannel(current, targetId);
            const name = value.trim();
            if (!found || name === (found.channel.custom_name ?? '')) return;
            await mutate('Renaming the channel',
                p => ({ ...p, bouquets: p.bouquets.map(b => ({
                    ...b, channels: b.channels.map(c => (c.id === targetId ? { ...c, custom_name: name || null } : c)),
                })) }),
                () => api.post(`/live/playlists/${current.id}/channels/${targetId}/rename`, { custom_name: name }));
        }
    };

    // ---- guide --------------------------------------------------------------
    const selectEPG = (epgId: string) => {
        if (!mappingId) return;
        const channelId = Number(mappingId);
        setMappingId(null);
        mutate('Saving the guide mapping',
            p => ({ ...p, bouquets: p.bouquets.map(b => ({
                ...b, channels: b.channels.map(c => (c.id === channelId ? { ...c, epg_channel_id: epgId } : c)),
            })) }),
            () => api.post(`/live/epg-mapping/${channelId}`, { epg_channel_id: epgId }));
    };

    const getEPGDebugInfo = useCallback(async (channelId: number): Promise<EPGMatchDebugResponse | null> => {
        const current = playlistRef.current;
        if (!current) return null;
        try {
            const res = await api.get<EPGMatchDebugResponse>(`/live/playlists/${current.id}/channels/${channelId}/epg-debug`);
            return res.data;
        } catch (error) {
            console.error("Failed to fetch EPG debug info", error);
            return null;
        }
    }, []);

    // ---- playlist settings ----------------------------------------------------
    const setUseChannelNumbers = async (value: boolean) => {
        const current = playlistRef.current;
        if (!current) return;
        setUseChannelNumbersState(value);
        await enqueue('Saving the numbering option',
            () => api.put(`/live/playlists/${current.id}`, { use_channel_numbers: value }));
    };

    // ---- import / export ------------------------------------------------------
    const exportBouquet = (id: number) => {
        const current = playlistRef.current;
        const bouquet = current?.bouquets.find(b => b.id === id);
        if (!bouquet) return;
        const data = {
            custom_name: bouquet.custom_name,
            category_id: bouquet.category_id,
            channels: bouquet.channels.map(c => ({
                stream_id: c.stream_id,
                subscription_id: c.subscription_id,
                custom_name: c.custom_name,
                order: c.order,
                is_excluded: c.is_excluded,
                epg_channel_id: c.epg_channel_id,
            })),
        };
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${bouquet.custom_name || 'group'}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    };

    const importBouquet = async (file: File) => {
        const current = playlistRef.current;
        if (!current) return;
        let data: any;
        try {
            data = JSON.parse(await file.text());
            if (!Array.isArray(data.channels)) throw new Error('missing channels');
        } catch {
            toast.error('Import failed', 'This is not a group exported from this screen.');
            return;
        }
        await enqueue('Importing the group', async () => {
            const res = await api.post(`/live/playlists/${current.id}/bouquets`, [{
                custom_name: data.custom_name || "Imported group",
                category_id: data.category_id,
                order: playlistRef.current!.bouquets.length,
            }]);
            const created = res.data[0];
            if (data.channels.length > 0) {
                await api.post(`/live/playlists/${current.id}/bouquets/${created.id}/channels`, data.channels);
            }
            await loadPlaylist(current.id, true);
            setSelectedBouquetId(created.id);
        });
    };

    // A selection made in one group must not follow the user into another: a
    // bulk delete would remove channels that are no longer on screen.
    const chooseBouquet = useCallback((id: number | null) => {
        setSelectedBouquetId(id);
        setSelectedChannelIds(new Set());
    }, []);

    const value = useMemo<LiveSelectionContextType>(() => ({
        playlist,
        selectedBouquetId, setSelectedBouquetId: chooseBouquet,
        categories, streams, setStreams,
        selectedCategory, setSelectedCategory: selectCategory,
        sourceSubscriptionId, setSourceSubscriptionId, sourceSubscriptionName,
        allSubscriptions,
        epgSources, mappingId, setMappingId,
        bouquetLabel, channelLabel, channelEditableName, membership,
        includedCategoryIds, excludedStreamIds, sourceNames,
        editingId, editValue, setEditValue: changeEditValue,
        compactMode, setCompactMode,
        selectedChannelIds, setSelectedChannelIds,
        toggleChannelSelection, bulkDeleteChannels, bulkMoveChannels,
        exportBouquet, importBouquet,
        stats,
        loading, loadingCategories, loadingStreams, saving: pending > 0,
        syncError, totalStreams, streamsPage, totalStreamsPages,
        useChannelNumbers, setUseChannelNumbers,
        fetchPlaylist, fetchCategories, fetchStreams, resetPlaylist,
        startEditing, cancelEditing, saveEdit,
        addVirtualBouquet, deleteBouquet, reorderBouquets, duplicateBouquet,
        addStreamToBouquet, bulkAddStreamsToBouquet, removeStreamFromBouquet,
        reorderChannels, jumpToChannelPosition, moveChannelToBouquet,
        selectEPG, getEPGDebugInfo,
        undo, redo,
        canUndo: historySize.past > 0,
        canRedo: historySize.future > 0,
        // Handlers read the playlist through `playlistRef`, so they are stable
        // enough to leave out of the dependency list on purpose.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }), [
        playlist, selectedBouquetId, categories, streams, selectedCategory, selectCategory,
        sourceSubscriptionId, sourceSubscriptionName, allSubscriptions, epgSources, mappingId,
        bouquetLabel, channelLabel, channelEditableName, membership,
        includedCategoryIds, excludedStreamIds, sourceNames,
        editingId, editValue, compactMode, selectedChannelIds, stats,
        loading, loadingCategories, loadingStreams, pending, syncError,
        totalStreams, streamsPage, totalStreamsPages, useChannelNumbers,
        fetchPlaylist, fetchCategories, fetchStreams, resetPlaylist, undo, redo, historySize,
    ]);

    return (
        <LiveSelectionContext.Provider value={value}>
            {children}
        </LiveSelectionContext.Provider>
    );
};

export function useLiveSelection() {
    const context = useContext(LiveSelectionContext);
    if (context === undefined) {
        throw new Error('useLiveSelection must be used within a LiveSelectionProvider');
    }
    return context;
}
