import { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { RefreshCw, Save, CheckSquare, Square, Film, Tv, StopCircle, AlertCircle, CheckCircle2 } from 'lucide-react';
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { SyncProgress } from "@/components/SyncProgress";
import { useToast } from '@/contexts/ToastContext';
import { useUnsavedChanges } from '@/hooks/useUnsavedChanges';
import api from '@/lib/api';
import { formatDateTime } from '@/lib/utils';

interface M3USource {
    id: number;
    name: string;
    is_active: boolean;
}

interface Group {
    group_title: string;
    entry_type: string;
    count: number;
    selected: boolean;
}

interface SyncStatus {
    id: number;
    m3u_source_id: number;
    type: string;
    last_sync: string | null;
    status: string;
    items_added: number;
    items_deleted: number;
    error_message?: string;
    // Live counters of the run in flight; cleared by the backend when it ends.
    progress_done?: number;
    progress_total?: number;
    progress_phase?: string | null;
}

type SortKey = 'name' | 'count';
type SortDirection = 'asc' | 'desc';

interface SortConfig {
    key: SortKey;
    direction: SortDirection;
}

export default function M3USelection() {
    const toast = useToast();
    const [sources, setSources] = useState<M3USource[]>([]);
    const [statuses, setStatuses] = useState<SyncStatus[]>([]);
    const [selectedSourceId, setSelectedSourceId] = useState<number | null>(null);
    const [movieGroups, setMovieGroups] = useState<Group[]>([]);
    const [seriesGroups, setSeriesGroups] = useState<Group[]>([]);
    const [syncingMovies, setSyncingMovies] = useState(false);
    const [syncingSeries, setSyncingSeries] = useState(false);
    const [savingMovies, setSavingMovies] = useState(false);
    const [savingSeries, setSavingSeries] = useState(false);

    const [filterText, setFilterText] = useState('');
    const [movieSort, setMovieSort] = useState<SortConfig>({ key: 'name', direction: 'asc' });
    const [seriesSort, setSeriesSort] = useState<SortConfig>({ key: 'name', direction: 'asc' });

    const [error, setError] = useState<string | null>(null);
    const [savedMovies, setSavedMovies] = useState<Record<string, boolean>>({});
    const [savedSeries, setSavedSeries] = useState<Record<string, boolean>>({});

    const isDirty =
        movieGroups.some(g => savedMovies[g.group_title] !== g.selected) ||
        seriesGroups.some(g => savedSeries[g.group_title] !== g.selected);
    const guard = useUnsavedChanges(isDirty);

    useEffect(() => {
        fetchSources();
        fetchSyncStatus();
        // 2s rather than 5s: this now drives a progress bar, and a bar that
        // only moves every five seconds reads as stuck.
        const interval = setInterval(fetchSyncStatus, 2000);
        return () => clearInterval(interval);
    }, []);

    useEffect(() => {
        if (selectedSourceId) {
            fetchGroups();
            setError(null);
        }
    }, [selectedSourceId]);

    const fetchSources = async () => {
        try {
            const res = await api.get<M3USource[]>('/m3u-sources/');
            const active = res.data.filter(s => s.is_active);
            setSources(active);
            // Seed from the active list so an inactive first source does not
            // leave the selector blank.
            if (active.length > 0 && !selectedSourceId) {
                setSelectedSourceId(active[0].id);
            }
        } catch (error) {
            console.error("Failed to fetch M3U sources", error);
            setError("Failed to fetch M3U sources");
        }
    };

    const fetchSyncStatus = async () => {
        try {
            const res = await api.get<SyncStatus[]>('/m3u-sync/status');
            setStatuses(res.data);
        } catch (error) {
            console.error("Failed to fetch sync status", error);
        }
    };

    const triggerSync = async (sourceId: number, type: 'movies' | 'series') => {
        try {
            await api.post(`/m3u-sync/${type}/${sourceId}`);
            await fetchSyncStatus();
        } catch (error) {
            console.error(`Failed to trigger ${type} sync`, error);
        }
    };

    const [isRefreshing, setIsRefreshing] = useState(false);
    const [refreshStatus, setRefreshStatus] = useState<'idle' | 'importing' | 'success' | 'error'>('idle');

    const refreshSource = async () => {
        if (!selectedSourceId) return;
        setIsRefreshing(true);
        setRefreshStatus('importing');

        // Both timers are cleared through this one helper so the safety
        // timeout can stop the poller without reading stale state.
        let pollInterval: number | undefined;
        let safetyTimeout: number | undefined;
        const finish = (status: 'success' | 'error') => {
            if (pollInterval) window.clearInterval(pollInterval);
            if (safetyTimeout) window.clearTimeout(safetyTimeout);
            setIsRefreshing(false);
            setRefreshStatus(status);
            if (status === 'success') {
                fetchGroups();
                toast.success('Source updated', 'Groups reloaded from the source.');
                window.setTimeout(() => setRefreshStatus('idle'), 3000);
            } else {
                toast.error('Source update failed', 'Check the Logs page for details.');
            }
        };

        try {
            await api.post(`/m3u-sources/${selectedSourceId}/sync?force=true`);

            pollInterval = window.setInterval(async () => {
                try {
                    const response = await api.get('/m3u-sources');
                    const source = response.data.find((s: any) => s.id === selectedSourceId);
                    if (source?.sync_status === 'success') finish('success');
                    else if (source?.sync_status === 'error') finish('error');
                } catch (e) {
                    console.error("Polling error", e);
                }
            }, 2000);

            // Safety net. This used to read `isRefreshing` captured at setup
            // time, which was always false, so it never fired.
            safetyTimeout = window.setTimeout(() => finish('error'), 300000);
        } catch (error) {
            console.error("Failed to refresh source", error);
            finish('error');
        }
    };

    const stopSync = async (sourceId: number, type: 'movies' | 'series') => {
        try {
            await api.post(`/m3u-sync/stop/${sourceId}/${type}`);
            await fetchSyncStatus();
        } catch (error) {
            console.error(`Failed to stop ${type} sync`, error);
        }
    };

    const getStatusColor = (status: string) => {
        switch (status) {
            case 'success': return 'text-green-500';
            case 'failed': return 'text-red-500';
            case 'running': return 'text-blue-500 animate-pulse';
            default: return 'text-muted-foreground';
        }
    };

    const getStatusIcon = (status: string) => {
        switch (status) {
            case 'success': return <CheckCircle2 className="w-5 h-5 text-green-500" />;
            case 'failed': return <AlertCircle className="w-5 h-5 text-red-500" />;
            case 'running': return <RefreshCw className="w-5 h-5 text-blue-500 animate-spin" />;
            default: return <div className="w-5 h-5 rounded-full bg-muted" />;
        }
    };

    const getStatus = (sourceId: number, type: string) => {
        return statuses.find(s => s.m3u_source_id === sourceId && s.type === type);
    };

    // One request, split locally. The two fetchers used to call the same
    // endpoint separately, downloading the full group list twice per load.
    const fetchGroups = async () => {
        if (!selectedSourceId) return;
        try {
            const res = await api.get<Group[]>(`/m3u-selection/${selectedSourceId}/groups`);
            const movies = res.data.filter(g => g.entry_type === 'movie');
            const series = res.data.filter(g => g.entry_type === 'series');
            setMovieGroups(movies);
            setSeriesGroups(series);
            setSavedMovies(Object.fromEntries(movies.map(g => [g.group_title, g.selected])));
            setSavedSeries(Object.fromEntries(series.map(g => [g.group_title, g.selected])));
        } catch (error) {
            console.error("Failed to fetch groups", error);
            setError("Failed to fetch groups");
        }
    };

    const syncMovies = async () => {
        if (!selectedSourceId) return;
        setSyncingMovies(true);
        setError(null);
        try {
            await api.post(`/m3u-selection/${selectedSourceId}/sync`, {
                sync_types: ['movies']
            });
            await fetchGroups();
        } catch (error: any) {
            console.error("Failed to sync movie groups", error);
            setError(error.response?.data?.detail || "Failed to sync movie groups");
        } finally {
            setSyncingMovies(false);
        }
    };

    const syncSeries = async () => {
        if (!selectedSourceId) return;
        setSyncingSeries(true);
        setError(null);
        try {
            await api.post(`/m3u-selection/${selectedSourceId}/sync`, {
                sync_types: ['series']
            });
            await fetchGroups();
        } catch (error: any) {
            console.error("Failed to sync series groups", error);
            setError(error.response?.data?.detail || "Failed to sync series groups");
        } finally {
            setSyncingSeries(false);
        }
    };

    const saveMovies = async () => {
        if (!selectedSourceId) return;
        setSavingMovies(true);
        setError(null);
        try {
            const selected = movieGroups.filter(g => g.selected);
            await api.post(`/m3u-selection/${selectedSourceId}?selection_type=movie`, { groups: selected });
            setSavedMovies(Object.fromEntries(movieGroups.map(g => [g.group_title, g.selected])));
            toast.success('Movie groups saved', `${selected.length} group${selected.length === 1 ? '' : 's'} selected.`);
        } catch (error: any) {
            console.error("Failed to save movie groups", error);
            const detail = error.response?.data?.detail;
            setError(typeof detail === 'string' ? detail : "Failed to save movie groups");
            toast.apiError('Failed to save movie groups', error);
        } finally {
            setSavingMovies(false);
        }
    };

    const saveSeries = async () => {
        if (!selectedSourceId) return;
        setSavingSeries(true);
        setError(null);
        try {
            const selected = seriesGroups.filter(g => g.selected);
            await api.post(`/m3u-selection/${selectedSourceId}?selection_type=series`, { groups: selected });
            setSavedSeries(Object.fromEntries(seriesGroups.map(g => [g.group_title, g.selected])));
            toast.success('Series groups saved', `${selected.length} group${selected.length === 1 ? '' : 's'} selected.`);
        } catch (error: any) {
            console.error("Failed to save series groups", error);
            const detail = error.response?.data?.detail;
            setError(typeof detail === 'string' ? detail : "Failed to save series groups");
            toast.apiError('Failed to save series groups', error);
        } finally {
            setSavingSeries(false);
        }
    };

    const toggleMovie = (title: string) => {
        setMovieGroups(prev => prev.map(g =>
            g.group_title === title ? { ...g, selected: !g.selected } : g
        ));
    };

    const toggleSeries = (title: string) => {
        setSeriesGroups(prev => prev.map(g =>
            g.group_title === title ? { ...g, selected: !g.selected } : g
        ));
    };

    const toggleAllMovies = () => {
        const allSelected = filteredAndSortedMovies.every(g => g.selected);
        const visibleTitles = new Set(filteredAndSortedMovies.map(g => g.group_title));

        setMovieGroups(prev => prev.map(g =>
            visibleTitles.has(g.group_title) ? { ...g, selected: !allSelected } : g
        ));
    };

    const toggleAllSeries = () => {
        const allSelected = filteredAndSortedSeries.every(g => g.selected);
        const visibleTitles = new Set(filteredAndSortedSeries.map(g => g.group_title));

        setSeriesGroups(prev => prev.map(g =>
            visibleTitles.has(g.group_title) ? { ...g, selected: !allSelected } : g
        ));
    };

    const handleSort = (type: 'movie' | 'series', key: SortKey) => {
        if (type === 'movie') {
            setMovieSort(prev => ({
                key,
                direction: prev.key === key && prev.direction === 'asc' ? 'desc' : 'asc'
            }));
        } else {
            setSeriesSort(prev => ({
                key,
                direction: prev.key === key && prev.direction === 'asc' ? 'desc' : 'asc'
            }));
        }
    };

    const filterAndSort = (groups: Group[], sortConfig: SortConfig) => {
        let result = [...groups];

        if (filterText) {
            const lowerFilter = filterText.toLowerCase();
            result = result.filter(g =>
                g.group_title.toLowerCase().includes(lowerFilter)
            );
        }

        result.sort((a, b) => {
            let aValue: any = a.group_title;
            let bValue: any = b.group_title;

            if (sortConfig.key === 'count') {
                aValue = a.count;
                bValue = b.count;
            }

            if (aValue < bValue) return sortConfig.direction === 'asc' ? -1 : 1;
            if (aValue > bValue) return sortConfig.direction === 'asc' ? 1 : -1;
            return 0;
        });

        return result;
    };

    const filteredAndSortedMovies = filterAndSort(movieGroups, movieSort);
    const filteredAndSortedSeries = filterAndSort(seriesGroups, seriesSort);

    const renderSortIcon = (config: SortConfig, key: SortKey) => {
        if (config.key !== key) return null;
        return config.direction === 'asc' ? ' ↑' : ' ↓';
    };

    return (
        <div className="space-y-8 h-full flex flex-col">
            <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                    <h2 className="text-3xl font-bold tracking-tight">M3U Group Selection</h2>
                    <p className="text-muted-foreground">Choose which groups to synchronize (Movies &amp; Series).</p>
                </div>
                {isDirty && (
                    <div className="flex items-center gap-2 px-3 py-1.5 rounded-md border border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400 text-xs font-medium">
                        <AlertCircle className="h-4 w-4" />
                        Unsaved changes — press Save in each column to keep them
                    </div>
                )}
            </div>


            {/* Source Selector and Refresh */}
            <div className="flex gap-4 items-center">
                <div className="flex gap-2 items-center">
                    <label className="text-sm font-medium">M3U Source:</label>
                    <select
                        value={selectedSourceId || ''}
                        onChange={(e) => {
                            const next = Number(e.target.value);
                            guard.run(() => setSelectedSourceId(next));
                        }}
                        className="border rounded-md px-3 py-2 text-sm min-w-[200px] bg-background"
                    >
                        {sources.map(src => (
                            <option key={src.id} value={src.id}>{src.name}</option>
                        ))}
                    </select>
                </div>

                {selectedSourceId && (
                    <div className="flex items-center gap-3">
                        <Button
                            variant="outline"
                            size="sm"
                            onClick={refreshSource}
                            disabled={isRefreshing}
                        >
                            <RefreshCw className={`w-4 h-4 mr-2 ${isRefreshing ? 'animate-spin' : ''}`} />
                            Refresh Source
                        </Button>

                        {/* Progress Indicator */}
                        {refreshStatus !== 'idle' && (
                            <div className="flex items-center gap-2 text-sm">
                                {refreshStatus === 'importing' && (
                                    <>
                                        <span className="relative flex h-2 w-2">
                                            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75"></span>
                                            <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500"></span>
                                        </span>
                                        <span className="text-blue-600 font-medium">Importing source...</span>
                                    </>
                                )}
                                {refreshStatus === 'success' && (
                                    <>
                                        <CheckCircle2 className="w-4 h-4 text-green-500" />
                                        <span className="text-green-600 font-medium">Source updated!</span>
                                    </>
                                )}
                                {refreshStatus === 'error' && (
                                    <>
                                        <AlertCircle className="w-4 h-4 text-red-500" />
                                        <span className="text-red-600 font-medium">Update failed</span>
                                    </>
                                )}
                            </div>
                        )}
                    </div>
                )}
            </div>

            {/* Synchronization Status Block */}
            {
                selectedSourceId && (
                    <Card>
                        <CardHeader>
                            <CardTitle>Synchronization Status</CardTitle>
                        </CardHeader>
                        <CardContent>
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                {/* Movies Status */}
                                <div className="border rounded-lg p-4">
                                    <div className="flex items-center justify-between mb-3">
                                        <div className="flex items-center gap-2">
                                            <Film className="w-5 h-5 text-muted-foreground" />
                                            <span className="font-medium">Movies</span>
                                        </div>
                                        {getStatusIcon(getStatus(selectedSourceId, 'movies')?.status || 'idle')}
                                    </div>
                                    <div className="space-y-2 text-sm">
                                        <div className="flex justify-between">
                                            <span className="text-muted-foreground">Status:</span>
                                            <span className={`font-medium capitalize ${getStatusColor(getStatus(selectedSourceId, 'movies')?.status || 'idle')}`}>
                                                {getStatus(selectedSourceId, 'movies')?.status || 'Idle'}
                                            </span>
                                        </div>
                                        {getStatus(selectedSourceId, 'movies')?.last_sync && (
                                            <div className="flex justify-between">
                                                <span className="text-muted-foreground">Last Sync:</span>
                                                <span>{formatDateTime(getStatus(selectedSourceId, 'movies')?.last_sync)}</span>
                                            </div>
                                        )}
                                        {getStatus(selectedSourceId, 'movies')?.items_added !== undefined && (
                                            <div className="flex justify-between">
                                                <span className="text-muted-foreground">Added:</span>
                                                <span className="font-medium text-green-600">{getStatus(selectedSourceId, 'movies')?.items_added || 0}</span>
                                            </div>
                                        )}
                                        {getStatus(selectedSourceId, 'movies')?.items_deleted !== undefined && (
                                            <div className="flex justify-between">
                                                <span className="text-muted-foreground">Deleted:</span>
                                                <span className="font-medium text-red-600">{getStatus(selectedSourceId, 'movies')?.items_deleted || 0}</span>
                                            </div>
                                        )}
                                    </div>
                                    <SyncProgress
                                        status={getStatus(selectedSourceId, 'movies')?.status}
                                        phase={getStatus(selectedSourceId, 'movies')?.progress_phase}
                                        done={getStatus(selectedSourceId, 'movies')?.progress_done}
                                        total={getStatus(selectedSourceId, 'movies')?.progress_total}
                                    />
                                    <div className="mt-4">
                                        {getStatus(selectedSourceId, 'movies')?.status === 'running' ? (
                                            <Button
                                                onClick={() => stopSync(selectedSourceId, 'movies')}
                                                variant="destructive"
                                                size="sm"
                                                className="w-full"
                                            >
                                                <StopCircle className="w-4 h-4 mr-2" />
                                                Stop Sync
                                            </Button>
                                        ) : (
                                            <Button
                                                onClick={() => triggerSync(selectedSourceId, 'movies')}
                                                size="sm"
                                                className="w-full"
                                            >
                                                <RefreshCw className="w-4 h-4 mr-2" />
                                                Sync Now
                                            </Button>
                                        )}
                                    </div>
                                </div>

                                {/* Series Status */}
                                <div className="border rounded-lg p-4">
                                    <div className="flex items-center justify-between mb-3">
                                        <div className="flex items-center gap-2">
                                            <Tv className="w-5 h-5 text-muted-foreground" />
                                            <span className="font-medium">Series</span>
                                        </div>
                                        {getStatusIcon(getStatus(selectedSourceId, 'series')?.status || 'idle')}
                                    </div>
                                    <div className="space-y-2 text-sm">
                                        <div className="flex justify-between">
                                            <span className="text-muted-foreground">Status:</span>
                                            <span className={`font-medium capitalize ${getStatusColor(getStatus(selectedSourceId, 'series')?.status || 'idle')}`}>
                                                {getStatus(selectedSourceId, 'series')?.status || 'Idle'}
                                            </span>
                                        </div>
                                        {getStatus(selectedSourceId, 'series')?.last_sync && (
                                            <div className="flex justify-between">
                                                <span className="text-muted-foreground">Last Sync:</span>
                                                <span>{formatDateTime(getStatus(selectedSourceId, 'series')?.last_sync)}</span>
                                            </div>
                                        )}
                                        {getStatus(selectedSourceId, 'series')?.items_added !== undefined && (
                                            <div className="flex justify-between">
                                                <span className="text-muted-foreground">Added:</span>
                                                <span className="font-medium text-green-600">{getStatus(selectedSourceId, 'series')?.items_added || 0}</span>
                                            </div>
                                        )}
                                        {getStatus(selectedSourceId, 'series')?.items_deleted !== undefined && (
                                            <div className="flex justify-between">
                                                <span className="text-muted-foreground">Deleted:</span>
                                                <span className="font-medium text-red-600">{getStatus(selectedSourceId, 'series')?.items_deleted || 0}</span>
                                            </div>
                                        )}
                                    </div>
                                    <SyncProgress
                                        status={getStatus(selectedSourceId, 'series')?.status}
                                        phase={getStatus(selectedSourceId, 'series')?.progress_phase}
                                        done={getStatus(selectedSourceId, 'series')?.progress_done}
                                        total={getStatus(selectedSourceId, 'series')?.progress_total}
                                    />
                                    <div className="mt-4">
                                        {getStatus(selectedSourceId, 'series')?.status === 'running' ? (
                                            <Button
                                                onClick={() => stopSync(selectedSourceId, 'series')}
                                                variant="destructive"
                                                size="sm"
                                                className="w-full"
                                            >
                                                <StopCircle className="w-4 h-4 mr-2" />
                                                Stop Sync
                                            </Button>
                                        ) : (
                                            <Button
                                                onClick={() => triggerSync(selectedSourceId, 'series')}
                                                size="sm"
                                                className="w-full"
                                            >
                                                <RefreshCw className="w-4 h-4 mr-2" />
                                                Sync Now
                                            </Button>
                                        )}
                                    </div>
                                </div>
                            </div>
                        </CardContent>
                    </Card>
                )
            }

            {/* Error Display */}
            {
                error && (
                    <div className="bg-destructive/15 text-destructive px-4 py-3 rounded-md text-sm">
                        {error}
                    </div>
                )
            }

            {/* Filter Input */}
            {
                selectedSourceId && (
                    <div className="w-full md:w-64">
                        <input
                            type="text"
                            placeholder="Filter groups..."
                            value={filterText}
                            onChange={(e) => setFilterText(e.target.value)}
                            className="w-full border rounded-md px-3 py-2 text-sm"
                        />
                    </div>
                )
            }

            {
                !selectedSourceId ? (
                    <Card>
                        <CardContent className="p-8 text-center text-muted-foreground">
                            No M3U sources. Go to M3U Import to add sources.
                        </CardContent>
                    </Card>
                ) : (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6 flex-1 min-h-0">
                        {/* Movie Groups */}
                        <Card className="flex flex-col h-full">
                            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                                <CardTitle>Movies ({filteredAndSortedMovies.length})</CardTitle>
                                <div className="flex gap-2">
                                    <Button size="sm" variant="outline" onClick={syncMovies} disabled={syncingMovies}>
                                        <RefreshCw className={`w-4 h-4 mr-2 ${syncingMovies ? 'animate-spin' : ''}`} />
                                        Get from source
                                    </Button>
                                    <Button size="sm" onClick={saveMovies} disabled={savingMovies || movieGroups.length === 0}>
                                        <Save className="w-4 h-4 mr-2" />
                                        Save
                                    </Button>
                                </div>
                            </CardHeader>
                            <CardContent className="flex-1 overflow-auto min-h-[400px]">
                                {movieGroups.length > 0 ? (
                                    <div className="border rounded-md">
                                        <table className="w-full text-sm text-left">
                                            <thead className="bg-muted/50 text-muted-foreground sticky top-0">
                                                <tr>
                                                    <th className="p-3 w-10">
                                                        <button onClick={toggleAllMovies}>
                                                            {filteredAndSortedMovies.length > 0 && filteredAndSortedMovies.every(g => g.selected) ?
                                                                <CheckSquare className="w-4 h-4" /> :
                                                                <Square className="w-4 h-4" />
                                                            }
                                                        </button>
                                                    </th>
                                                    <th
                                                        className="p-3 cursor-pointer hover:bg-muted/80"
                                                        onClick={() => handleSort('movie', 'name')}
                                                    >
                                                        Group Name{renderSortIcon(movieSort, 'name')}
                                                    </th>
                                                    <th
                                                        className="p-3 w-20 cursor-pointer hover:bg-muted/80"
                                                        onClick={() => handleSort('movie', 'count')}
                                                    >
                                                        Count{renderSortIcon(movieSort, 'count')}
                                                    </th>
                                                </tr>
                                            </thead>
                                            <tbody className="divide-y">
                                                {filteredAndSortedMovies.map(group => (
                                                    <tr key={group.group_title} className="hover:bg-muted/50 transition-colors">
                                                        <td className="p-3">
                                                            <button onClick={() => toggleMovie(group.group_title)}>
                                                                {group.selected ?
                                                                    <CheckSquare className="w-4 h-4 text-primary" /> :
                                                                    <Square className="w-4 h-4 text-muted-foreground" />
                                                                }
                                                            </button>
                                                        </td>
                                                        <td className="p-3 font-medium cursor-pointer" onClick={() => toggleMovie(group.group_title)}>
                                                            {group.group_title}
                                                        </td>
                                                        <td className="p-3 text-muted-foreground">{group.count}</td>
                                                    </tr>
                                                ))}
                                            </tbody>
                                        </table>
                                    </div>
                                ) : (
                                    <div className="flex items-center justify-center h-full text-muted-foreground">
                                        Click "Get from source" to load data.
                                    </div>
                                )}
                            </CardContent>
                        </Card>

                        {/* Series Groups */}
                        <Card className="flex flex-col h-full">
                            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                                <CardTitle>Series ({filteredAndSortedSeries.length})</CardTitle>
                                <div className="flex gap-2">
                                    <Button size="sm" variant="outline" onClick={syncSeries} disabled={syncingSeries}>
                                        <RefreshCw className={`w-4 h-4 mr-2 ${syncingSeries ? 'animate-spin' : ''}`} />
                                        Get from source
                                    </Button>
                                    <Button size="sm" onClick={saveSeries} disabled={savingSeries || seriesGroups.length === 0}>
                                        <Save className="w-4 h-4 mr-2" />
                                        Save
                                    </Button>
                                </div>
                            </CardHeader>
                            <CardContent className="flex-1 overflow-auto min-h-[400px]">
                                {seriesGroups.length > 0 ? (
                                    <div className="border rounded-md">
                                        <table className="w-full text-sm text-left">
                                            <thead className="bg-muted/50 text-muted-foreground sticky top-0">
                                                <tr>
                                                    <th className="p-3 w-10">
                                                        <button onClick={toggleAllSeries}>
                                                            {filteredAndSortedSeries.length > 0 && filteredAndSortedSeries.every(g => g.selected) ?
                                                                <CheckSquare className="w-4 h-4" /> :
                                                                <Square className="w-4 h-4" />
                                                            }
                                                        </button>
                                                    </th>
                                                    <th
                                                        className="p-3 cursor-pointer hover:bg-muted/80"
                                                        onClick={() => handleSort('series', 'name')}
                                                    >
                                                        Group Name{renderSortIcon(seriesSort, 'name')}
                                                    </th>
                                                    <th
                                                        className="p-3 w-20 cursor-pointer hover:bg-muted/80"
                                                        onClick={() => handleSort('series', 'count')}
                                                    >
                                                        Count{renderSortIcon(seriesSort, 'count')}
                                                    </th>
                                                </tr>
                                            </thead>
                                            <tbody className="divide-y">
                                                {filteredAndSortedSeries.map(group => (
                                                    <tr key={group.group_title} className="hover:bg-muted/50 transition-colors">
                                                        <td className="p-3">
                                                            <button onClick={() => toggleSeries(group.group_title)}>
                                                                {group.selected ?
                                                                    <CheckSquare className="w-4 h-4 text-primary" /> :
                                                                    <Square className="w-4 h-4 text-muted-foreground" />
                                                                }
                                                            </button>
                                                        </td>
                                                        <td className="p-3 font-medium cursor-pointer" onClick={() => toggleSeries(group.group_title)}>
                                                            {group.group_title}
                                                        </td>
                                                        <td className="p-3 text-muted-foreground">{group.count}</td>
                                                    </tr>
                                                ))}
                                            </tbody>
                                        </table>
                                    </div>
                                ) : (
                                    <div className="flex items-center justify-center h-full text-muted-foreground">
                                        Click "Get from source" to load data.
                                    </div>
                                )}
                            </CardContent>
                        </Card>
                    </div>
                )
            }

            <ConfirmDialog
                isOpen={guard.isPrompting}
                onClose={guard.cancel}
                onConfirm={guard.proceed}
                title="Discard unsaved selection?"
                variant="destructive"
                confirmLabel="Discard and switch"
            >
                <p>You changed the group selection without saving it.</p>
                <p className="text-muted-foreground">
                    Switching source reloads the groups and those changes will be lost.
                </p>
            </ConfirmDialog>
        </div>
    );
}
