import { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { RefreshCw, Save, CheckSquare, Square, Film, Tv, StopCircle, AlertCircle, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { SyncProgress } from "@/components/SyncProgress";
import { useToast } from '@/contexts/ToastContext';
import { useUnsavedChanges } from '@/hooks/useUnsavedChanges';
import api from '@/lib/api';
import { formatDateTime } from '@/lib/utils';

interface Subscription {
    id: number;
    name: string;
    is_active: boolean;
}

interface Category {
    category_id: string;
    category_name: string;
    selected: boolean;
    item_count: number;
}

interface SyncStatus {
    id: number;
    subscription_id: number;
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

type SortKey = 'name' | 'id' | 'count';
type SortDirection = 'asc' | 'desc';

interface SortConfig {
    key: SortKey;
    direction: SortDirection;
}

export default function XTVSelection() {
    const toast = useToast();
    const [subscriptions, setSubscriptions] = useState<Subscription[]>([]);
    const [statuses, setStatuses] = useState<SyncStatus[]>([]);
    const [selectedSubId, setSelectedSubId] = useState<number | null>(null);
    const [movieCategories, setMovieCategories] = useState<Category[]>([]);
    const [seriesCategories, setSeriesCategories] = useState<Category[]>([]);
    const [syncingMovies, setSyncingMovies] = useState(false);
    const [syncingSeries, setSyncingSeries] = useState(false);
    const [savingMovies, setSavingMovies] = useState(false);
    const [savingSeries, setSavingSeries] = useState(false);

    const [filterText, setFilterText] = useState('');
    const [movieSort, setMovieSort] = useState<SortConfig>({ key: 'name', direction: 'asc' });
    const [seriesSort, setSeriesSort] = useState<SortConfig>({ key: 'name', direction: 'asc' });

    const [error, setError] = useState<string | null>(null);
    // Set while the user is being asked to confirm a sync that would wipe a type.
    const [wipeConfirm, setWipeConfirm] = useState<'movies' | 'series' | null>(null);
    const [wipeBusy, setWipeBusy] = useState(false);
    // Ticked boxes only exist in React state until Save, so track what differs
    // from what the server last sent us.
    const [savedMovies, setSavedMovies] = useState<Record<string, boolean>>({});
    const [savedSeries, setSavedSeries] = useState<Record<string, boolean>>({});

    const isDirty =
        movieCategories.some(c => savedMovies[c.category_id] !== c.selected) ||
        seriesCategories.some(c => savedSeries[c.category_id] !== c.selected);
    const guard = useUnsavedChanges(isDirty);

    useEffect(() => {
        fetchSubscriptions();
        fetchSyncStatus();
        // 2s rather than 5s: this now drives a progress bar, and a bar that
        // only moves every five seconds reads as stuck. The endpoint is a
        // single small query.
        const interval = setInterval(fetchSyncStatus, 2000);
        return () => clearInterval(interval);
    }, []);

    useEffect(() => {
        if (selectedSubId) {
            fetchMovies();
            fetchSeries();
            setError(null);
        }
    }, [selectedSubId]);

    const fetchSubscriptions = async () => {
        try {
            const res = await api.get<Subscription[]>('/subscriptions/');
            const active = res.data.filter(s => s.is_active);
            setSubscriptions(active);
            // Seed from the active list, not the raw one: an inactive first
            // subscription left the selector blank with an invisible id set.
            if (active.length > 0 && !selectedSubId) {
                setSelectedSubId(active[0].id);
            }
        } catch (error) {
            console.error("Failed to fetch subscriptions", error);
            setError("Failed to fetch subscriptions");
        }
    };

    const fetchSyncStatus = async () => {
        try {
            const res = await api.get<SyncStatus[]>('/sync/status');
            setStatuses(res.data);
        } catch (error) {
            console.error("Failed to fetch sync status", error);
        }
    };

    // What the *server* currently has saved — not the tick boxes, which the sync
    // never sees until Save is pressed.
    const savedSelectionCount = (type: 'movies' | 'series') =>
        Object.values(type === 'movies' ? savedMovies : savedSeries).filter(Boolean).length;

    const runSync = async (subscriptionId: number, type: 'movies' | 'series') => {
        try {
            await api.post(`/sync/${type}/${subscriptionId}`);
            await fetchSyncStatus();
            toast.success(`${type === 'movies' ? 'Movie' : 'Series'} sync started`);
        } catch (error: any) {
            console.error(`Failed to trigger ${type} sync`, error);
            toast.apiError(`Failed to start the ${type} sync`, error);
        }
    };

    const triggerSync = async (subscriptionId: number, type: 'movies' | 'series') => {
        // No category saved means "I want nothing of this type", so the sync
        // deletes everything it previously generated. Far too destructive for a
        // single click on a button labelled "Sync Now".
        if (savedSelectionCount(type) === 0) {
            setWipeConfirm(type);
            return;
        }
        await runSync(subscriptionId, type);
    };

    const confirmWipe = async () => {
        if (!selectedSubId || !wipeConfirm) return;
        setWipeBusy(true);
        try {
            await runSync(selectedSubId, wipeConfirm);
            setWipeConfirm(null);
        } finally {
            setWipeBusy(false);
        }
    };

    const stopSync = async (subscriptionId: number, type: 'movies' | 'series') => {
        try {
            await api.post(`/sync/stop/${subscriptionId}/${type}`);
            await fetchSyncStatus();
        } catch (error) {
            console.error(`Failed to stop ${type} sync`, error);
        }
    };

    const getStatusColor = (status: string) => {
        switch (status) {
            case 'success': return 'text-green-500';
            case 'failed': return 'text-red-500';
            // Some items were written and others were not — never green.
            case 'partial': return 'text-amber-500';
            case 'running': return 'text-blue-500 animate-pulse';
            default: return 'text-muted-foreground';
        }
    };

    const getStatusIcon = (status: string) => {
        switch (status) {
            case 'success': return <CheckCircle2 className="w-5 h-5 text-green-500" />;
            case 'failed': return <AlertCircle className="w-5 h-5 text-red-500" />;
            case 'partial': return <AlertTriangle className="w-5 h-5 text-amber-500" />;
            case 'running': return <RefreshCw className="w-5 h-5 text-blue-500 animate-spin" />;
            default: return <div className="w-5 h-5 rounded-full bg-muted" />;
        }
    };

    const getStatus = (subscriptionId: number, type: string) => {
        return statuses.find(s => s.subscription_id === subscriptionId && s.type === type);
    };

    // Where the run currently in flight has got to. Renders nothing unless this
    // type is actually syncing.
    const renderSyncProgress = (type: 'movies' | 'series') => {
        if (!selectedSubId) return null;
        const status = getStatus(selectedSubId, type);
        return (
            <SyncProgress
                status={status?.status}
                phase={status?.progress_phase}
                done={status?.progress_done}
                total={status?.progress_total}
            />
        );
    };

    // The backend has always recorded why a sync went wrong; nothing ever showed
    // it, which is how a run that wrote nothing at all could still read as done.
    const renderSyncProblem = (type: 'movies' | 'series') => {
        if (!selectedSubId) return null;
        const status = getStatus(selectedSubId, type);
        if (!status?.error_message || status.status === 'running') return null;

        const isFailure = status.status === 'failed';
        return (
            <div
                className={`mt-3 flex gap-2 rounded-md border p-2 text-xs ${
                    isFailure
                        ? 'border-destructive/30 bg-destructive/10 text-destructive'
                        : 'border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400'
                }`}
            >
                <AlertTriangle className="h-4 w-4 flex-shrink-0 mt-0.5" />
                <span className="break-words">{status.error_message}</span>
            </div>
        );
    };

    const fetchMovies = async () => {
        if (!selectedSubId) return;
        try {
            const res = await api.get<Category[]>(`/selection/movies/${selectedSubId}`);
            setMovieCategories(res.data);
            setSavedMovies(Object.fromEntries(res.data.map(c => [c.category_id, c.selected])));
        } catch (error) {
            console.error("Failed to fetch movie categories", error);
            setError("Failed to fetch movie categories");
        }
    };

    const fetchSeries = async () => {
        if (!selectedSubId) return;
        try {
            const res = await api.get<Category[]>(`/selection/series/${selectedSubId}`);
            setSeriesCategories(res.data);
            setSavedSeries(Object.fromEntries(res.data.map(c => [c.category_id, c.selected])));
        } catch (error) {
            console.error("Failed to fetch series categories", error);
            setError("Failed to fetch series categories");
        }
    };

    const syncMovies = async () => {
        if (!selectedSubId) return;
        setSyncingMovies(true);
        setError(null);
        try {
            await api.post(`/selection/movies/sync/${selectedSubId}`);
            await fetchMovies();
        } catch (error: any) {
            console.error("Failed to sync movie categories", error);
            setError(error.response?.data?.detail || "Failed to sync movie categories");
        } finally {
            setSyncingMovies(false);
        }
    };

    const syncSeries = async () => {
        if (!selectedSubId) return;
        setSyncingSeries(true);
        setError(null);
        try {
            await api.post(`/selection/series/sync/${selectedSubId}`);
            await fetchSeries();
        } catch (error: any) {
            console.error("Failed to sync series categories", error);
            setError(error.response?.data?.detail || "Failed to sync series categories");
        } finally {
            setSyncingSeries(false);
        }
    };

    const saveMovies = async () => {
        if (!selectedSubId) return;
        setSavingMovies(true);
        setError(null);
        try {
            const selected = movieCategories.filter(c => c.selected);
            await api.post(`/selection/movies/${selectedSubId}`, { categories: selected });
            setSavedMovies(Object.fromEntries(movieCategories.map(c => [c.category_id, c.selected])));
            toast.success('Movie selection saved', `${selected.length} categor${selected.length === 1 ? 'y' : 'ies'} selected.`);
        } catch (error: any) {
            console.error("Failed to save movie selection", error);
            setError(error.response?.data?.detail || "Failed to save movie selection");
            toast.apiError('Failed to save movie selection', error);
        } finally {
            setSavingMovies(false);
        }
    };

    const saveSeries = async () => {
        if (!selectedSubId) return;
        setSavingSeries(true);
        setError(null);
        try {
            const selected = seriesCategories.filter(c => c.selected);
            await api.post(`/selection/series/${selectedSubId}`, { categories: selected });
            setSavedSeries(Object.fromEntries(seriesCategories.map(c => [c.category_id, c.selected])));
            toast.success('Series selection saved', `${selected.length} categor${selected.length === 1 ? 'y' : 'ies'} selected.`);
        } catch (error: any) {
            console.error("Failed to save series selection", error);
            setError(error.response?.data?.detail || "Failed to save series selection");
            toast.apiError('Failed to save series selection', error);
        } finally {
            setSavingSeries(false);
        }
    };

    const toggleMovie = (id: string) => {
        setMovieCategories(prev => prev.map(c =>
            c.category_id === id ? { ...c, selected: !c.selected } : c
        ));
    };

    const toggleSeries = (id: string) => {
        setSeriesCategories(prev => prev.map(c =>
            c.category_id === id ? { ...c, selected: !c.selected } : c
        ));
    };

    const toggleAllMovies = () => {
        const allSelected = filteredAndSortedMovies.every(c => c.selected);
        const visibleIds = new Set(filteredAndSortedMovies.map(c => c.category_id));

        setMovieCategories(prev => prev.map(c =>
            visibleIds.has(c.category_id) ? { ...c, selected: !allSelected } : c
        ));
    };

    const toggleAllSeries = () => {
        const allSelected = filteredAndSortedSeries.every(c => c.selected);
        const visibleIds = new Set(filteredAndSortedSeries.map(c => c.category_id));

        setSeriesCategories(prev => prev.map(c =>
            visibleIds.has(c.category_id) ? { ...c, selected: !allSelected } : c
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

    const filterAndSort = (categories: Category[], sortConfig: SortConfig) => {
        let result = [...categories];

        if (filterText) {
            const lowerFilter = filterText.toLowerCase();
            result = result.filter(c =>
                c.category_name.toLowerCase().includes(lowerFilter) ||
                c.category_id.includes(filterText)
            );
        }

        result.sort((a, b) => {
            let aValue: any = a.category_name;
            let bValue: any = b.category_name;

            if (sortConfig.key === 'id') {
                aValue = parseInt(a.category_id) || a.category_id;
                bValue = parseInt(b.category_id) || b.category_id;
            } else if (sortConfig.key === 'count') {
                aValue = a.item_count;
                bValue = b.item_count;
            }

            if (aValue < bValue) return sortConfig.direction === 'asc' ? -1 : 1;
            if (aValue > bValue) return sortConfig.direction === 'asc' ? 1 : -1;
            return 0;
        });

        return result;
    };

    const filteredAndSortedMovies = filterAndSort(movieCategories, movieSort);
    const filteredAndSortedSeries = filterAndSort(seriesCategories, seriesSort);

    const renderSortIcon = (config: SortConfig, key: SortKey) => {
        if (config.key !== key) return null;
        return config.direction === 'asc' ? ' ↑' : ' ↓';
    };

    return (
        <div className="space-y-8 h-full flex flex-col">
            <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                    <h2 className="text-3xl font-bold tracking-tight">Bouquet Selection</h2>
                    <p className="text-muted-foreground">Choose which categories to synchronize.</p>
                </div>
                {isDirty && (
                    <div className="flex items-center gap-2 px-3 py-1.5 rounded-md border border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400 text-xs font-medium">
                        <AlertCircle className="h-4 w-4" />
                        Unsaved changes — press Save in each column to keep them
                    </div>
                )}
            </div>

            {/* Subscription Selector */}
            <div className="flex gap-2 items-center">
                <label className="text-sm font-medium">Subscription:</label>
                <select
                    value={selectedSubId || ''}
                    onChange={(e) => {
                        const next = Number(e.target.value);
                        guard.run(() => setSelectedSubId(next));
                    }}
                    className="border rounded-md px-3 py-2 text-sm min-w-[200px] bg-background"
                >
                    {subscriptions.map(sub => (
                        <option key={sub.id} value={sub.id}>{sub.name}</option>
                    ))}
                </select>
            </div>

            {/* Synchronization Status Block */}
            {selectedSubId && (
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
                                    {getStatusIcon(getStatus(selectedSubId, 'movies')?.status || 'idle')}
                                </div>
                                <div className="space-y-2 text-sm">
                                    <div className="flex justify-between">
                                        <span className="text-muted-foreground">Status:</span>
                                        <span className={`font-medium capitalize ${getStatusColor(getStatus(selectedSubId, 'movies')?.status || 'idle')}`}>
                                            {getStatus(selectedSubId, 'movies')?.status || 'Idle'}
                                        </span>
                                    </div>
                                    {getStatus(selectedSubId, 'movies')?.last_sync && (
                                        <div className="flex justify-between">
                                            <span className="text-muted-foreground">Last Sync:</span>
                                            <span>{formatDateTime(getStatus(selectedSubId, 'movies')?.last_sync)}</span>
                                        </div>
                                    )}
                                    {getStatus(selectedSubId, 'movies')?.items_added !== undefined && (
                                        <div className="flex justify-between">
                                            <span className="text-muted-foreground">Added:</span>
                                            <span className="font-medium text-green-600">{getStatus(selectedSubId, 'movies')?.items_added || 0}</span>
                                        </div>
                                    )}
                                    {getStatus(selectedSubId, 'movies')?.items_deleted !== undefined && (
                                        <div className="flex justify-between">
                                            <span className="text-muted-foreground">Deleted:</span>
                                            <span className="font-medium text-red-600">{getStatus(selectedSubId, 'movies')?.items_deleted || 0}</span>
                                        </div>
                                    )}
                                </div>
                                {renderSyncProgress('movies')}
                                {renderSyncProblem('movies')}
                                <div className="mt-4">
                                    {getStatus(selectedSubId, 'movies')?.status === 'running' ? (
                                        <Button
                                            onClick={() => stopSync(selectedSubId, 'movies')}
                                            variant="destructive"
                                            size="sm"
                                            className="w-full"
                                        >
                                            <StopCircle className="w-4 h-4 mr-2" />
                                            Stop Sync
                                        </Button>
                                    ) : (
                                        <Button
                                            onClick={() => triggerSync(selectedSubId, 'movies')}
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
                                    {getStatusIcon(getStatus(selectedSubId, 'series')?.status || 'idle')}
                                </div>
                                <div className="space-y-2 text-sm">
                                    <div className="flex justify-between">
                                        <span className="text-muted-foreground">Status:</span>
                                        <span className={`font-medium capitalize ${getStatusColor(getStatus(selectedSubId, 'series')?.status || 'idle')}`}>
                                            {getStatus(selectedSubId, 'series')?.status || 'Idle'}
                                        </span>
                                    </div>
                                    {getStatus(selectedSubId, 'series')?.last_sync && (
                                        <div className="flex justify-between">
                                            <span className="text-muted-foreground">Last Sync:</span>
                                            <span>{formatDateTime(getStatus(selectedSubId, 'series')?.last_sync)}</span>
                                        </div>
                                    )}
                                    {getStatus(selectedSubId, 'series')?.items_added !== undefined && (
                                        <div className="flex justify-between">
                                            <span className="text-muted-foreground">Added:</span>
                                            <span className="font-medium text-green-600">{getStatus(selectedSubId, 'series')?.items_added || 0}</span>
                                        </div>
                                    )}
                                    {getStatus(selectedSubId, 'series')?.items_deleted !== undefined && (
                                        <div className="flex justify-between">
                                            <span className="text-muted-foreground">Deleted:</span>
                                            <span className="font-medium text-red-600">{getStatus(selectedSubId, 'series')?.items_deleted || 0}</span>
                                        </div>
                                    )}
                                </div>
                                {renderSyncProgress('series')}
                                {renderSyncProblem('series')}
                                <div className="mt-4">
                                    {getStatus(selectedSubId, 'series')?.status === 'running' ? (
                                        <Button
                                            onClick={() => stopSync(selectedSubId, 'series')}
                                            variant="destructive"
                                            size="sm"
                                            className="w-full"
                                        >
                                            <StopCircle className="w-4 h-4 mr-2" />
                                            Stop Sync
                                        </Button>
                                    ) : (
                                        <Button
                                            onClick={() => triggerSync(selectedSubId, 'series')}
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
            )}

            {/* Error Display */}
            {error && (
                <div className="bg-destructive/15 text-destructive px-4 py-3 rounded-md text-sm">
                    {error}
                </div>
            )}

            {/* Filter Input - Just before Movies/Series blocks */}
            {selectedSubId && (
                <div className="w-full md:w-64">
                    <input
                        type="text"
                        placeholder="Filter categories..."
                        value={filterText}
                        onChange={(e) => setFilterText(e.target.value)}
                        className="w-full border rounded-md px-3 py-2 text-sm"
                    />
                </div>
            )}

            {!selectedSubId ? (
                <Card>
                    <CardContent className="p-8 text-center text-muted-foreground">
                        No active subscriptions. Go to Configuration to add subscriptions.
                    </CardContent>
                </Card>
            ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6 flex-1 min-h-0">
                    {/* Movies Column (Left) */}
                    <Card className="flex flex-col h-full">
                        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                            <CardTitle>Movies Categories ({filteredAndSortedMovies.length})</CardTitle>
                            <div className="flex gap-2">
                                <Button size="sm" variant="outline" onClick={syncMovies} disabled={syncingMovies}>
                                    <RefreshCw className={`w-4 h-4 mr-2 ${syncingMovies ? 'animate-spin' : ''}`} />
                                    Get from source
                                </Button>
                                <Button size="sm" onClick={saveMovies} disabled={savingMovies || movieCategories.length === 0}>
                                    <Save className="w-4 h-4 mr-2" />
                                    Save
                                </Button>
                            </div>
                        </CardHeader>
                        <CardContent className="flex-1 overflow-auto min-h-[400px]">
                            {movieCategories.length > 0 ? (
                                <div className="border rounded-md">
                                    <table className="w-full text-sm text-left">
                                        <thead className="bg-muted/50 text-muted-foreground sticky top-0">
                                            <tr>
                                                <th className="p-3 w-10">
                                                    <button onClick={toggleAllMovies}>
                                                        {filteredAndSortedMovies.length > 0 && filteredAndSortedMovies.every(c => c.selected) ?
                                                            <CheckSquare className="w-4 h-4" /> :
                                                            <Square className="w-4 h-4" />
                                                        }
                                                    </button>
                                                </th>
                                                <th className="p-3 cursor-pointer hover:bg-muted" onClick={() => handleSort('movie', 'name')}>
                                                    Category Name {renderSortIcon(movieSort, 'name')}
                                                </th>
                                                <th className="p-3 w-20 cursor-pointer hover:bg-muted" onClick={() => handleSort('movie', 'count')}>
                                                    Count {renderSortIcon(movieSort, 'count')}
                                                </th>
                                                <th className="p-3 w-20 cursor-pointer hover:bg-muted" onClick={() => handleSort('movie', 'id')}>
                                                    ID {renderSortIcon(movieSort, 'id')}
                                                </th>
                                            </tr>
                                        </thead>
                                        <tbody className="divide-y">
                                            {filteredAndSortedMovies.map(cat => (
                                                <tr key={cat.category_id} className="hover:bg-muted/50 transition-colors">
                                                    <td className="p-3">
                                                        <button onClick={() => toggleMovie(cat.category_id)}>
                                                            {cat.selected ?
                                                                <CheckSquare className="w-4 h-4 text-primary" /> :
                                                                <Square className="w-4 h-4 text-muted-foreground" />
                                                            }
                                                        </button>
                                                    </td>
                                                    <td className="p-3 font-medium cursor-pointer" onClick={() => toggleMovie(cat.category_id)}>
                                                        {cat.category_name}
                                                    </td>
                                                    <td className="p-3 text-muted-foreground">{cat.item_count}</td>
                                                    <td className="p-3 text-muted-foreground text-xs">{cat.category_id}</td>
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

                    {/* Series Column (Right) */}
                    <Card className="flex flex-col h-full">
                        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                            <CardTitle>Series Categories ({filteredAndSortedSeries.length})</CardTitle>
                            <div className="flex gap-2">
                                <Button size="sm" variant="outline" onClick={syncSeries} disabled={syncingSeries}>
                                    <RefreshCw className={`w-4 h-4 mr-2 ${syncingSeries ? 'animate-spin' : ''}`} />
                                    Get from source
                                </Button>
                                <Button size="sm" onClick={saveSeries} disabled={savingSeries || seriesCategories.length === 0}>
                                    <Save className="w-4 h-4 mr-2" />
                                    Save
                                </Button>
                            </div>
                        </CardHeader>
                        <CardContent className="flex-1 overflow-auto min-h-[400px]">
                            {seriesCategories.length > 0 ? (
                                <div className="border rounded-md">
                                    <table className="w-full text-sm text-left">
                                        <thead className="bg-muted/50 text-muted-foreground sticky top-0">
                                            <tr>
                                                <th className="p-3 w-10">
                                                    <button onClick={toggleAllSeries}>
                                                        {filteredAndSortedSeries.length > 0 && filteredAndSortedSeries.every(c => c.selected) ?
                                                            <CheckSquare className="w-4 h-4" /> :
                                                            <Square className="w-4 h-4" />
                                                        }
                                                    </button>
                                                </th>
                                                <th className="p-3 cursor-pointer hover:bg-muted" onClick={() => handleSort('series', 'name')}>
                                                    Category Name {renderSortIcon(seriesSort, 'name')}
                                                </th>
                                                <th className="p-3 w-20 cursor-pointer hover:bg-muted" onClick={() => handleSort('series', 'count')}>
                                                    Count {renderSortIcon(seriesSort, 'count')}
                                                </th>
                                                <th className="p-3 w-20 cursor-pointer hover:bg-muted" onClick={() => handleSort('series', 'id')}>
                                                    ID {renderSortIcon(seriesSort, 'id')}
                                                </th>
                                            </tr>
                                        </thead>
                                        <tbody className="divide-y">
                                            {filteredAndSortedSeries.map(cat => (
                                                <tr key={cat.category_id} className="hover:bg-muted/50 transition-colors">
                                                    <td className="p-3">
                                                        <button onClick={() => toggleSeries(cat.category_id)}>
                                                            {cat.selected ?
                                                                <CheckSquare className="w-4 h-4 text-primary" /> :
                                                                <Square className="w-4 h-4 text-muted-foreground" />
                                                            }
                                                        </button>
                                                    </td>
                                                    <td className="p-3 font-medium cursor-pointer" onClick={() => toggleSeries(cat.category_id)}>
                                                        {cat.category_name}
                                                    </td>
                                                    <td className="p-3 text-muted-foreground">{cat.item_count}</td>
                                                    <td className="p-3 text-muted-foreground text-xs">{cat.category_id}</td>
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
            )}

            <ConfirmDialog
                isOpen={guard.isPrompting}
                onClose={guard.cancel}
                onConfirm={guard.proceed}
                title="Discard unsaved selection?"
                variant="destructive"
                confirmLabel="Discard and switch"
            >
                <p>You changed the category selection without saving it.</p>
                <p className="text-muted-foreground">
                    Switching subscription reloads the categories and those changes will be lost.
                </p>
            </ConfirmDialog>

            <ConfirmDialog
                isOpen={wipeConfirm !== null}
                onClose={() => setWipeConfirm(null)}
                onConfirm={confirmWipe}
                title={`Delete every ${wipeConfirm === 'series' ? 'series' : 'movie'} file?`}
                variant="destructive"
                confirmLabel="Delete everything"
                requireTyped="DELETE"
                busy={wipeBusy}
            >
                <p>
                    No {wipeConfirm === 'series' ? 'series' : 'movie'} category is selected for{' '}
                    <span className="font-medium">
                        {subscriptions.find(s => s.id === selectedSubId)?.name ?? 'this subscription'}
                    </span>
                    , so this sync will keep nothing.
                </p>
                <p>
                    It will delete every <span className="font-mono">.strm</span> and{' '}
                    <span className="font-mono">.nfo</span> it generated for this type, and their
                    folders. Files it did not generate are left alone.
                </p>
                {isDirty && (
                    <p className="text-amber-600 dark:text-amber-400">
                        You have unsaved tick boxes. The sync reads the <em>saved</em> selection, not
                        what is on screen — cancel and press Save first if you meant to keep some
                        categories.
                    </p>
                )}
            </ConfirmDialog>
        </div>
    );
}
