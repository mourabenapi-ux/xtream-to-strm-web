import { createContext, useContext, useState, useCallback, FC, ReactNode, useMemo, useRef, useEffect } from 'react';
import api from '@/lib/api';
import { arrayMove } from '@dnd-kit/sortable';
import { useToast } from '@/contexts/ToastContext';

// ---------------------------------------------------------------- types

export interface Category {
    category_id: string;
    category_name: string;
    parent_id?: number;
}

export interface Stream {
    num?: number;
    name: string;
    stream_type?: string;
    stream_id: number | string;
    stream_icon?: string;
    epg_channel_id?: string | null;
    category_id?: string;
    category_name?: string;
}

/** A provider stream waiting to be added: the stream plus whose it is. */
export interface BasketItem {
    key: string;
    subscription_id: number;
    stream: Stream;
}

export interface PlaylistChannel {
    id: number;
    stream_id: string;
    subscription_id: number | null;
    custom_name: string | null;
    order: number;
    is_excluded: boolean;
    epg_channel_id: string | null;
}

export interface PlaylistBouquet {
    id: number;
    category_id: string | null;
    subscription_id: number | null;
    custom_name: string | null;
    order: number;
    number_start?: number | null;
    number_end?: number | null;
    rule?: string | null;
    channels: PlaylistChannel[];
}

interface Playlist {
    id: number;
    public_id: string | null;
    subscription_id: number | null;
    name: string;
    description: string | null;
    use_channel_numbers?: boolean;
    reviewed_at?: string | null;
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

/** What the player really receives for one channel (from /health). */
export interface Effective {
    served: boolean;
    dead?: string;
    number?: number | null;
    name: string;
    logo?: string;
    epg_id?: string;
    epg_source?: 'override' | 'provider' | 'detached';
    /** live: a schedule · listed: named by a guide, no schedule · unknown: no guide knows the id. */
    guide?: 'live' | 'listed' | 'unknown' | 'none' | 'detached';
    now?: string | null;
    category_id?: string;
    subscription_id?: number;
}

export interface HealthIssue {
    type: string;
    severity: 'error' | 'warning' | 'info';
    title: string;
    detail?: string;
    channel_ids?: number[];
    bouquet_ids?: number[];
    fix: string | null;
}

export interface Health {
    channels: Record<string, Effective>;
    issues: HealthIssue[];
    stats: {
        rows: number; served: number; dead: number; excluded: number;
        with_guide_id: number; with_schedule: number; schedule_percentage: number;
    };
}

export interface NewStream {
    subscription_id: number;
    subscription_name: string;
    stream_id: string;
    name: string;
    stream_icon?: string;
    epg_channel_id?: string;
    category_id: string;
    category_name: string;
    first_seen: string;
}

export interface ChangesReport {
    since: string | null;
    new_count: number;
    new: NewStream[];
    lost_count: number;
    lost: { channel_id: number; name: string; bouquet: string; reason: string }[];
}

export interface GroupRule {
    subscription_ids: number[];
    category_ids: string[];
    include: string[];
    exclude: string[];
}

export interface GroupSettingsPatch {
    custom_name?: string;
    number_start?: number | null;
    number_end?: number | null;
    rule?: GroupRule | null;
}

export type ServerTool =
    | 'fix_numbering' | 'reference_numbering' | 'dedupe' | 'repair_dead'
    | 'auto_match' | 'refresh_rules';

/** Groups and channels share one edit slot, so the kind is part of the id. */
export const editKey = (kind: 'b' | 'c', id: number) => `${kind}:${id}`;

export const streamKey = (subscriptionId: number | null | undefined, streamId: string | number) =>
    `${subscriptionId ?? ''}:${streamId}`;

export const parseRule = (raw: string | null | undefined): GroupRule | null => {
    if (!raw) return null;
    try { return JSON.parse(raw) as GroupRule; } catch { return null; }
};

const HISTORY_LIMIT = 50;

// ---------------------------------------------------------------- context shape

interface LiveSelectionContextType {
    playlist: Playlist | null;
    selectedBouquetId: number | null;
    setSelectedBouquetId: (id: number | null) => void;

    // Library
    categories: Category[];
    streams: Stream[];
    selectedCategory: string | null;
    setSelectedCategory: (id: string | null) => void;
    setStreams: (streams: Stream[]) => void;
    sourceSubscriptionId: number | null;
    setSourceSubscriptionId: (id: number | null) => void;
    sourceSubscriptionName: string;
    allSubscriptions: any[];

    // Basket: provider streams picked across categories and providers.
    basket: Map<string, BasketItem>;
    toggleBasket: (item: BasketItem) => void;
    setInBasket: (items: BasketItem[], on: boolean) => void;
    clearBasket: () => void;

    // EPG
    epgSources: EPGSource[];
    mappingId: string | null;
    setMappingId: (id: string | null) => void;

    // Labels
    bouquetLabel: (b: PlaylistBouquet) => string;
    channelLabel: (c: PlaylistChannel) => string;
    channelEditableName: (c: PlaylistChannel) => string;
    /** `subscription:stream` -> name of the group that already holds it. */
    membership: Map<string, string>;
    groupOfChannel: (channelId: number) => PlaylistBouquet | null;

    // UI state
    includedCategoryIds: string[];
    excludedStreamIds: Set<string>;
    sourceNames: Record<string, string>;
    editingId: string | null;
    editValue: string;
    setEditValue: (val: string) => void;
    compactMode: boolean;
    setCompactMode: (val: boolean) => void;
    /** Cross-group view of some channels, e.g. the ones an issue is about. */
    focus: { label: string; ids: number[] } | null;
    setFocus: (focus: { label: string; ids: number[] } | null) => void;
    highlightId: number | null;
    revealChannel: (channelId: number) => void;

    // What the player receives
    health: Health | null;
    healthLoading: boolean;
    refreshHealth: () => Promise<void>;
    effectiveOf: (channelId: number) => Effective | undefined;
    changes: ChangesReport | null;
    changesLoading: boolean;
    loadChanges: () => Promise<void>;
    markReviewed: () => Promise<void>;

    stats: {
        totalChannels: number;
        totalGroups: number;
        epgMappedCount: number;
        epgPercentage: number;
    };

    loading: boolean;
    loadingCategories: boolean;
    loadingStreams: boolean;
    saving: boolean;
    syncError: string | null;
    totalStreams: number;
    streamsPage: number;
    totalStreamsPages: number;
    useChannelNumbers: boolean;
    setUseChannelNumbers: (value: boolean) => Promise<void>;

    fetchPlaylist: (id: number) => Promise<void>;
    fetchCategories: (subId: number) => Promise<void>;
    fetchStreams: (subId: number, catId: string, page?: number) => Promise<void>;
    resetPlaylist: () => void;
    startEditing: (id: string, value: string) => void;
    cancelEditing: () => void;
    saveEdit: () => Promise<void>;

    // Groups
    addVirtualBouquet: (name: string) => Promise<void>;
    deleteBouquet: (id: number) => Promise<void>;
    reorderBouquets: (activeId: number, overId: number) => Promise<void>;
    duplicateBouquet: (id: number) => Promise<void>;
    updateGroupSettings: (id: number, patch: GroupSettingsPatch) => Promise<boolean>;

    // Channels
    addStreams: (items: BasketItem[], targetBouquetId?: number | null) => Promise<void>;
    addStreamToBouquet: (stream: Stream) => Promise<void>;
    bulkAddStreamsToBouquet: (streams: Stream[]) => Promise<void>;
    removeStreamFromBouquet: (channelId: number) => Promise<void>;
    reorderChannels: (activeId: number, overId: number) => Promise<void>;
    jumpToChannelPosition: (channelId: number, newPosition: number) => Promise<void>;
    moveChannelToBouquet: (channelId: number, targetBouquetId: number) => Promise<void>;
    excludeChannels: (ids: number[], excluded: boolean) => Promise<void>;
    setGuideMode: (ids: number[], mode: 'detach' | 'inherit') => Promise<void>;
    replaceChannel: (channelId: number, subscriptionId: number, streamId: string) => Promise<void>;

    // Selection & bulk
    selectedChannelIds: Set<number>;
    setSelectedChannelIds: (ids: Set<number>) => void;
    toggleChannelSelection: (id: number) => void;
    bulkDeleteChannels: (ids: number[]) => Promise<void>;
    bulkMoveChannels: (channelIds: number[], targetBouquetId: number) => Promise<void>;
    exportBouquet: (id: number) => void;
    importBouquet: (file: File) => Promise<void>;

    // Server-side tools (undoable)
    runTool: (tool: ServerTool, args?: Record<string, unknown>) => Promise<any>;

    // EPG
    selectEPG: (epgId: string) => void;
    getEPGDebugInfo: (channelId: number) => Promise<EPGMatchDebugResponse | null>;

    // History
    undo: () => void;
    redo: () => void;
    canUndo: boolean;
    canRedo: boolean;
}

const LiveSelectionContext = createContext<LiveSelectionContextType | undefined>(undefined);

const sortedBouquets = (bouquets: PlaylistBouquet[]): PlaylistBouquet[] =>
    [...bouquets]
        .sort((a, b) => a.order - b.order)
        .map(b => ({ ...b, channels: [...(b.channels ?? [])].sort((x, y) => x.order - y.order) }));

const TOOL_LABELS: Record<ServerTool, string> = {
    fix_numbering: 'Fixing the numbering',
    reference_numbering: 'Numbering from the reference',
    dedupe: 'Removing duplicates',
    repair_dead: 'Repairing dead channels',
    auto_match: 'Matching guides',
    refresh_rules: 'Refreshing rule groups',
};

export const LiveSelectionProvider: FC<{ children: ReactNode }> = ({ children }) => {
    const toast = useToast();

    const [playlist, setPlaylistState] = useState<Playlist | null>(null);
    // Handlers run several times between two renders (a bulk move, a drag that
    // ends while a save is still in flight), so they read the latest playlist
    // from here rather than from the render they were created in.
    const playlistRef = useRef<Playlist | null>(null);
    const [revision, setRevision] = useState(0);

    const [categories, setCategories] = useState<Category[]>([]);
    const [streams, setStreams] = useState<Stream[]>([]);
    const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
    const [sourceNames, setSourceNames] = useState<Record<string, string>>({});
    const [editingId, setEditingId] = useState<string | null>(null);
    const [editValue, setEditValue] = useState("");
    const editingRef = useRef<{ id: string | null; value: string }>({ id: null, value: "" });
    const [compactMode, setCompactModeState] = useState(() => {
        try { return localStorage.getItem('live-compact-mode') === 'true'; } catch { return false; }
    });

    const [selectedBouquetId, setSelectedBouquetId] = useState<number | null>(null);
    const [sourceSubscriptionId, setSourceSubscriptionId] = useState<number | null>(null);
    const [allSubscriptions, setAllSubscriptions] = useState<any[]>([]);
    const [selectedChannelIds, setSelectedChannelIds] = useState<Set<number>>(new Set());
    const [basket, setBasket] = useState<Map<string, BasketItem>>(new Map());
    const [focus, setFocus] = useState<{ label: string; ids: number[] } | null>(null);
    const [highlightId, setHighlightId] = useState<number | null>(null);

    const [mappingId, setMappingId] = useState<string | null>(null);
    const [epgSources, setEpgSources] = useState<EPGSource[]>([]);
    const [useChannelNumbers, setUseChannelNumbersState] = useState(false);

    const [health, setHealth] = useState<Health | null>(null);
    const [healthLoading, setHealthLoading] = useState(false);
    const [changes, setChanges] = useState<ChangesReport | null>(null);
    const [changesLoading, setChangesLoading] = useState(false);

    const [loading, setLoading] = useState(false);
    const [loadingCategories, setLoadingCategories] = useState(false);
    const [loadingStreams, setLoadingStreams] = useState(false);
    const [pending, setPending] = useState(0);
    const [syncError, setSyncError] = useState<string | null>(null);
    const [totalStreams, setTotalStreams] = useState(0);
    const [streamsPage, setStreamsPage] = useState(1);
    const [totalStreamsPages, setTotalStreamsPages] = useState(1);
    const streamRequest = useRef(0);

    const setCompactMode = (value: boolean) => {
        setCompactModeState(value);
        try { localStorage.setItem('live-compact-mode', String(value)); } catch { /* private mode */ }
    };

    // History: whole-playlist snapshots. Replaying one also rewrites the server
    // (see `undo`), so what the screen shows is always what the player gets.
    const past = useRef<Playlist[]>([]);
    const future = useRef<Playlist[]>([]);
    const [historySize, setHistorySize] = useState({ past: 0, future: 0 });
    const syncHistorySize = () => setHistorySize({ past: past.current.length, future: future.current.length });

    const show = (next: Playlist | null) => {
        playlistRef.current = next;
        setPlaylistState(next);
        setRevision(r => r + 1);
    };

    const remember = (state: Playlist) => {
        past.current.push(state);
        if (past.current.length > HISTORY_LIMIT) past.current.shift();
        future.current = [];
        syncHistorySize();
    };

    /** Applies a change on screen and records the state it replaces. */
    const commit = (next: Playlist) => {
        if (playlistRef.current) remember(playlistRef.current);
        show(next);
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

    const loadPlaylist = useCallback(async (id: number, keepContext: boolean, keepHistory = false) => {
        if (!keepContext) setLoading(true);
        try {
            const [res, subs] = await Promise.all([
                api.get<Playlist>(`/live/playlists/${id}`),
                keepContext ? Promise.resolve(null) : api.get<any[]>('/subscriptions/'),
            ]);
            const data: Playlist = { ...res.data, bouquets: sortedBouquets(res.data.bouquets) };
            show(data);
            if (!keepHistory) resetHistory();
            setUseChannelNumbersState(!!res.data.use_channel_numbers);
            setSelectedChannelIds(new Set());
            setSelectedBouquetId(prev =>
                prev !== null && data.bouquets.some(b => b.id === prev)
                    ? prev
                    : (data.bouquets[0]?.id ?? null));

            if (!keepContext && subs) {
                setAllSubscriptions(subs.data);
                // A playlist built by the organiser has no subscription of its
                // own, and an old one may name a provider none of its channels
                // come from. Browse the provider most channels come from.
                const tally = new Map<number, number>();
                data.bouquets.forEach(b => b.channels.forEach(c => {
                    const sub = c.subscription_id ?? b.subscription_id;
                    if (sub) tally.set(sub, (tally.get(sub) ?? 0) + 1);
                }));
                const dominant = [...tally.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
                const source = dominant ?? data.subscription_id ?? subs.data[0]?.id ?? null;
                setSourceSubscriptionId(source);
                if (source) fetchCategoriesRef.current(source);

                api.get<any[]>(`/live/playlists/${id}/epg-sources`)
                    .then(r => setEpgSources(r.data.map(link => link.epg_source).filter(s => s && s.is_active)))
                    .catch(err => console.error("Failed to fetch EPG sources", err));
            }
            // Names come from the provider, not from our tables.
            api.get<Record<string, string>>(`/live/playlists/${id}/channel-names`)
                .then(r => setSourceNames(r.data))
                .catch(err => console.error("Failed to resolve channel names", err));
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

    const mapChannels = (p: Playlist, ids: Set<number>, change: (c: PlaylistChannel) => PlaylistChannel): Playlist => ({
        ...p, bouquets: p.bouquets.map(b => ({ ...b, channels: b.channels.map(c => (ids.has(c.id) ? change(c) : c)) })),
    });

    /**
     * After a reorder, the channels take over the order values the group already
     * had, in the new sequence. On a numbered playlist `order` is the channel
     * number a player shows, so writing 0..n-1 would wipe the numbering;
     * permuting the existing values keeps it.
     */
    const reassignOrders = (before: PlaylistChannel[], after: PlaylistChannel[]) => {
        const slots = before.map(c => c.order).sort((a, b) => a - b);
        const distinct = new Set(slots).size === slots.length;
        return after.map((c, i) => ({ ...c, order: distinct ? slots[i] : i }));
    };

    const snapshotOf = (p: Playlist) => ({
        bouquets: p.bouquets.map(b => ({
            id: b.id, subscription_id: b.subscription_id, category_id: b.category_id,
            custom_name: b.custom_name, order: b.order,
            number_start: b.number_start ?? null, number_end: b.number_end ?? null, rule: b.rule ?? null,
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

    // ---- health: what the player really receives ------------------------------
    const healthRequest = useRef(0);
    const refreshHealth = useCallback(async () => {
        const current = playlistRef.current;
        if (!current) return;
        const request = ++healthRequest.current;
        setHealthLoading(true);
        try {
            const res = await api.get<Health>(`/live/playlists/${current.id}/health`);
            if (request === healthRequest.current) setHealth(res.data);
        } catch (error) {
            console.error('Health check failed', error);
        } finally {
            if (request === healthRequest.current) setHealthLoading(false);
        }
    }, []);

    // Re-read the served playlist once the writes have landed and the screen
    // has been quiet for a moment, so badges never describe an older state.
    useEffect(() => {
        if (!playlistRef.current || pending > 0) return;
        const timer = setTimeout(() => { refreshHealth(); }, 1200);
        return () => clearTimeout(timer);
    }, [revision, pending, refreshHealth]);

    const effectiveOf = useCallback((channelId: number) => health?.channels[String(channelId)], [health]);

    const loadChanges = useCallback(async () => {
        const current = playlistRef.current;
        if (!current) return;
        setChangesLoading(true);
        try {
            const res = await api.get<ChangesReport>(`/live/playlists/${current.id}/changes`);
            setChanges(res.data);
        } catch (error) {
            console.error('Changes report failed', error);
        } finally {
            setChangesLoading(false);
        }
    }, []);

    const markReviewed = useCallback(async () => {
        const current = playlistRef.current;
        if (!current) return;
        try {
            await api.post(`/live/playlists/${current.id}/changes/review`);
            setChanges(prev => prev ? { ...prev, new: [], new_count: 0, since: new Date().toISOString() } : prev);
            toast.success('Marked as reviewed', 'Only channels the providers add from now on will be listed.');
        } catch (error) {
            toast.apiError('Could not save the review', error);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

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
                params: { subscription_id: subId, page, page_size: 500 }
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

    // ---- basket ---------------------------------------------------------------
    const toggleBasket = useCallback((item: BasketItem) => {
        setBasket(prev => {
            const next = new Map(prev);
            if (next.has(item.key)) next.delete(item.key); else next.set(item.key, item);
            return next;
        });
    }, []);

    const setInBasket = useCallback((items: BasketItem[], on: boolean) => {
        setBasket(prev => {
            const next = new Map(prev);
            items.forEach(item => (on ? next.set(item.key, item) : next.delete(item.key)));
            return next;
        });
    }, []);

    const clearBasket = useCallback(() => setBasket(new Map()), []);

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

    const groupOfChannel = useCallback((channelId: number) =>
        playlistRef.current?.bouquets.find(b => b.channels.some(c => c.id === channelId)) ?? null,
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [playlist]);

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

    // Counts what is *served* once the health check is in: the stored rows
    // say "has an id", only the guide sources say "has a schedule".
    const stats = useMemo(() => {
        if (!playlist) return { totalChannels: 0, totalGroups: 0, epgMappedCount: 0, epgPercentage: 0 };
        let total = 0;
        playlist.bouquets.forEach(b => b.channels.forEach(c => { if (!c.is_excluded) total++; }));
        return {
            totalChannels: total,
            totalGroups: playlist.bouquets.length,
            epgMappedCount: health?.stats.with_schedule ?? 0,
            epgPercentage: health?.stats.schedule_percentage ?? 0,
        };
    }, [playlist, health]);

    const sourceSubscriptionName = useMemo(
        () => allSubscriptions.find(s => s.id === sourceSubscriptionId)?.name ?? '',
        [allSubscriptions, sourceSubscriptionId]);

    // ---- groups -------------------------------------------------------------
    const addVirtualBouquet = async (name: string) => {
        const current = playlistRef.current;
        if (!name.trim() || !current) return;
        await enqueue('Adding the group', async () => {
            const live = playlistRef.current!;
            const res = await api.post(`/live/playlists/${current.id}/bouquets`, [{
                custom_name: name.trim(),
                order: live.bouquets.length ? Math.max(...live.bouquets.map(b => b.order)) + 1 : 0,
                subscription_id: null,
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

    const updateGroupSettings = async (id: number, patch: GroupSettingsPatch): Promise<boolean> => {
        const current = playlistRef.current;
        if (!current) return false;
        try {
            const res = await api.patch(`/live/playlists/${current.id}/bouquets/${id}/settings`, patch);
            commit(replaceBouquet(playlistRef.current!, id, b => ({
                ...b,
                custom_name: res.data.custom_name,
                number_start: res.data.number_start,
                number_end: res.data.number_end,
                rule: res.data.rule,
            })));
            return true;
        } catch (error) {
            toast.apiError('Could not save the group settings', error);
            return false;
        }
    };

    // ---- channels -----------------------------------------------------------
    const usedNumbers = (p: Playlist) => new Set(p.bouquets.flatMap(b => b.channels.map(c => c.order)));

    /**
     * Adds provider streams to a group. On a numbered playlist each one takes
     * the next free number *inside the group's range*: appending after the
     * group's last number is what used to spill Info into Cinéma.
     */
    const addStreams = async (items: BasketItem[], targetBouquetId?: number | null) => {
        const current = playlistRef.current;
        if (!current || items.length === 0) return;
        const targetId = targetBouquetId ?? selectedBouquetId;
        const target = current.bouquets.find(b => b.id === targetId) ?? null;
        if (!target) {
            toast.info('Choose a group first', 'Pick the group that should receive the channels.');
            return;
        }
        const have = new Set(target.channels.map(c =>
            streamKey(c.subscription_id ?? target.subscription_id ?? current.subscription_id, c.stream_id)));
        const unique = new Map<string, BasketItem>();
        items.forEach(item => { if (!have.has(item.key)) unique.set(item.key, item); });
        const fresh = [...unique.values()];
        const skipped = items.length - fresh.length;
        if (fresh.length === 0) {
            toast.info('Nothing to add', `Already in ${bouquetLabel(target)}.`);
            return;
        }
        await enqueue('Adding the channels', async () => {
            const live = playlistRef.current!;
            const group = live.bouquets.find(b => b.id === target.id);
            if (!group) return;
            const taken = usedNumbers(live);
            const inGroup = group.channels.map(c => c.order);
            const last = inGroup.length ? Math.max(...inGroup) : -1;
            let cursor = useChannelNumbers
                ? Math.max(group.number_start ?? 1, last + 1, 1)
                : group.channels.length;
            let outside = 0;
            const rows = fresh.map(item => {
                let order: number;
                if (useChannelNumbers) {
                    while (taken.has(cursor)) cursor++;
                    if (group.number_end != null && cursor > group.number_end) outside++;
                    order = cursor;
                    taken.add(cursor);
                    cursor++;
                } else {
                    order = cursor++;
                }
                return {
                    stream_id: String(item.stream.stream_id),
                    subscription_id: item.subscription_id,
                    custom_name: item.stream.name,
                    order,
                    is_excluded: false,
                };
            });
            const res = await api.post(`/live/playlists/${live.id}/bouquets/${group.id}/channels`, rows);
            const returned: PlaylistChannel[] = res.data;
            const ids = new Set(returned.map(c => c.id));
            commit(replaceBouquet(playlistRef.current!, group.id, b => ({
                ...b,
                channels: [...b.channels.filter(c => !ids.has(c.id)), ...returned].sort((x, y) => x.order - y.order),
            })));
            // Allowed (a channel may sit in two groups), but never silently:
            // the health check would otherwise be the first to mention it.
            const elsewhere = fresh.filter(item => membership.has(item.key)).length;
            const extra = [
                skipped ? `${skipped} already there` : '',
                elsewhere ? `${elsewhere} also in another group` : '',
                outside ? `${outside} numbered past the end of the group's range — use Tools › Fix numbering` : '',
            ].filter(Boolean).join(' · ');
            if (outside) toast.error(`${returned.length} channel(s) added to ${bouquetLabel(group)}`, extra);
            else toast.success(`${returned.length} channel(s) added to ${bouquetLabel(group)}`, extra || undefined);
        });
    };

    const asItem = (stream: Stream, subscriptionId: number | null): BasketItem => ({
        key: streamKey(subscriptionId, stream.stream_id),
        subscription_id: subscriptionId ?? 0,
        stream,
    });

    const addStreamToBouquet = async (stream: Stream) => addStreams([asItem(stream, sourceSubscriptionId)]);
    const bulkAddStreamsToBouquet = async (list: Stream[]) =>
        addStreams(list.map(s => asItem(s, sourceSubscriptionId)));

    const findChannel = (p: Playlist, channelId: number) => {
        for (const b of p.bouquets) {
            const channel = b.channels.find(c => c.id === channelId);
            if (channel) return { bouquet: b, channel };
        }
        return null;
    };

    const excludeChannels = async (ids: number[], excluded: boolean) => {
        const current = playlistRef.current;
        if (!current || ids.length === 0) return;
        const set = new Set(ids);
        await mutate(excluded ? 'Hiding the channels' : 'Showing the channels',
            p => mapChannels(p, set, c => ({ ...c, is_excluded: excluded })),
            () => api.post(`/live/playlists/${current.id}/channels/exclude`, { channel_ids: ids, excluded }));
    };

    /** In a rule group a removed channel is hidden, or the next refresh would add it back. */
    const splitByRule = (p: Playlist, ids: number[]) => {
        const hide: number[] = [];
        const drop: number[] = [];
        ids.forEach(id => {
            const found = findChannel(p, id);
            if (found && parseRule(found.bouquet.rule)) hide.push(id); else drop.push(id);
        });
        return { hide, drop };
    };

    const removeStreamFromBouquet = async (channelId: number) => {
        const current = playlistRef.current;
        if (!current) return;
        const { hide } = splitByRule(current, [channelId]);
        if (hide.length) return excludeChannels(hide, true);
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
        const current = playlistRef.current;
        if (!current) return;
        const bouquetId = findChannel(current, activeId)?.bouquet.id ?? null;
        if (bouquetId === null || findChannel(current, overId)?.bouquet.id !== bouquetId) return;
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
     * number: a number held by a channel of the *same* group pushes that one
     * and its followers down by one (insert and shift). A number held by
     * another group, or outside the group's range, is refused with the reason.
     * Otherwise it moves the channel to that 1-based position.
     */
    const jumpToChannelPosition = async (channelId: number, value: number) => {
        const current = playlistRef.current;
        const found = current ? findChannel(current, channelId) : null;
        if (!current || !found) return;
        const bouquetId = found.bouquet.id;

        if (useChannelNumbers) {
            if (!Number.isInteger(value) || value < 1) return;
            const group = found.bouquet;
            if ((group.number_start != null && value < group.number_start)
                || (group.number_end != null && value > group.number_end)) {
                toast.error(`${value} is outside ${bouquetLabel(group)}`,
                    `This group owns ${group.number_start ?? '…'}–${group.number_end ?? '…'}. Change the range in the group settings (gear icon).`);
                return;
            }
            const owners = new Map<number, { channel: PlaylistChannel; bouquet: PlaylistBouquet }>();
            current.bouquets.forEach(b => b.channels.forEach(c => owners.set(c.order, { channel: c, bouquet: b })));
            const owner = owners.get(value);
            if (owner && owner.bouquet.id !== bouquetId) {
                toast.error(`Number ${value} is taken`, `${channelLabel(owner.channel)} has it, in ${bouquetLabel(owner.bouquet)}.`);
                return;
            }
            // Insert and shift: free `value` by pushing the run of consecutive
            // numbers that starts there down by one, within this group.
            const shifted = new Map<number, number>();
            let n = value;
            while (true) {
                const holder = owners.get(n);
                if (!holder || holder.channel.id === channelId) break;
                if (holder.bouquet.id !== bouquetId) {
                    toast.error('No room to shift', `${channelLabel(holder.channel)} (${bouquetLabel(holder.bouquet)}) holds ${n}. Use Tools › Fix numbering, or widen the range.`);
                    return;
                }
                if (group.number_end != null && n + 1 > group.number_end) {
                    toast.error('The group is full', `Shifting would push ${channelLabel(holder.channel)} past ${group.number_end}.`);
                    return;
                }
                shifted.set(holder.channel.id, n + 1);
                n++;
            }
            await mutate('Changing the channel number', p => replaceBouquet(p, bouquetId, b => ({
                ...b,
                channels: b.channels
                    .map(c => (c.id === channelId ? { ...c, order: value } : shifted.has(c.id) ? { ...c, order: shifted.get(c.id)! } : c))
                    .sort((x, y) => x.order - y.order),
            })), sendChannelOrder(bouquetId));
            if (shifted.size) toast.info(`${shifted.size} channel(s) moved down by one`, 'Ctrl+Z undoes it.');
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
            const incoming = channelIds.map(id => outside.get(id)).filter((c): c is PlaylistChannel => !!c);
            if (incoming.length === 0) return null;
            const targetKeys = new Set(
                p.bouquets.find(b => b.id === targetBouquetId)!.channels
                    .map(c => streamKey(c.subscription_id, c.stream_id)));
            const fresh = incoming.filter(c => !targetKeys.has(streamKey(c.subscription_id, c.stream_id)));
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
        if (useChannelNumbers && target.number_start != null) {
            toast.info('Numbers kept', 'Moved channels keep their number. Tools › Fix numbering renumbers them inside the new group\'s range.');
        }
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
        setSelectedChannelIds(new Set());
        const { hide, drop } = splitByRule(current, ids);
        if (hide.length) await excludeChannels(hide, true);
        if (!drop.length) return;
        const doomed = new Set(drop);
        await mutate('Removing the channels',
            p => ({ ...p, bouquets: p.bouquets.map(b => ({ ...b, channels: b.channels.filter(c => !doomed.has(c.id)) })) }),
            () => api.post(`/live/playlists/${current.id}/channels/bulk`, { channel_ids: drop }));
    };

    const toggleChannelSelection = (id: number) => {
        setSelectedChannelIds(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    };

    const setGuideMode = async (ids: number[], mode: 'detach' | 'inherit') => {
        const current = playlistRef.current;
        if (!current || ids.length === 0) return;
        const set = new Set(ids);
        await mutate(mode === 'detach' ? 'Detaching the guide' : 'Restoring the provider guide',
            p => mapChannels(p, set, c => ({ ...c, epg_channel_id: mode === 'detach' ? '-' : null })),
            () => api.post(`/live/playlists/${current.id}/channels/guide`, { channel_ids: ids, action: mode }));
    };

    const replaceChannel = async (channelId: number, subscriptionId: number, streamId: string) => {
        const current = playlistRef.current;
        if (!current) return;
        await mutate('Replacing the stream',
            p => mapChannels(p, new Set([channelId]), c => ({ ...c, subscription_id: subscriptionId, stream_id: streamId })),
            () => api.post(`/live/playlists/${current.id}/channels/${channelId}/replace`,
                { subscription_id: subscriptionId, stream_id: streamId }));
    };

    // ---- server-side tools ------------------------------------------------------
    /**
     * Runs a tool that rewrites many rows on the server, then reloads. The
     * state before it is kept in the undo history, so Ctrl+Z puts every
     * number back exactly (the snapshot restore rewrites them all).
     */
    const runTool = async (tool: ServerTool, args: Record<string, unknown> = {}) => {
        const current = playlistRef.current;
        if (!current) return null;
        await queue.current.catch(() => undefined);
        setPending(n => n + 1);
        const before = current;
        try {
            const id = current.id;
            const call = {
                fix_numbering: () => api.post(`/live/playlists/${id}/numbering/fix`, args),
                reference_numbering: () => api.post(`/live/playlists/${id}/numbering/reference`, args),
                dedupe: () => api.post(`/live/playlists/${id}/channels/dedupe`),
                repair_dead: () => api.post(`/live/playlists/${id}/channels/repair-dead`),
                auto_match: () => api.post(`/live/playlists/${id}/epg-auto-match`),
                refresh_rules: () => api.post(`/live/playlists/${id}/rules/refresh`),
            }[tool];
            const res = await call();
            remember(before);
            await loadPlaylist(id, true, true);
            setSyncError(null);
            return res.data;
        } catch (error) {
            toast.apiError(`${TOOL_LABELS[tool]} failed`, error);
            return null;
        } finally {
            setPending(n => n - 1);
        }
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
                () => api.patch(`/live/playlists/${current.id}/bouquets/${targetId}/settings`, { custom_name: name }));
        } else {
            const found = findChannel(current, targetId);
            const name = value.trim();
            if (!found || name === (found.channel.custom_name ?? '')) return;
            await mutate('Renaming the channel',
                p => mapChannels(p, new Set([targetId]), c => ({ ...c, custom_name: name || null })),
                () => api.post(`/live/playlists/${current.id}/channels/${targetId}/rename`, { custom_name: name }));
        }
    };

    // ---- guide --------------------------------------------------------------
    const selectEPG = (epgId: string) => {
        if (!mappingId) return;
        const channelId = Number(mappingId);
        setMappingId(null);
        mutate('Saving the guide mapping',
            p => mapChannels(p, new Set([channelId]), c => ({ ...c, epg_channel_id: epgId })),
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
        setRevision(r => r + 1);
    };

    // ---- import / export ------------------------------------------------------
    const exportBouquet = (id: number) => {
        const current = playlistRef.current;
        const bouquet = current?.bouquets.find(b => b.id === id);
        if (!bouquet) return;
        const data = {
            custom_name: bouquet.custom_name,
            category_id: bouquet.category_id,
            rule: bouquet.rule ?? null,
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
            const live = playlistRef.current!;
            const res = await api.post(`/live/playlists/${current.id}/bouquets`, [{
                custom_name: data.custom_name || "Imported group",
                category_id: data.category_id,
                rule: data.rule ?? null,
                order: live.bouquets.length ? Math.max(...live.bouquets.map(b => b.order)) + 1 : 0,
            }]);
            const created = res.data[0];
            // Numbers from another playlist would collide with this one's: on
            // a numbered playlist the imported channels follow the last number.
            const taken = usedNumbers(live);
            let next = taken.size ? Math.max(...taken) + 1 : 1;
            const channels = [...data.channels]
                .sort((a: any, b: any) => (a.order ?? 0) - (b.order ?? 0))
                .map((c: any, i: number) => {
                    if (!useChannelNumbers) return { ...c, order: i };
                    while (taken.has(next)) next++;
                    return { ...c, order: next++ };
                });
            if (channels.length > 0) {
                await api.post(`/live/playlists/${current.id}/bouquets/${created.id}/channels`, channels);
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
        setFocus(null);
    }, []);

    const revealChannel = useCallback((channelId: number) => {
        const owner = playlistRef.current?.bouquets.find(b => b.channels.some(c => c.id === channelId));
        if (!owner) return;
        setFocus(null);
        setSelectedBouquetId(owner.id);
        setSelectedChannelIds(new Set());
        setHighlightId(channelId);
        setTimeout(() => setHighlightId(prev => (prev === channelId ? null : prev)), 4000);
    }, []);

    const value = useMemo<LiveSelectionContextType>(() => ({
        playlist,
        selectedBouquetId, setSelectedBouquetId: chooseBouquet,
        categories, streams, setStreams,
        selectedCategory, setSelectedCategory: selectCategory,
        sourceSubscriptionId, setSourceSubscriptionId, sourceSubscriptionName,
        allSubscriptions,
        basket, toggleBasket, setInBasket, clearBasket,
        epgSources, mappingId, setMappingId,
        bouquetLabel, channelLabel, channelEditableName, membership, groupOfChannel,
        includedCategoryIds, excludedStreamIds, sourceNames,
        editingId, editValue, setEditValue: changeEditValue,
        compactMode, setCompactMode,
        focus, setFocus, highlightId, revealChannel,
        health, healthLoading, refreshHealth, effectiveOf,
        changes, changesLoading, loadChanges, markReviewed,
        selectedChannelIds, setSelectedChannelIds,
        toggleChannelSelection, bulkDeleteChannels, bulkMoveChannels,
        exportBouquet, importBouquet,
        stats,
        loading, loadingCategories, loadingStreams, saving: pending > 0,
        syncError, totalStreams, streamsPage, totalStreamsPages,
        useChannelNumbers, setUseChannelNumbers,
        fetchPlaylist, fetchCategories, fetchStreams, resetPlaylist,
        startEditing, cancelEditing, saveEdit,
        addVirtualBouquet, deleteBouquet, reorderBouquets, duplicateBouquet, updateGroupSettings,
        addStreams, addStreamToBouquet, bulkAddStreamsToBouquet, removeStreamFromBouquet,
        reorderChannels, jumpToChannelPosition, moveChannelToBouquet,
        excludeChannels, setGuideMode, replaceChannel,
        runTool,
        selectEPG, getEPGDebugInfo,
        undo, redo,
        canUndo: historySize.past > 0,
        canRedo: historySize.future > 0,
        // Handlers read the playlist through `playlistRef`, so they are stable
        // enough to leave out of the dependency list on purpose.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }), [
        playlist, selectedBouquetId, categories, streams, selectedCategory, selectCategory,
        sourceSubscriptionId, sourceSubscriptionName, allSubscriptions, basket, epgSources, mappingId,
        bouquetLabel, channelLabel, channelEditableName, membership, groupOfChannel,
        includedCategoryIds, excludedStreamIds, sourceNames,
        editingId, editValue, compactMode, focus, highlightId, selectedChannelIds, stats,
        health, healthLoading, changes, changesLoading,
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
