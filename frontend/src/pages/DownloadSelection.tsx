import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Download, ChevronDown, ChevronRight, Eye, EyeOff, Loader2 } from 'lucide-react';
import { useToast } from '@/contexts/ToastContext';
import { useUnsavedChanges } from '@/hooks/useUnsavedChanges';
import api from '@/lib/api';

const PAGE_SIZE = 100;

interface Media {
    id: number;
    name: string;
    cover: string;
    cat_id: string;
    cat_name?: string;
}

interface CategoryIndexEntry {
    cat_id: string;
    name: string;
    count: number;
}

interface ItemPage {
    items: Media[];
    total: number;
    page: number;
    pages: number;
}

interface Episode {
    id: string;
    episode_num: string;
    title: string;
    container_extension: string;
    duration: string;
}

interface Season {
    season_number: number;
    episodes: Episode[];
}

interface SeriesDetail {
    info: any;
    seasons: Season[];
}

interface Subscription {
    id: number;
    name: string;
}

interface MonitoredItem {
    id: number;
    subscription_id: number;
    media_type: string;
    media_id: string;
    title: string;
}

export default function DownloadSelection() {
    const toast = useToast();
    const [subscriptions, setSubscriptions] = useState<Subscription[]>([]);
    const [selectedSubscription, setSelectedSubscription] = useState<number | null>(null);
    const [mediaType, setMediaType] = useState<'movies' | 'series'>('movies');
    const [categoryIndex, setCategoryIndex] = useState<CategoryIndexEntry[]>([]);
    const [totalItems, setTotalItems] = useState(0);
    // Items are fetched per category, on expand, one page at a time
    const [categoryItems, setCategoryItems] = useState<Record<string, ItemPage>>({});
    const [loadingCategories, setLoadingCategories] = useState<Set<string>>(new Set());
    const [expandedCategories, setExpandedCategories] = useState<Set<string>>(new Set());
    const [selectedMedia, setSelectedMedia] = useState<Set<number>>(new Set());
    const [selectedEpisodes, setSelectedEpisodes] = useState<Set<number>>(new Set());
    const [monitoredItems, setMonitoredItems] = useState<MonitoredItem[]>([]);
    const [loading, setLoading] = useState(false);
    const [itemToUnmonitor, setItemToUnmonitor] = useState<{ id: number, title: string } | null>(null);
    const [searchTerm, setSearchTerm] = useState("");
    const [searchResults, setSearchResults] = useState<ItemPage | null>(null);
    const [searching, setSearching] = useState(false);

    // New state for series expansion
    const [expandedSeries, setExpandedSeries] = useState<Set<string>>(new Set());
    const [seriesDetails, setSeriesDetails] = useState<Record<string, SeriesDetail>>({});
    const [loadingSeries, setLoadingSeries] = useState<Set<string>>(new Set());
    const [checkingMonitored, setCheckingMonitored] = useState(false);

    // Selections live only in React state until "Queue Downloads" is pressed,
    // so anything that reloads the catalogue has to ask first.
    const guard = useUnsavedChanges(selectedMedia.size > 0 || selectedEpisodes.size > 0);

    useEffect(() => {
        fetchSubscriptions();
        fetchMonitoredItems();
    }, []);

    // Search runs server-side: the catalogue is far too large to filter in the browser
    useEffect(() => {
        const term = searchTerm.trim();
        if (!term || !selectedSubscription || categoryIndex.length === 0) {
            setSearchResults(null);
            setSearching(false);
            return;
        }

        setSearching(true);
        const handle = setTimeout(async () => {
            try {
                const res = await api.get<ItemPage>(
                    `/downloads/browse/${selectedSubscription}`,
                    { params: { media_type: mediaType, q: term, page: 1, page_size: PAGE_SIZE } }
                );
                setSearchResults(res.data);
            } catch (error) {
                console.error("Search failed", error);
                setSearchResults(null);
            } finally {
                setSearching(false);
            }
        }, 400);

        return () => clearTimeout(handle);
    }, [searchTerm, selectedSubscription, mediaType, categoryIndex.length]);

    // Clear selections and loaded pages when changing media type or subscription
    useEffect(() => {
        setSelectedMedia(new Set());
        setSelectedEpisodes(new Set());
        setCategoryIndex([]);
        setCategoryItems({});
        setExpandedCategories(new Set());
        setSearchResults(null);
        setTotalItems(0);
    }, [mediaType, selectedSubscription]);

    const fetchSeriesDetails = async (seriesId: string) => {
        if (seriesDetails[seriesId] || !selectedSubscription) return;

        setLoadingSeries(prev => new Set(prev).add(seriesId));
        try {
            const res = await api.get<SeriesDetail>(`/downloads/browse/${selectedSubscription}/series/${seriesId}`);
            setSeriesDetails(prev => ({ ...prev, [seriesId]: res.data }));
        } catch (error) {
            console.error(`Failed to fetch series details for ${seriesId}`, error);
        } finally {
            setLoadingSeries(prev => {
                const newSet = new Set(prev);
                newSet.delete(seriesId);
                return newSet;
            });
        }
    };

    const fetchSubscriptions = async () => {
        try {
            const res = await api.get<Subscription[]>('/subscriptions');
            setSubscriptions(res.data);
            if (res.data.length > 0) {
                setSelectedSubscription(res.data[0].id);
            }
        } catch (error) {
            console.error("Failed to fetch subscriptions", error);
        }
    };

    const forceMonitoringCheck = async () => {
        setCheckingMonitored(true);
        try {
            await api.post('/downloads/monitored/check');
            toast.success('Monitoring check started', 'New items will appear in the Download Manager.');
        } catch (error) {
            console.error("Failed to trigger monitoring check", error);
            toast.apiError('Failed to start monitoring check', error);
        } finally {
            setCheckingMonitored(false);
        }
    };

    const fetchMonitoredItems = async () => {
        try {
            const res = await api.get<MonitoredItem[]>('/downloads/monitored');
            setMonitoredItems(res.data);
        } catch (error) {
            console.error("Failed to fetch monitored items", error);
        }
    };

    const fetchMedia = async () => {
        if (!selectedSubscription) return;

        setLoading(true);
        try {
            // Only the category index: a few KB, whatever the catalogue size
            const res = await api.get<{ categories: CategoryIndexEntry[]; total_items: number }>(
                `/downloads/browse/${selectedSubscription}`,
                { params: { media_type: mediaType } }
            );
            setCategoryIndex(res.data.categories);
            setTotalItems(res.data.total_items);
            setCategoryItems({});
            setExpandedCategories(new Set());
        } catch (error) {
            console.error("Failed to fetch media", error);
        } finally {
            setLoading(false);
        }
    };

    const fetchCategoryPage = async (catId: string, page: number) => {
        if (!selectedSubscription) return;

        setLoadingCategories(prev => new Set(prev).add(catId));
        try {
            const res = await api.get<ItemPage>(
                `/downloads/browse/${selectedSubscription}`,
                { params: { media_type: mediaType, cat_id: catId, page, page_size: PAGE_SIZE } }
            );
            setCategoryItems(prev => {
                const previous = page > 1 ? (prev[catId]?.items ?? []) : [];
                return { ...prev, [catId]: { ...res.data, items: [...previous, ...res.data.items] } };
            });
        } catch (error) {
            console.error(`Failed to fetch category ${catId}`, error);
        } finally {
            setLoadingCategories(prev => {
                const next = new Set(prev);
                next.delete(catId);
                return next;
            });
        }
    };

    // Every item currently loaded, used to resolve titles when queueing
    const findLoadedMedia = (id: number): Media | undefined => {
        for (const page of Object.values(categoryItems)) {
            const hit = page.items.find(m => m.id === id);
            if (hit) return hit;
        }
        return searchResults?.items.find(m => m.id === id);
    };

    const toggleMonitoring = async (mType: string, mId: string, title: string) => {
        if (!selectedSubscription) return;

        const existing = monitoredItems.find(i =>
            i.subscription_id === selectedSubscription &&
            i.media_id === mId &&
            i.media_type === mType
        );

        try {
            if (existing) {
                // Open confirmation dialog instead of window.confirm
                setItemToUnmonitor({ id: existing.id, title });
            } else {
                await api.post('/downloads/monitored', {
                    subscription_id: selectedSubscription,
                    media_type: mType,
                    media_id: mId,
                    title: title
                });
                fetchMonitoredItems();
                toast.success('Monitoring enabled', title);
            }
        } catch (error) {
            console.error("Failed to toggle monitoring", error);
            toast.apiError('Failed to update monitoring', error);
        }
    };

    const confirmUnmonitor = async () => {
        if (!itemToUnmonitor) return;
        try {
            await api.delete(`/downloads/monitored/${itemToUnmonitor.id}`);
            toast.success('Monitoring stopped', itemToUnmonitor.title);
            setItemToUnmonitor(null);
            fetchMonitoredItems();
        } catch (error) {
            console.error("Failed to remove monitored item", error);
            toast.apiError('Failed to stop monitoring', error);
        }
    };

    const isMonitored = (mType: string, mId: string) => {
        return monitoredItems.some(i =>
            i.subscription_id === selectedSubscription &&
            i.media_id === mId &&
            i.media_type === mType
        );
    };

    const toggleCategory = (catId: string) => {
        const newExpanded = new Set(expandedCategories);
        if (newExpanded.has(catId)) {
            newExpanded.delete(catId);
        } else {
            newExpanded.add(catId);
            // Fetch the first page the first time this category is opened
            if (!categoryItems[catId]) fetchCategoryPage(catId, 1);
        }
        setExpandedCategories(newExpanded);
    };

    const toggleMedia = (mediaId: number) => {
        const newSelected = new Set(selectedMedia);
        if (newSelected.has(mediaId)) {
            newSelected.delete(mediaId);
        } else {
            newSelected.add(mediaId);
        }
        setSelectedMedia(newSelected);
    };

    const toggleSeries = async (seriesId: string) => {
        const newExpanded = new Set(expandedSeries);
        if (newExpanded.has(seriesId)) {
            newExpanded.delete(seriesId);
        } else {
            newExpanded.add(seriesId);
            fetchSeriesDetails(seriesId);
        }
        setExpandedSeries(newExpanded);
    };

    const toggleEpisode = (episodeId: string) => {
        // We use string IDs for episodes now
        const id = Number(episodeId);
        const newSelected = new Set(selectedEpisodes);
        if (newSelected.has(id)) {
            newSelected.delete(id);
        } else {
            newSelected.add(id);
        }
        setSelectedEpisodes(newSelected);
    };

    const toggleSeason = (_seriesId: string, season: Season) => {
        const newSelected = new Set(selectedEpisodes);
        const allSelected = season.episodes.every(ep => newSelected.has(Number(ep.id)));

        season.episodes.forEach(ep => {
            if (allSelected) {
                newSelected.delete(Number(ep.id));
            } else {
                newSelected.add(Number(ep.id));
            }
        });
        setSelectedEpisodes(newSelected);
    };

    // Selects what is currently loaded for the category. The button label states the
    // count so this is never mistaken for "select the whole category".
    const selectAllInCategory = (catId: string) => {
        const loaded = categoryItems[catId]?.items ?? [];
        const newSelected = new Set(selectedMedia);
        loaded.forEach(m => newSelected.add(m.id));
        setSelectedMedia(newSelected);
    };

    const queueSeriesDownload = async (seriesId: string, title: string) => {
        if (!selectedSubscription) return;
        try {
            await api.post('/downloads/queue/bulk', {
                subscription_id: selectedSubscription,
                media_ids: [seriesId],
                media_type: 'series',
                titles: [title],
            });
            toast.success('Series queued', title);
        } catch (error) {
            console.error("Failed to queue series download", error);
            toast.apiError('Failed to queue series', error);
        }
    };

    // The row button used to only tick the checkbox, which made "Download" a lie.
    // It now queues that single item straight away, leaving the checkboxes for
    // the separate bulk flow.
    const queueSingleDownload = async (media: Media) => {
        if (!selectedSubscription) return;
        try {
            await api.post('/downloads/queue/bulk', {
                subscription_id: selectedSubscription,
                media_ids: [media.id],
                media_type: 'movie',
                titles: [media.name],
            });
            toast.success('Queued for download', media.name);
        } catch (error) {
            console.error("Failed to queue download", error);
            toast.apiError('Failed to queue download', error);
        }
    };

    const queueDownloads = async () => {
        if (!selectedSubscription || (selectedMedia.size === 0 && selectedEpisodes.size === 0)) return;

        try {
            const selectedMediaIds = Array.from(selectedMedia);
            const selectedEpIds = Array.from(selectedEpisodes);

            let totalQueued = 0;

            if (mediaType === 'movies') {
                if (selectedMediaIds.length > 0) {
                    // Collect movie titles
                    const titles = selectedMediaIds.map(mId => findLoadedMedia(mId)?.name ?? `Movie ${mId}`);

                    await api.post('/downloads/queue/bulk', {
                        subscription_id: selectedSubscription,
                        media_ids: selectedMediaIds,
                        media_type: 'movie',
                        titles: titles
                    });
                    totalQueued += selectedMediaIds.length;
                }
            } else {
                // Series Mode

                // 1. Queue selected Series (Full)
                if (selectedMediaIds.length > 0) {
                    // Titles for series don't strictly need to be passed if expansion handles it,
                    // but we can pass them anyway for safety
                    const titles = selectedMediaIds.map(mId => findLoadedMedia(mId)?.name ?? `Series ${mId}`);

                    await api.post('/downloads/queue/bulk', {
                        subscription_id: selectedSubscription,
                        media_ids: selectedMediaIds,
                        media_type: 'series',
                        titles: titles
                    });
                    totalQueued += selectedMediaIds.length;
                }

                // 2. Queue selected Episodes
                if (selectedEpIds.length > 0) {
                    // Build explicit titles for episodes: Series Name - SXXEYY - Title
                    const titles = selectedEpIds.map(epId => {
                        for (const sId in seriesDetails) {
                            const detail = seriesDetails[sId];
                            for (const season of detail.seasons) {
                                const ep = season.episodes.find(e => Number(e.id) === epId);
                                if (ep) {
                                    const sName = detail.info?.name || "Series";
                                    const epInfo = `S${season.season_number.toString().padStart(2, '0')}E${ep.episode_num.toString().padStart(2, '0')}`;
                                    const epTitle = ep.title ? ` - ${ep.title}` : "";
                                    return `${sName} - ${epInfo}${epTitle}`;
                                }
                            }
                        }
                        return `Episode ${epId}`;
                    });

                    await api.post('/downloads/queue/bulk', {
                        subscription_id: selectedSubscription,
                        media_ids: selectedEpIds,
                        media_type: 'episode',
                        titles: titles
                    });
                    totalQueued += selectedEpIds.length;
                }
            }

            toast.success(`${totalQueued} item${totalQueued === 1 ? '' : 's'} queued`, 'Track progress in the Download Manager.');
            setSelectedMedia(new Set());
            setSelectedEpisodes(new Set());
        } catch (error) {
            console.error("Failed to queue downloads", error);
            toast.apiError('Failed to queue downloads', error);
        }
    };

    // One media row, shared by the category list and the search results
    const renderMediaRow = (media: Media, showCategory = false) => {
                                                    const seriesMonitored = mediaType === 'series' && isMonitored('series', String(media.id));
                                                    const isExpanded = mediaType === 'series' && expandedSeries.has(String(media.id));
                                                    const details = seriesDetails[String(media.id)];
                                                    const isLoading = loadingSeries.has(String(media.id));

                                                    return (
                                                        <div key={media.id} className="bg-background">
                                                            <div className="flex items-center justify-between p-3 hover:bg-muted/50 transition-colors">
                                                                <div className="flex items-center gap-3">
                                                                    {mediaType === 'series' && (
                                                                        <Button
                                                                            variant="ghost"
                                                                            size="sm"
                                                                            className="h-6 w-6 p-0"
                                                                            onClick={() => toggleSeries(String(media.id))}
                                                                        >
                                                                            {isLoading ? (
                                                                                <Loader2 className="h-4 w-4 animate-spin" />
                                                                            ) : isExpanded ? (
                                                                                <ChevronDown className="h-4 w-4" />
                                                                            ) : (
                                                                                <ChevronRight className="h-4 w-4" />
                                                                            )}
                                                                        </Button>
                                                                    )}

                                                                    {(mediaType === 'movies' || !isExpanded) && (
                                                                        <input
                                                                            type="checkbox"
                                                                            checked={selectedMedia.has(media.id)}
                                                                            onChange={() => toggleMedia(media.id)}
                                                                            className="w-4 h-4 rounded border-input"
                                                                        />
                                                                    )}

                                                                    {media.cover && (
                                                                        <img
                                                                            src={media.cover}
                                                                            alt={media.name}
                                                                            className="w-10 h-14 object-cover rounded shadow-sm"
                                                                        />
                                                                    )}
                                                                    <div className="flex flex-col">
                                                                        <span className="font-medium text-sm">{media.name}</span>
                                                                        {showCategory && media.cat_name && (
                                                                            <span className="text-[10px] text-muted-foreground">{media.cat_name}</span>
                                                                        )}
                                                                        {seriesMonitored && (
                                                                            <span className="text-[10px] text-green-600 font-medium flex items-center gap-1">
                                                                                <Eye className="w-3 h-3" /> Auto-downloading episodes
                                                                            </span>
                                                                        )}
                                                                    </div>
                                                                </div>

                                                                <div className="flex items-center gap-2">
                                                                    {mediaType === 'series' ? (
                                                                        <Button
                                                                            size="sm"
                                                                            variant={seriesMonitored ? "destructive" : "ghost"}
                                                                            onClick={() => toggleMonitoring('series', String(media.id), media.name)}
                                                                            title="Monitor this series"
                                                                            className="h-8 w-8 p-0"
                                                                        >
                                                                            {seriesMonitored ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                                                                        </Button>
                                                                    ) : null}

                                                                    {!isExpanded && (
                                                                        <Button
                                                                            size="sm"
                                                                            variant="default"
                                                                            onClick={() => {
                                                                                if (mediaType === 'series') {
                                                                                    queueSeriesDownload(String(media.id), media.name);
                                                                                } else {
                                                                                    queueSingleDownload(media);
                                                                                }
                                                                            }}
                                                                            title={mediaType === 'series'
                                                                                ? 'Queue every episode of this series'
                                                                                : 'Queue this movie now'}
                                                                            className="h-8 px-3 text-xs"
                                                                        >
                                                                            <Download className="w-3 h-3 mr-1" />
                                                                            Download
                                                                        </Button>
                                                                    )}
                                                                </div>
                                                            </div>

                                                            {/* Series Expansion */}
                                                            {isExpanded && details && (
                                                                <div className="bg-muted/30 p-3 pl-12 border-t">
                                                                    {details.seasons.map(season => {
                                                                        const allSeasonSelected = season.episodes.every(ep => selectedEpisodes.has(Number(ep.id)));

                                                                        return (
                                                                            <div key={season.season_number} className="mb-4 last:mb-0">
                                                                                <div className="flex items-center gap-2 mb-2">
                                                                                    <input
                                                                                        type="checkbox"
                                                                                        checked={allSeasonSelected}
                                                                                        onChange={() => toggleSeason(String(media.id), season)}
                                                                                        className="w-4 h-4 rounded border-input"
                                                                                    />
                                                                                    <span className="font-semibold text-sm">Season {season.season_number}</span>
                                                                                    <span className="text-xs text-muted-foreground">({season.episodes.length} episodes)</span>
                                                                                </div>
                                                                                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2 pl-6">
                                                                                    {season.episodes.map(ep => (
                                                                                        <div key={ep.id} className="flex items-center gap-2 bg-background border rounded p-2 text-sm">
                                                                                            <input
                                                                                                type="checkbox"
                                                                                                checked={selectedEpisodes.has(Number(ep.id))}
                                                                                                onChange={() => toggleEpisode(ep.id)}
                                                                                                className="w-3 h-3 rounded border-input"
                                                                                            />
                                                                                            <div className="flex-1 truncate" title={ep.title}>
                                                                                                <span className="font-medium text-xs text-muted-foreground mr-2">{ep.episode_num}.</span>
                                                                                                <span>{ep.title}</span>
                                                                                            </div>
                                                                                        </div>
                                                                                    ))}
                                                                                </div>
                                                                            </div>
                                                                        );
                                                                    })}
                                                                </div>
                                                            )}
                                                        </div>
                                                    );
    };

    return (
        <div className="space-y-6">
            <div className="flex justify-between items-center">
                <div>
                    <h2 className="text-3xl font-bold tracking-tight">Download Selection</h2>
                    <p className="text-muted-foreground">Browse and select media to download or monitor</p>
                </div>
                <Button variant="outline" onClick={forceMonitoringCheck} disabled={checkingMonitored}>
                    {checkingMonitored
                        ? <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        : <Download className="mr-2 h-4 w-4" />}
                    Force Sync Check
                </Button>
            </div>

            {/* Controls */}
            <Card>
                <CardHeader>
                    <CardTitle>Selection Controls</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                    <div className="grid gap-4 md:grid-cols-3">
                        <div>
                            <label className="text-sm font-medium">Subscription</label>
                            <select
                                className="w-full mt-1 p-2 border rounded bg-background"
                                value={selectedSubscription || ''}
                                onChange={(e) => {
                                    const next = Number(e.target.value);
                                    guard.run(() => setSelectedSubscription(next));
                                }}
                            >
                                {subscriptions.map(sub => (
                                    <option key={sub.id} value={sub.id}>{sub.name}</option>
                                ))}
                            </select>
                        </div>
                        <div>
                            <label className="text-sm font-medium">Media Type</label>
                            <select
                                className="w-full mt-1 p-2 border rounded bg-background"
                                value={mediaType}
                                onChange={(e) => {
                                    const next = e.target.value as 'movies' | 'series';
                                    guard.run(() => setMediaType(next));
                                }}
                            >
                                <option value="movies">Movies</option>
                                <option value="series">Series</option>
                            </select>
                        </div>
                        <div className="flex items-end">
                            <Button onClick={fetchMedia} disabled={loading} className="w-full">
                                {loading ? 'Loading...' : 'Browse Media'}
                            </Button>
                        </div>
                    </div>

                    {categoryIndex.length > 0 && (
                        <div className="pt-2 border-t space-y-2">
                            <p className="text-sm text-muted-foreground">
                                {categoryIndex.length} categories · {totalItems.toLocaleString()} {mediaType}
                            </p>
                            <div className="relative">
                                <input
                                    type="text"
                                    placeholder="Search movies or series..."
                                    className="w-full p-2 pl-3 pr-10 border rounded bg-muted/20"
                                    value={searchTerm}
                                    onChange={(e) => setSearchTerm(e.target.value)}
                                />
                                {searchTerm && (
                                    <button
                                        onClick={() => setSearchTerm("")}
                                        className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                                    >
                                        ×
                                    </button>
                                )}
                            </div>
                        </div>
                    )}

                    {(selectedMedia.size > 0 || selectedEpisodes.size > 0) && (
                        <div className="flex items-center justify-between p-4 bg-primary/10 border border-primary/20 rounded">
                            <span className="font-medium">{selectedMedia.size + selectedEpisodes.size} items selected</span>
                            <Button onClick={queueDownloads}>
                                <Download className="mr-2 h-4 w-4" />
                                Queue Downloads
                            </Button>
                        </div>
                    )}
                </CardContent>
            </Card>

            {/* Media Browser */}
            <Card>
                <CardHeader>
                    <CardTitle>Available Media</CardTitle>
                </CardHeader>
                <CardContent>
                    {categoryIndex.length === 0 ? (
                        <p className="text-center text-muted-foreground py-8">
                            Select a subscription and click "Browse Media" to start
                        </p>
                    ) : searchTerm.trim() ? (
                        <div className="space-y-2">
                            {searching ? (
                                <p className="text-center text-muted-foreground py-8 flex items-center justify-center gap-2">
                                    <Loader2 className="h-4 w-4 animate-spin" /> Searching…
                                </p>
                            ) : searchResults && searchResults.items.length > 0 ? (
                                <>
                                    <p className="text-sm text-muted-foreground">
                                        {searchResults.total} result{searchResults.total === 1 ? '' : 's'}
                                        {searchResults.total > searchResults.items.length &&
                                            ` — showing the first ${searchResults.items.length}, refine your search to narrow it down`}
                                    </p>
                                    <div className="border rounded-lg divide-y">
                                        {searchResults.items.map(media => renderMediaRow(media, true))}
                                    </div>
                                </>
                            ) : (
                                <p className="text-center text-muted-foreground py-8">No match for “{searchTerm}”</p>
                            )}
                        </div>
                    ) : (
                        <div className="space-y-2">
                            {categoryIndex.map(cat => {
                                const catId = cat.cat_id;
                                const loadedPage = categoryItems[catId];
                                const isCategoryLoading = loadingCategories.has(catId);
                                const monitorType = mediaType === 'movies' ? 'category_movie' : 'category_series';
                                const monitored = isMonitored(monitorType, catId);

                                return (
                                    <div key={catId} className="border rounded-lg">
                                        <div
                                            className="flex items-center justify-between p-3 cursor-pointer hover:bg-muted/60 bg-muted/30"
                                            onClick={() => toggleCategory(catId)}
                                        >
                                            <div className="flex items-center gap-2">
                                                {expandedCategories.has(catId) ? (
                                                    <ChevronDown className="h-4 w-4" />
                                                ) : (
                                                    <ChevronRight className="h-4 w-4" />
                                                )}
                                                <span className="font-medium">{cat.name}</span>
                                                <span className="text-sm text-muted-foreground">
                                                    ({cat.count} items)
                                                </span>
                                                {monitored && (
                                                    <span className="px-2 py-0.5 bg-green-100 text-green-700 text-xs rounded-full flex items-center gap-1">
                                                        <Eye className="w-3 h-3" /> Monitored
                                                    </span>
                                                )}
                                            </div>
                                            <div className="flex items-center gap-2">
                                                <Button
                                                    size="sm"
                                                    variant={monitored ? "destructive" : "secondary"}
                                                    onClick={(e) => {
                                                        e.stopPropagation();
                                                        toggleMonitoring(monitorType, catId, `Category: ${cat.name}`);
                                                    }}
                                                    title={monitored ? "Stop monitoring this category" : "Auto-download new items in this category"}
                                                    className="h-8"
                                                >
                                                    {monitored ? <EyeOff className="w-3 h-3 mr-1" /> : <Eye className="w-3 h-3 mr-1" />}
                                                    <span className="text-xs">{monitored ? 'Unmonitor' : 'Monitor'}</span>
                                                </Button>
                                                <Button
                                                    size="sm"
                                                    variant="ghost"
                                                    onClick={(e) => {
                                                        e.stopPropagation();
                                                        selectAllInCategory(catId);
                                                    }}
                                                    disabled={!loadedPage || loadedPage.items.length === 0}
                                                    className="h-8 text-xs"
                                                >
                                                    {loadedPage ? `Select ${loadedPage.items.length} loaded` : 'Select All'}
                                                </Button>
                                            </div>
                                        </div>

                                        {expandedCategories.has(catId) && (
                                            <div className="divide-y">
                                                {isCategoryLoading && !loadedPage && (
                                                    <p className="p-4 text-sm text-muted-foreground flex items-center gap-2">
                                                        <Loader2 className="h-4 w-4 animate-spin" /> Loading…
                                                    </p>
                                                )}
                                                {(loadedPage?.items ?? []).map(media => renderMediaRow(media))}

                                                {loadedPage && loadedPage.items.length < loadedPage.total && (
                                                    <div className="p-3 flex items-center justify-between bg-muted/30">
                                                        <span className="text-xs text-muted-foreground">
                                                            {loadedPage.items.length} of {loadedPage.total} loaded
                                                        </span>
                                                        <Button
                                                            size="sm"
                                                            variant="outline"
                                                            disabled={isCategoryLoading}
                                                            onClick={() => fetchCategoryPage(catId, loadedPage.page + 1)}
                                                            className="h-8 text-xs"
                                                        >
                                                            {isCategoryLoading ? (
                                                                <><Loader2 className="h-3 w-3 mr-1 animate-spin" /> Loading…</>
                                                            ) : (
                                                                `Load ${Math.min(PAGE_SIZE, loadedPage.total - loadedPage.items.length)} more`
                                                            )}
                                                        </Button>
                                                    </div>
                                                )}
                                            </div>
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </CardContent>
            </Card>

            <ConfirmDialog
                isOpen={!!itemToUnmonitor}
                onClose={() => setItemToUnmonitor(null)}
                onConfirm={confirmUnmonitor}
                title="Stop Monitoring?"
                variant="destructive"
                confirmLabel="Stop Monitoring"
            >
                <p>
                    Stop monitoring <strong>{itemToUnmonitor?.title}</strong>?
                </p>
                <p className="text-muted-foreground">
                    New items will no longer be downloaded automatically. Existing downloads are kept.
                </p>
            </ConfirmDialog>

            <ConfirmDialog
                isOpen={guard.isPrompting}
                onClose={guard.cancel}
                onConfirm={guard.proceed}
                title="Discard your selection?"
                variant="destructive"
                confirmLabel="Discard and continue"
            >
                <p>
                    You have <strong>{selectedMedia.size + selectedEpisodes.size}</strong> item(s) selected
                    that have not been queued yet.
                </p>
                <p className="text-muted-foreground">
                    Changing the subscription or media type reloads the catalogue and clears the selection.
                </p>
            </ConfirmDialog>
        </div >
    );
}
