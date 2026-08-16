import { useState, useEffect, useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Trash2, AlertTriangle, Database, Settings, Clock, Zap, Film, Tv, Gauge, FlaskConical } from 'lucide-react';
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { useToast } from '@/contexts/ToastContext';
import api from '@/lib/api';

const DEFAULT_PREFIX_REGEX = '^(?:[A-Za-z0-9.-]+_|[A-Za-z]{2,}\\s*-\\s*)';

type DangerAction = 'deleteFiles' | 'resetDb' | 'resetAll' | 'clearMovieCache' | 'clearSeriesCache';

// Mirrors FileManager.clean_title on the backend so the preview shows what the
// sync will actually produce rather than a guess.
function previewCleanTitle(title: string, prefixRegex: string, formatDate: boolean, cleanName: boolean): string {
    if (!title) return '';
    let out = title;
    try {
        out = out.replace(new RegExp(prefixRegex), '');
    } catch {
        return '⚠ invalid regex';
    }
    if (formatDate) out = out.replace(/[_\s](\d{4})$/, ' ($1)');
    if (cleanName) out = out.replace(/_/g, ' ');
    return out.trim();
}

export default function Administration() {
    const toast = useToast();
    const [loading, setLoading] = useState(false);

    // Title formatting
    const [prefixRegex, setPrefixRegex] = useState('');
    const [formatDate, setFormatDate] = useState(false);
    const [cleanName, setCleanName] = useState(false);
    const [sampleTitle, setSampleTitle] = useState('FR - Le Grand Bleu_1988');

    // Movies / Series layout
    const [useMovieCategoryFolders, setUseMovieCategoryFolders] = useState(true);
    const [useSeasonFolders, setUseSeasonFolders] = useState(true);
    const [useCategoryFolders, setUseCategoryFolders] = useState(true);
    const [includeSeriesName, setIncludeSeriesName] = useState(false);

    // Performance
    const [parallelismMovies, setParallelismMovies] = useState(10);
    const [parallelismSeries, setParallelismSeries] = useState(5);

    // Per-section busy flag, so one Save does not grey out the whole page
    const [savingSection, setSavingSection] = useState<string | null>(null);

    // Download orchestration (the single home for these settings)
    const [downloadMode, setDownloadMode] = useState('parallel');
    const [globalSpeedLimit, setGlobalSpeedLimit] = useState(0);
    const [quietHoursEnabled, setQuietHoursEnabled] = useState(true);
    const [quietHoursStart, setQuietHoursStart] = useState('00:00');
    const [quietHoursEnd, setQuietHoursEnd] = useState('08:00');
    const [pauseDuringQuietHours, setPauseDuringQuietHours] = useState(true);
    const [defaultMaxRetries, setDefaultMaxRetries] = useState(3);
    const [maxRedirects, setMaxRedirects] = useState(10);
    const [connectionTimeout, setConnectionTimeout] = useState(30);

    const [dangerAction, setDangerAction] = useState<DangerAction | null>(null);

    useEffect(() => {
        const loadSettings = async () => {
            try {
                const response = await api.get('/config');
                setPrefixRegex(response.data.PREFIX_REGEX || DEFAULT_PREFIX_REGEX);
                setFormatDate(response.data.FORMAT_DATE_IN_TITLE === true);
                setCleanName(response.data.CLEAN_NAME === true);
                setUseSeasonFolders(response.data.SERIES_USE_SEASON_FOLDERS !== false);
                setIncludeSeriesName(response.data.SERIES_INCLUDE_NAME_IN_FILENAME === true);
                setParallelismMovies(parseInt(response.data.SYNC_PARALLELISM_MOVIES) || 10);
                setParallelismSeries(parseInt(response.data.SYNC_PARALLELISM_SERIES) || 5);
                setUseCategoryFolders(response.data.SERIES_USE_CATEGORY_FOLDERS !== false);
                setUseMovieCategoryFolders(response.data.MOVIE_USE_CATEGORY_FOLDERS !== false);
            } catch (error) {
                console.error('Failed to load settings', error);
                toast.apiError('Could not load settings', error);
            }

            try {
                const dlRes = await api.get('/config/downloads');
                setDownloadMode(dlRes.data.download_mode || 'parallel');
                setGlobalSpeedLimit(dlRes.data.global_speed_limit_kbps || 0);
                setQuietHoursEnabled(dlRes.data.quiet_hours_enabled);
                setQuietHoursStart(dlRes.data.quiet_hours_start || '00:00');
                setQuietHoursEnd(dlRes.data.quiet_hours_end || '08:00');
                setPauseDuringQuietHours(dlRes.data.pause_during_quiet_hours);
                setDefaultMaxRetries(dlRes.data.default_max_retries ?? 3);
                setMaxRedirects(dlRes.data.max_redirects || 10);
                setConnectionTimeout(dlRes.data.connection_timeout_seconds || 30);
            } catch (error) {
                console.error('Failed to load download settings', error);
                toast.apiError('Could not load download settings', error);
            }
        };
        loadSettings();
        // Settings load once on mount.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    /**
     * Saves one section only. The config endpoint ignores fields it is not
     * given, so each button now persists exactly what its own card shows —
     * every button used to post the whole page, silently committing edits the
     * user had made elsewhere and abandoned.
     */
    const saveSection = async (section: string, label: string, payload: Record<string, unknown>) => {
        setSavingSection(section);
        try {
            await api.post('/config', payload);
            toast.success(`${label} saved`);
        } catch (error) {
            console.error(`Failed to save ${label}`, error);
            toast.apiError(`Failed to save ${label}`, error);
        } finally {
            setSavingSection(null);
        }
    };

    const saveTitleFormatting = () => saveSection('title', 'Title formatting', {
        PREFIX_REGEX: prefixRegex,
        FORMAT_DATE_IN_TITLE: formatDate,
        CLEAN_NAME: cleanName,
    });

    const saveMoviesFormatting = () => saveSection('movies', 'Movies layout', {
        MOVIE_USE_CATEGORY_FOLDERS: useMovieCategoryFolders,
    });

    const saveSeriesFormatting = () => saveSection('series', 'Series layout', {
        SERIES_USE_SEASON_FOLDERS: useSeasonFolders,
        SERIES_USE_CATEGORY_FOLDERS: useCategoryFolders,
        SERIES_INCLUDE_NAME_IN_FILENAME: includeSeriesName,
    });

    const savePerformance = () => saveSection('performance', 'Performance settings', {
        SYNC_PARALLELISM_MOVIES: parallelismMovies,
        SYNC_PARALLELISM_SERIES: parallelismSeries,
    });

    const saveDownloadSettings = async () => {
        setSavingSection('downloads');
        try {
            await api.post('/config/downloads', {
                download_mode: downloadMode,
                global_speed_limit_kbps: globalSpeedLimit,
                quiet_hours_enabled: quietHoursEnabled,
                quiet_hours_start: quietHoursStart,
                quiet_hours_end: quietHoursEnd,
                pause_during_quiet_hours: pauseDuringQuietHours,
                default_max_retries: defaultMaxRetries,
                max_redirects: maxRedirects,
                connection_timeout_seconds: connectionTimeout,
            });
            toast.success('Download settings saved');
        } catch (error) {
            console.error('Failed to save download settings', error);
            toast.apiError('Failed to save download settings', error);
        } finally {
            setSavingSection(null);
        }
    };

    const titlePreview = useMemo(
        () => previewCleanTitle(sampleTitle, prefixRegex || DEFAULT_PREFIX_REGEX, formatDate, cleanName),
        [sampleTitle, prefixRegex, formatDate, cleanName]
    );

    const DANGER_CONFIG: Record<DangerAction, {
        title: string;
        endpoint: string;
        confirmLabel: string;
        requireTyped?: string;
        body: JSX.Element;
        success: string;
    }> = {
        deleteFiles: {
            title: 'Delete Generated Files',
            endpoint: '/admin/delete-files',
            confirmLabel: 'Delete all files',
            requireTyped: 'DELETE',
            body: (
                <>
                    <p>This deletes <strong>every generated .strm and .nfo file</strong> from your movies and series directories.</p>
                    <p className="text-muted-foreground">The database is untouched, but the files have to be regenerated by a full sync.</p>
                </>
            ),
            success: 'All generated files deleted.',
        },
        resetDb: {
            title: 'Reset Database',
            endpoint: '/admin/reset-database',
            confirmLabel: 'Reset the database',
            requireTyped: 'RESET',
            body: (
                <>
                    <p>This erases <strong>all database content</strong>: subscriptions, selections, schedules, monitoring and download history.</p>
                    <p className="text-muted-foreground">Generated files stay on disk. This cannot be undone.</p>
                </>
            ),
            success: 'Database reset.',
        },
        resetAll: {
            title: 'Reset Everything',
            endpoint: '/admin/reset-all',
            confirmLabel: 'Wipe everything',
            requireTyped: 'YES',
            body: (
                <>
                    <p className="font-bold text-destructive">This deletes all generated files AND resets the database.</p>
                    <p className="text-muted-foreground">The system returns to a blank install. This cannot be undone.</p>
                </>
            ),
            success: 'All data reset.',
        },
        clearMovieCache: {
            title: 'Clear Movie Cache',
            endpoint: '/admin/clear-movie-cache',
            confirmLabel: 'Clear cache',
            body: <p>Movie metadata will be re-fetched on the next sync. No files are deleted.</p>,
            success: 'Movie cache cleared.',
        },
        clearSeriesCache: {
            title: 'Clear Series Cache',
            endpoint: '/admin/clear-series-cache',
            confirmLabel: 'Clear cache',
            body: <p>Series and episode metadata will be re-fetched on the next sync. No files are deleted.</p>,
            success: 'Series cache cleared.',
        },
    };

    const runDangerAction = async () => {
        if (!dangerAction) return;
        const config = DANGER_CONFIG[dangerAction];
        setLoading(true);
        try {
            await api.post(config.endpoint);
            toast.success(config.title, config.success);
        } catch (error) {
            console.error(`Failed to execute ${dangerAction}`, error);
            toast.apiError(`${config.title} failed`, error);
        } finally {
            setLoading(false);
            setDangerAction(null);
        }
    };

    const activeDanger = dangerAction ? DANGER_CONFIG[dangerAction] : null;

    return (
        <div className="space-y-10">
            <div>
                <h2 className="text-3xl font-bold tracking-tight">Administration</h2>
                <p className="text-muted-foreground">Manage system settings and data.</p>
            </div>

            {/* ---------- Download Orchestration ---------- */}
            <section className="space-y-4">
                <h3 className="text-xl font-semibold">Downloads</h3>
                <Card className="border-indigo-200 dark:border-indigo-900">
                    <CardHeader>
                        <CardTitle className="flex items-center gap-2 text-indigo-700 dark:text-indigo-400">
                            <Zap className="w-5 h-5" />
                            Download Orchestration
                        </CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-6">
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                            <div className="space-y-4">
                                <div className="space-y-2">
                                    <Label>Download Mode</Label>
                                    <select
                                        value={downloadMode}
                                        onChange={(e) => setDownloadMode(e.target.value)}
                                        className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                                    >
                                        <option value="parallel">Parallel (Recommended)</option>
                                        <option value="sequential">Sequential (One by one)</option>
                                    </select>
                                    <p className="text-xs text-muted-foreground">
                                        Parallel downloads several files at once, within each subscription's limit. Sequential forces one global download at a time.
                                    </p>
                                </div>

                                <div className="space-y-2">
                                    <Label>Global Speed Limit (KB/s)</Label>
                                    <Input
                                        type="number"
                                        min="0"
                                        value={globalSpeedLimit}
                                        onChange={(e) => setGlobalSpeedLimit(Math.max(0, parseInt(e.target.value) || 0))}
                                        placeholder="0 (Unlimited)"
                                    />
                                    <p className="text-xs text-muted-foreground">0 means unlimited. 1024 KB/s = 1 MB/s.</p>
                                </div>

                                <div className="space-y-2">
                                    <Label>Default Max Retries</Label>
                                    <Input
                                        type="number"
                                        min="0"
                                        max="20"
                                        value={defaultMaxRetries}
                                        onChange={(e) => setDefaultMaxRetries(Math.max(0, parseInt(e.target.value) || 0))}
                                    />
                                    <p className="text-xs text-muted-foreground">How many times a failed download retries on its own.</p>
                                </div>
                            </div>

                            <div className="space-y-4 md:border-l md:pl-6">
                                <div className="flex items-center space-x-2">
                                    <Switch
                                        id="quiet-mode"
                                        checked={quietHoursEnabled}
                                        onCheckedChange={setQuietHoursEnabled}
                                    />
                                    <Label htmlFor="quiet-mode" className="flex items-center gap-2">
                                        <Clock className="w-4 h-4" /> Quiet Hours
                                    </Label>
                                </div>

                                <div className="grid grid-cols-2 gap-4">
                                    <div className="space-y-2">
                                        <Label>Start Time</Label>
                                        <Input
                                            type="time"
                                            value={quietHoursStart}
                                            onChange={(e) => setQuietHoursStart(e.target.value)}
                                            disabled={!quietHoursEnabled}
                                        />
                                    </div>
                                    <div className="space-y-2">
                                        <Label>End Time</Label>
                                        <Input
                                            type="time"
                                            value={quietHoursEnd}
                                            onChange={(e) => setQuietHoursEnd(e.target.value)}
                                            disabled={!quietHoursEnabled}
                                        />
                                    </div>
                                </div>

                                <div className="flex items-center justify-between gap-4">
                                    <div className="space-y-0.5">
                                        <Label htmlFor="pause-during">Pause outside quiet hours</Label>
                                        <p className="text-[11px] text-muted-foreground">
                                            Suspend active downloads instead of only throttling them.
                                        </p>
                                    </div>
                                    <Switch
                                        id="pause-during"
                                        checked={pauseDuringQuietHours}
                                        onCheckedChange={setPauseDuringQuietHours}
                                        disabled={!quietHoursEnabled}
                                    />
                                </div>
                            </div>
                        </div>

                        <div className="border-t pt-6">
                            <h4 className="text-sm font-semibold mb-4">Connection Settings</h4>
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                <div className="space-y-2">
                                    <Label>Max Redirects</Label>
                                    <Input
                                        type="number"
                                        value={maxRedirects}
                                        onChange={(e) => setMaxRedirects(parseInt(e.target.value) || 10)}
                                        min="1"
                                        max="50"
                                    />
                                    <p className="text-xs text-muted-foreground">Maximum HTTP redirects to follow.</p>
                                </div>
                                <div className="space-y-2">
                                    <Label>Connection Timeout (seconds)</Label>
                                    <Input
                                        type="number"
                                        value={connectionTimeout}
                                        onChange={(e) => setConnectionTimeout(parseInt(e.target.value) || 30)}
                                        min="5"
                                        max="300"
                                    />
                                    <p className="text-xs text-muted-foreground">Timeout when connecting to download servers.</p>
                                </div>
                            </div>
                        </div>

                        <Button
                            onClick={saveDownloadSettings}
                            disabled={savingSection === 'downloads'}
                            className="w-full bg-indigo-600 hover:bg-indigo-700"
                        >
                            <Zap className="w-4 h-4 mr-2" />
                            {savingSection === 'downloads' ? 'Saving…' : 'Save Download Settings'}
                        </Button>
                    </CardContent>
                </Card>
            </section>

            {/* ---------- Naming & Layout ---------- */}
            <section className="space-y-4">
                <h3 className="text-xl font-semibold">Naming &amp; Folder Layout</h3>

                <Card className="border-blue-200 dark:border-blue-900">
                    <CardHeader>
                        <CardTitle className="flex items-center gap-2 text-blue-700 dark:text-blue-400">
                            <Settings className="w-5 h-5" />
                            Title Formatting
                        </CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-6">
                        <div className="space-y-2">
                            <Label>Title Prefix Regex</Label>
                            <p className="text-sm text-muted-foreground">
                                Pattern stripped from the start of every title, to remove language or country prefixes.
                            </p>
                            <Input
                                type="text"
                                value={prefixRegex}
                                onChange={(e) => setPrefixRegex(e.target.value)}
                                placeholder={DEFAULT_PREFIX_REGEX}
                                className="font-mono"
                            />
                            <button
                                type="button"
                                className="text-xs text-primary hover:underline"
                                onClick={() => setPrefixRegex(DEFAULT_PREFIX_REGEX)}
                            >
                                Reset to default
                            </button>
                        </div>

                        {/* Lets a pattern be checked here instead of by running a
                            full sync and inspecting the output folder. */}
                        <div className="space-y-2 p-3 rounded-md border bg-muted/30">
                            <Label className="flex items-center gap-2 text-xs uppercase tracking-wider">
                                <FlaskConical className="w-3.5 h-3.5" /> Live preview
                            </Label>
                            <Input
                                value={sampleTitle}
                                onChange={(e) => setSampleTitle(e.target.value)}
                                placeholder="Paste a real title here"
                                className="font-mono text-sm"
                            />
                            <div className="flex items-center gap-2 text-sm flex-wrap">
                                <span className="text-muted-foreground">Result:</span>
                                <code className={`px-2 py-1 rounded font-mono ${titlePreview.startsWith('⚠')
                                    ? 'bg-destructive/10 text-destructive'
                                    : 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'}`}>
                                    {titlePreview || '(empty)'}
                                </code>
                            </div>
                        </div>

                        <div className="space-y-4 pt-2 border-t">
                            <CheckboxRow
                                id="formatDate"
                                checked={formatDate}
                                onChange={setFormatDate}
                                label="Format date at end of name"
                                hint='If a name ends with a year ("Name_2024"), rewrite it as "Name (2024)".'
                            />
                            <CheckboxRow
                                id="cleanName"
                                checked={cleanName}
                                onChange={setCleanName}
                                label="Clean name"
                                hint='Replace every remaining underscore "_" with a space.'
                            />
                        </div>

                        <Button className="w-full" onClick={saveTitleFormatting} disabled={savingSection === 'title'}>
                            <Settings className="w-4 h-4 mr-2" />
                            {savingSection === 'title' ? 'Saving…' : 'Save Title Formatting'}
                        </Button>
                    </CardContent>
                </Card>

                <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                    <Card className="border-orange-200 dark:border-orange-900">
                        <CardHeader>
                            <CardTitle className="flex items-center gap-2 text-orange-700 dark:text-orange-400">
                                <Film className="w-5 h-5" />
                                Movies Layout
                            </CardTitle>
                        </CardHeader>
                        <CardContent className="space-y-6">
                            <CheckboxRow
                                id="useMovieCategoryFolders"
                                checked={useMovieCategoryFolders}
                                onChange={setUseMovieCategoryFolders}
                                label="Use category folders"
                                hint="Group movies by category (/movies/Action/Name). Disable for a flat structure."
                            />
                            <Button
                                className="w-full bg-orange-600 hover:bg-orange-700"
                                onClick={saveMoviesFormatting}
                                disabled={savingSection === 'movies'}
                            >
                                {savingSection === 'movies' ? 'Saving…' : 'Save Movies Layout'}
                            </Button>
                        </CardContent>
                    </Card>

                    <Card className="border-purple-200 dark:border-purple-900">
                        <CardHeader>
                            <CardTitle className="flex items-center gap-2 text-purple-700 dark:text-purple-400">
                                <Tv className="w-5 h-5" />
                                Series Layout
                            </CardTitle>
                        </CardHeader>
                        <CardContent className="space-y-6">
                            <CheckboxRow
                                id="useSeasonFolders"
                                checked={useSeasonFolders}
                                onChange={setUseSeasonFolders}
                                label="Use season folders"
                                hint='Group episodes into "Season XX" subfolders.'
                            />
                            <CheckboxRow
                                id="useCategoryFolders"
                                checked={useCategoryFolders}
                                onChange={setUseCategoryFolders}
                                label="Use category folders"
                                hint="Group series by category. Disable for a flat, Jellyfin-friendly structure."
                            />
                            <CheckboxRow
                                id="includeSeriesName"
                                checked={includeSeriesName}
                                onChange={setIncludeSeriesName}
                                label="Include series name in filename"
                                hint='Produces "Series - S01E01 - Title.strm".'
                            />
                            <Button
                                className="w-full bg-purple-600 hover:bg-purple-700"
                                onClick={saveSeriesFormatting}
                                disabled={savingSection === 'series'}
                            >
                                {savingSection === 'series' ? 'Saving…' : 'Save Series Layout'}
                            </Button>
                        </CardContent>
                    </Card>
                </div>
            </section>

            {/* ---------- Performance ---------- */}
            <section className="space-y-4">
                <h3 className="text-xl font-semibold">Sync Performance</h3>
                <Card className="border-cyan-200 dark:border-cyan-900">
                    <CardHeader>
                        <CardTitle className="flex items-center gap-2 text-cyan-700 dark:text-cyan-400">
                            <Gauge className="w-5 h-5" />
                            Parallelism
                        </CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-6">
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                            <div className="space-y-2">
                                <Label>Movies sync parallelism</Label>
                                <Input
                                    type="number"
                                    min="1"
                                    max="50"
                                    value={parallelismMovies}
                                    onChange={(e) => setParallelismMovies(parseInt(e.target.value) || 10)}
                                />
                                <p className="text-xs text-muted-foreground">Default: 10. Higher values need more RAM and CPU.</p>
                            </div>
                            <div className="space-y-2">
                                <Label>Series sync parallelism</Label>
                                <Input
                                    type="number"
                                    min="1"
                                    max="20"
                                    value={parallelismSeries}
                                    onChange={(e) => setParallelismSeries(parseInt(e.target.value) || 5)}
                                />
                                <p className="text-xs text-muted-foreground">Default: 5. Series sync is the heavier of the two.</p>
                            </div>
                        </div>
                        <Button
                            className="w-full bg-cyan-600 hover:bg-cyan-700"
                            onClick={savePerformance}
                            disabled={savingSection === 'performance'}
                        >
                            {savingSection === 'performance' ? 'Saving…' : 'Save Performance'}
                        </Button>
                    </CardContent>
                </Card>
            </section>

            {/* ---------- Cache ---------- */}
            <section className="space-y-4">
                <h3 className="text-xl font-semibold">Cache Management</h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <Card className="border-yellow-200 dark:border-yellow-900">
                        <CardHeader>
                            <CardTitle className="flex items-center gap-2 text-yellow-700 dark:text-yellow-400">
                                <Database className="w-5 h-5" />
                                Clear Movie Cache
                            </CardTitle>
                        </CardHeader>
                        <CardContent>
                            <p className="text-sm text-muted-foreground mb-4">
                                Force a metadata refresh for all movies on the next sync. No files are deleted.
                            </p>
                            <Button
                                variant="outline"
                                className="w-full border-yellow-300 text-yellow-700 hover:bg-yellow-50 dark:border-yellow-800 dark:text-yellow-400 dark:hover:bg-yellow-950"
                                onClick={() => setDangerAction('clearMovieCache')}
                                disabled={loading}
                            >
                                Clear Movie Cache
                            </Button>
                        </CardContent>
                    </Card>

                    <Card className="border-yellow-200 dark:border-yellow-900">
                        <CardHeader>
                            <CardTitle className="flex items-center gap-2 text-yellow-700 dark:text-yellow-400">
                                <Database className="w-5 h-5" />
                                Clear Series Cache
                            </CardTitle>
                        </CardHeader>
                        <CardContent>
                            <p className="text-sm text-muted-foreground mb-4">
                                Force a metadata refresh for all series and episodes on the next sync. No files are deleted.
                            </p>
                            <Button
                                variant="outline"
                                className="w-full border-yellow-300 text-yellow-700 hover:bg-yellow-50 dark:border-yellow-800 dark:text-yellow-400 dark:hover:bg-yellow-950"
                                onClick={() => setDangerAction('clearSeriesCache')}
                                disabled={loading}
                            >
                                Clear Series Cache
                            </Button>
                        </CardContent>
                    </Card>
                </div>
            </section>

            {/* ---------- Danger zone, deliberately last ---------- */}
            <section className="space-y-4">
                <div className="flex items-center gap-2">
                    <AlertTriangle className="w-5 h-5 text-destructive" />
                    <h3 className="text-xl font-semibold text-destructive">Danger Zone</h3>
                </div>
                <p className="text-sm text-muted-foreground">
                    Every action below is irreversible and requires typing a confirmation word.
                </p>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                    <Card className="border-orange-300 dark:border-orange-900">
                        <CardHeader>
                            <CardTitle className="flex items-center gap-2 text-orange-700 dark:text-orange-400 text-base">
                                <Trash2 className="w-5 h-5" />
                                Delete Generated Files
                            </CardTitle>
                        </CardHeader>
                        <CardContent className="space-y-4">
                            <p className="text-sm text-muted-foreground">
                                Remove all .strm and .nfo files. The database is kept.
                            </p>
                            <Button
                                variant="outline"
                                className="w-full border-orange-300 text-orange-700 hover:bg-orange-50 dark:border-orange-800 dark:text-orange-400 dark:hover:bg-orange-950"
                                onClick={() => setDangerAction('deleteFiles')}
                                disabled={loading}
                            >
                                Delete All Files
                            </Button>
                        </CardContent>
                    </Card>

                    <Card className="border-red-300 dark:border-red-900">
                        <CardHeader>
                            <CardTitle className="flex items-center gap-2 text-red-700 dark:text-red-400 text-base">
                                <Database className="w-5 h-5" />
                                Reset Database
                            </CardTitle>
                        </CardHeader>
                        <CardContent className="space-y-4">
                            <p className="text-sm text-muted-foreground">
                                Erase subscriptions, selections, schedules and history. Files are kept.
                            </p>
                            <Button
                                variant="destructive"
                                className="w-full"
                                onClick={() => setDangerAction('resetDb')}
                                disabled={loading}
                            >
                                Reset Database
                            </Button>
                        </CardContent>
                    </Card>

                    <Card className="border-red-400 dark:border-red-800 bg-red-50/50 dark:bg-red-950/20">
                        <CardHeader>
                            <CardTitle className="flex items-center gap-2 text-red-800 dark:text-red-300 text-base">
                                <AlertTriangle className="w-5 h-5" />
                                Reset All Data
                            </CardTitle>
                        </CardHeader>
                        <CardContent className="space-y-4">
                            <p className="text-sm text-muted-foreground">
                                Delete every file and reset the database. Full wipe.
                            </p>
                            <Button
                                variant="destructive"
                                className="w-full bg-red-700 hover:bg-red-800"
                                onClick={() => setDangerAction('resetAll')}
                                disabled={loading}
                            >
                                Reset Everything
                            </Button>
                        </CardContent>
                    </Card>
                </div>
            </section>

            <ConfirmDialog
                isOpen={!!activeDanger}
                onClose={() => setDangerAction(null)}
                onConfirm={runDangerAction}
                title={activeDanger?.title ?? ''}
                variant="destructive"
                confirmLabel={activeDanger?.confirmLabel}
                requireTyped={activeDanger?.requireTyped}
                busy={loading}
            >
                {activeDanger?.body}
            </ConfirmDialog>
        </div>
    );
}

function CheckboxRow({ id, checked, onChange, label, hint }: {
    id: string;
    checked: boolean;
    onChange: (v: boolean) => void;
    label: string;
    hint: string;
}) {
    return (
        <div className="flex items-start space-x-3">
            <input
                type="checkbox"
                id={id}
                checked={checked}
                onChange={(e) => onChange(e.target.checked)}
                className="h-4 w-4 mt-1 rounded border-input"
            />
            <div>
                <label htmlFor={id} className="text-sm font-medium leading-none cursor-pointer">
                    {label}
                </label>
                <p className="text-xs text-muted-foreground mt-1">{hint}</p>
            </div>
        </div>
    );
}
