import { useEffect, useState, useCallback } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import {
    Film, Tv, Activity, HardDrive, Globe, Copy, Check,
    RefreshCw, Play, Download, Settings, Server, Cpu,
    AlertTriangle, CheckCircle2, ChevronRight, LayoutGrid, Search
} from 'lucide-react';
import { Button } from "@/components/ui/button";
import { useNavigate } from 'react-router-dom';
import api from '@/lib/api';

interface DashboardStats {
    sources: {
        total: number;
        xtream: number;
        m3u: number;
        active: number;
    };
    total_content: {
        total: number;
        movies: number;
        series: number;
        live_playlists: number;
        epg_sources: number;
    };
    sync_status: {
        in_progress: number;
        errors_24h: number;
        success_rate: number;
        active_downloads: number;
    };
    system_health: {
        disk: {
            total_gb: number;
            used_gb: number;
            free_gb: number;
            usage_pct: number;
        };
        redis: string;
        celery_workers: number;
    };
}

interface LivePlaylistDetail {
    id: number;
    name: string;
    description: string;
    channel_count: number;
    epg_coverage: number;
    epg_sources_count: number;
    m3u_url: string;
    epg_url: string;
}

interface ActiveTask {
    id: string;
    type: 'sync' | 'download';
    name: string;
    progress: number;
    speed_kbps?: number;
    eta_seconds?: number;
    status: string;
}

export default function Dashboard() {
    const navigate = useNavigate();
    const [stats, setStats] = useState<DashboardStats | null>(null);
    const [playlists, setPlaylists] = useState<LivePlaylistDetail[]>([]);
    const [tasks, setTasks] = useState<ActiveTask[]>([]);
    const [loading, setLoading] = useState(true);
    const [copiedId, setCopiedId] = useState<string | null>(null);

    const fetchData = useCallback(async () => {
        try {
            const [statsRes, playlistsRes, tasksRes] = await Promise.all([
                api.get<DashboardStats>('/dashboard/stats'),
                api.get<LivePlaylistDetail[]>('/dashboard/live-playlists-detail'),
                api.get<ActiveTask[]>('/dashboard/active-tasks')
            ]);
            setStats(statsRes.data);
            setPlaylists(playlistsRes.data);
            setTasks(tasksRes.data);
        } catch (error) {
            console.error("Failed to fetch dashboard data", error);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        fetchData();
        const interval = setInterval(fetchData, 5000);
        return () => clearInterval(interval);
    }, [fetchData]);

    const copyToClipboard = (text: string, id: string) => {
        const fullUrl = `${window.location.origin}${text}`;
        navigator.clipboard.writeText(fullUrl);
        setCopiedId(id);
        setTimeout(() => setCopiedId(null), 2000);
    };

    if (loading && !stats) {
        return (
            <div className="flex items-center justify-center h-[50vh]">
                <RefreshCw className="h-8 w-8 animate-spin text-primary" />
            </div>
        );
    }

    return (
        <div className="space-y-8 pb-10">
            <div className="flex justify-between items-end">
                <div>
                    <h2 className="text-3xl font-bold tracking-tight">System Dashboard</h2>
                    <p className="text-muted-foreground italic">Real-time overview of your media infrastructure.</p>
                </div>
                <div className="flex gap-2">
                    <Button variant="outline" size="sm" onClick={() => fetchData()}>
                        <RefreshCw className="h-4 w-4 mr-2" />
                        Refresh
                    </Button>
                </div>
            </div>

            {/* 1. Hero Stats */}
            <div className="grid gap-4 grid-cols-2 md:grid-cols-3 lg:grid-cols-6">
                <HeroStatCard
                    title="Movie Cache"
                    value={stats?.total_content.movies || 0}
                    icon={<Film className="h-4 w-4" />}
                    footer={`${stats?.sources.xtream || 0} Xtream Sources`}
                />
                <HeroStatCard
                    title="Series Cache"
                    value={stats?.total_content.series || 0}
                    icon={<Tv className="h-4 w-4" />}
                    footer={`${stats?.sync_status.success_rate || 0}% Success Rate`}
                />
                <HeroStatCard
                    title="Live Playlists"
                    value={stats?.total_content.live_playlists || 0}
                    icon={<LayoutGrid className="h-4 w-4" />}
                    footer="Active M3U exports"
                />
                <HeroStatCard
                    title="EPG Sources"
                    value={stats?.total_content.epg_sources || 0}
                    icon={<Globe className="h-4 w-4" />}
                    footer="Global XMLTV library"
                />
                <HeroStatCard
                    title="Downloads"
                    value={stats?.sync_status.active_downloads || 0}
                    icon={<Download className="h-4 w-4" />}
                    color="text-blue-500"
                    footer="Active in queue"
                />
                <HeroStatCard
                    title="Disk Usage"
                    value={`${stats?.system_health.disk.usage_pct || 0}%`}
                    icon={<HardDrive className="h-4 w-4" />}
                    color={stats?.system_health.disk.usage_pct && stats.system_health.disk.usage_pct > 90 ? "text-destructive" : "text-muted-foreground"}
                    footer={`${stats?.system_health.disk.free_gb || 0} GB available`}
                />
            </div>

            {/* 2. Live Playlists with URLs */}
            <div className="space-y-4">
                <div className="flex items-center gap-2">
                    <LayoutGrid className="h-5 w-5 text-primary" />
                    <h3 className="text-xl font-bold">Managed Live Playlists</h3>
                </div>
                <div className="grid gap-4 lg:grid-cols-2">
                    {playlists.map(pl => (
                        <Card key={pl.id} className="overflow-hidden border-l-4 border-l-primary">
                            <CardHeader className="py-4">
                                <div className="flex justify-between items-start">
                                    <div>
                                        <CardTitle className="text-lg">{pl.name}</CardTitle>
                                        <CardDescription>{pl.description || "No description"}</CardDescription>
                                    </div>
                                    <Button variant="ghost" size="sm" onClick={() => navigate(`/live-selection?playlist_id=${pl.id}`)}>
                                        Edit <ChevronRight className="ml-1 h-4 w-4" />
                                    </Button>
                                </div>
                            </CardHeader>
                            <CardContent className="space-y-4 pb-4">
                                <div className="flex items-center gap-4 text-xs text-muted-foreground border-b pb-3">
                                    <div className="flex items-center gap-1">
                                        <Tv className="h-3.5 w-3.5" /> {pl.channel_count} Channels
                                    </div>
                                    <div className="flex items-center gap-1">
                                        <Globe className="h-3.5 w-3.5" /> {pl.epg_sources_count} EPG Sources
                                    </div>
                                    <div className={`flex items-center gap-1 font-bold ${pl.epg_coverage > 90 ? 'text-emerald-500' : 'text-amber-500'}`}>
                                        EPG: {pl.epg_coverage}%
                                    </div>
                                </div>
                                <div className="space-y-2">
                                    <UrlCopyRow
                                        label="M3U URL"
                                        url={pl.m3u_url}
                                        id={`${pl.id}-m3u`}
                                        isCopied={copiedId === `${pl.id}-m3u`}
                                        onCopy={() => copyToClipboard(pl.m3u_url, `${pl.id}-m3u`)}
                                    />
                                    <UrlCopyRow
                                        label="EPG URL"
                                        url={pl.epg_url}
                                        id={`${pl.id}-epg`}
                                        isCopied={copiedId === `${pl.id}-epg`}
                                        onCopy={() => copyToClipboard(pl.epg_url, `${pl.id}-epg`)}
                                    />
                                </div>
                            </CardContent>
                        </Card>
                    ))}
                    {playlists.length === 0 && (
                        <Card className="col-span-full py-10 border-dashed">
                            <CardContent className="text-center text-muted-foreground">
                                No live playlists configured yet. <br />
                                <Button variant="link" onClick={() => navigate('/live-playlists')}>Create your first playlist</Button>
                            </CardContent>
                        </Card>
                    )}
                </div>
            </div>

            {/* 3. Activity & System Health */}
            <div className="grid gap-8 md:grid-cols-2">
                {/* Active Tasks/Activity */}
                <div className="space-y-4">
                    <div className="flex items-center gap-2">
                        <Activity className="h-5 w-5 text-primary" />
                        <h3 className="text-xl font-bold">Real-time Activity</h3>
                    </div>
                    <Card className="min-h-[200px] max-h-[420px] overflow-hidden flex flex-col">
                        <CardContent className="p-0 flex-1 overflow-y-auto">
                            {tasks.length > 0 ? (
                                <div className="divide-y">
                                    {tasks.map(task => (
                                        <div key={task.id} className="p-4 space-y-2 hover:bg-muted/50 transition-colors">
                                            <div className="flex justify-between items-center">
                                                <div className="flex items-center gap-3">
                                                    <div className={`p-2 rounded-full ${task.type === 'sync' ? 'bg-purple-500/10 text-purple-500' : 'bg-blue-500/10 text-blue-500'}`}>
                                                        {task.type === 'sync' ? <RefreshCw className={`h-4 w-4 ${task.status === 'running' ? 'animate-spin' : ''}`} /> : <Download className="h-4 w-4" />}
                                                    </div>
                                                    <div>
                                                        <div className="text-sm font-semibold truncate max-w-[200px]">{task.name}</div>
                                                        <div className="text-[10px] text-muted-foreground uppercase tracking-wider font-bold">
                                                            {task.type} • {task.status}
                                                        </div>
                                                    </div>
                                                </div>
                                                {task.type === 'download' && task.speed_kbps && (
                                                    <div className="text-xs font-mono text-muted-foreground">
                                                        {(task.speed_kbps / 1024).toFixed(1)} MB/s
                                                    </div>
                                                )}
                                            </div>
                                            <div className="space-y-1">
                                                <div className="flex justify-between text-[10px] text-muted-foreground">
                                                    <span>Progress</span>
                                                    <span>{Math.round(task.progress)}%</span>
                                                </div>
                                                <div className="h-1.5 w-full bg-secondary rounded-full overflow-hidden">
                                                    <div
                                                        className={`h-full transition-all duration-500 ${task.type === 'sync' ? 'bg-purple-500' : 'bg-blue-500'}`}
                                                        style={{ width: `${task.progress}%` }}
                                                    />
                                                </div>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            ) : (
                                <div className="flex flex-col items-center justify-center h-full text-muted-foreground opacity-50 p-8 text-center">
                                    <CheckCircle2 className="h-12 w-12 mb-4 text-emerald-500/50" />
                                    <p className="text-sm">No active tasks at the moment.</p>
                                    <p className="text-xs">All systems are operational and idle.</p>
                                </div>
                            )}
                        </CardContent>
                    </Card>
                </div>

                {/* System Health */}
                <div className="space-y-4">
                    <div className="flex items-center gap-2">
                        <Server className="h-5 w-5 text-primary" />
                        <h3 className="text-xl font-bold">System Health</h3>
                    </div>
                    <Card className="min-h-[200px]">
                        <CardContent className="p-6 space-y-6">
                            {/* Redis Status */}
                            <div className="flex items-center justify-between">
                                <div className="flex items-center gap-3">
                                    <div className={`p-2 rounded-full ${stats?.system_health.redis === 'online' ? 'bg-emerald-500/10 text-emerald-500' : 'bg-destructive/10 text-destructive'}`}>
                                        <Cpu className="h-5 w-5" />
                                    </div>
                                    <div>
                                        <div className="text-sm font-bold">In-Memory Cache (Redis)</div>
                                        <div className="text-xs text-muted-foreground">Used for EPG & Session data</div>
                                    </div>
                                </div>
                                <div className={`px-2 py-1 rounded text-[10px] font-bold uppercase ${stats?.system_health.redis === 'online' ? 'bg-emerald-500/20 text-emerald-500' : 'bg-destructive/20 text-destructive'}`}>
                                    {stats?.system_health.redis || "Unknown"}
                                </div>
                            </div>

                            {/* Celery Workers */}
                            <div className="flex items-center justify-between">
                                <div className="flex items-center gap-3">
                                    <div className={`p-2 rounded-full ${stats?.system_health.celery_workers && stats.system_health.celery_workers > 0 ? 'bg-emerald-500/10 text-emerald-500' : 'bg-amber-500/10 text-amber-500'}`}>
                                        <Activity className="h-5 w-5" />
                                    </div>
                                    <div>
                                        <div className="text-sm font-bold">Background Workers</div>
                                        <div className="text-xs text-muted-foreground">Celery distributed tasks</div>
                                    </div>
                                </div>
                                <div className="text-sm font-bold">
                                    {stats?.system_health.celery_workers || 0} active
                                </div>
                            </div>

                            {/* Disk Usage Detail */}
                            <div className="space-y-3">
                                <div className="flex justify-between items-center">
                                    <div className="flex items-center gap-3">
                                        <div className="p-2 rounded-full bg-blue-500/10 text-blue-500">
                                            <HardDrive className="h-5 w-5" />
                                        </div>
                                        <div>
                                            <div className="text-sm font-bold">Storage Capacity</div>
                                            <div className="text-xs text-muted-foreground">Used for downloads & generated STRMs</div>
                                        </div>
                                    </div>
                                    <div className="text-sm font-bold text-right">
                                        {stats?.system_health.disk.used_gb} GB / {stats?.system_health.disk.total_gb} GB
                                    </div>
                                </div>
                                <div className="space-y-1">
                                    <div className="h-2 w-full bg-secondary rounded-full overflow-hidden">
                                        <div
                                            className={`h-full transition-all duration-1000 ${stats?.system_health.disk.usage_pct && stats.system_health.disk.usage_pct > 90 ? 'bg-destructive' : 'bg-blue-500'}`}
                                            style={{ width: `${stats?.system_health.disk.usage_pct}%` }}
                                        />
                                    </div>
                                    <div className="flex justify-between text-[10px] text-muted-foreground">
                                        <span>{stats?.system_health.disk.usage_pct}% used</span>
                                        <span>{stats?.system_health.disk.free_gb} GB free</span>
                                    </div>
                                </div>
                            </div>

                            {/* Errors 24h Warning */}
                            {stats?.sync_status.errors_24h && stats.sync_status.errors_24h > 0 ? (
                                <div className="p-3 bg-destructive/10 border border-destructive/20 rounded-md flex items-center gap-3 text-destructive animate-pulse">
                                    <AlertTriangle className="h-5 w-5 flex-shrink-0" />
                                    <div>
                                        <div className="text-xs font-bold">Sync Errors Detected</div>
                                        <div className="text-[10px]">{stats.sync_status.errors_24h} sync tasks failed in the last 24h.</div>
                                    </div>
                                    <Button variant="ghost" size="sm" className="ml-auto text-destructive h-7 hover:bg-destructive/20 px-2 text-[10px] font-bold" onClick={() => navigate('/logs')}>
                                        View Logs
                                    </Button>
                                </div>
                            ) : (
                                <div className="p-3 bg-emerald-500/10 border border-emerald-500/20 rounded-md flex items-center gap-3 text-emerald-500">
                                    <CheckCircle2 className="h-5 w-5 flex-shrink-0" />
                                    <div className="text-xs font-bold">All systems healthy. No errors reported today.</div>
                                </div>
                            )}
                        </CardContent>
                    </Card>
                </div>
            </div>

            {/* 4. Quick Actions & Quick Links */}
            <div className="grid gap-8 lg:grid-cols-3">
                <div className="lg:col-span-2 space-y-4">
                    <div className="flex items-center gap-2">
                        <Play className="h-5 w-5 text-primary" />
                        <h3 className="text-xl font-bold">Quick Actions</h3>
                    </div>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                        <ActionCard
                            icon={<LayoutGrid className="h-5 w-5" />}
                            label="New Playlist"
                            onClick={() => navigate('/live-playlists')}
                        />
                        <ActionCard
                            icon={<Globe className="h-5 w-5" />}
                            label="Add EPG"
                            onClick={() => navigate('/epg-admin')}
                        />
                        <ActionCard
                            icon={<RefreshCw className="h-5 w-5" />}
                            label="Force Sync"
                            onClick={() => navigate('/xtreamtv/selection')}
                        />
                        <ActionCard
                            icon={<Search className="h-5 w-5" />}
                            label="Explore Logs"
                            onClick={() => navigate('/logs')}
                        />
                    </div>
                </div>

                <div className="space-y-4">
                    <div className="flex items-center gap-2">
                        <Settings className="h-5 w-5 text-primary" />
                        <h3 className="text-xl font-bold">Admin Modules</h3>
                    </div>
                    <div className="space-y-2">
                        <ModuleRow icon={<Tv className="text-primary h-4 w-4" />} label="Live Playlists" onClick={() => navigate('/live-playlists')} />
                        <ModuleRow icon={<Film className="text-blue-500 h-4 w-4" />} label="Xtream Content" onClick={() => navigate('/xtreamtv/selection')} />
                        <ModuleRow icon={<Server className="text-purple-500 h-4 w-4" />} label="Download Manager" onClick={() => navigate('/downloads/manager')} />
                        <ModuleRow icon={<Settings className="text-muted-foreground h-4 w-4" />} label="Settings" onClick={() => navigate('/admin')} />
                    </div>
                </div>
            </div>
        </div>
    );
}

// Helper Components
function HeroStatCard({ title, value, icon, footer, color = "text-muted-foreground" }: any) {
    return (
        <Card className="hover:shadow-md transition-shadow duration-300">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-[10px] uppercase font-bold tracking-wider text-muted-foreground">{title}</CardTitle>
                <div className={color}>{icon}</div>
            </CardHeader>
            <CardContent>
                <div className="text-xl font-bold">{value}</div>
                <p className="text-[10px] text-muted-foreground truncate font-medium mt-1">
                    {footer}
                </p>
            </CardContent>
        </Card>
    );
}

function UrlCopyRow({ label, url, isCopied, onCopy }: any) {
    return (
        <div className="space-y-1">
            <div className="text-[10px] font-bold uppercase text-muted-foreground flex items-center gap-1">
                {label}
            </div>
            <div className="flex items-center gap-2 group">
                <div className="flex-1 bg-muted/50 p-2 rounded text-[11px] font-mono truncate select-all cursor-text border group-hover:border-primary/30 transition-colors">
                    {window.location.origin}{url}
                </div>
                <Button
                    variant="ghost"
                    size="icon"
                    className={`h-8 w-8 shrink-0 ${isCopied ? 'bg-emerald-500 hover:bg-emerald-600 text-white' : ''}`}
                    onClick={onCopy}
                >
                    {isCopied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                </Button>
            </div>
        </div>
    );
}

function ActionCard({ icon, label, onClick }: any) {
    return (
        <button
            onClick={onClick}
            className="flex flex-col items-center justify-center p-4 rounded-xl border-2 border-transparent bg-card hover:border-primary/50 hover:bg-primary/5 transition-all duration-200 group h-24"
        >
            <div className="p-2 rounded-lg bg-primary/10 text-primary mb-2 group-hover:scale-110 transition-transform">
                {icon}
            </div>
            <span className="text-xs font-semibold">{label}</span>
        </button>
    );
}

function ModuleRow({ icon, label, onClick }: any) {
    return (
        <button
            onClick={onClick}
            className="w-full flex items-center justify-between p-3 rounded-lg border bg-card hover:bg-accent hover:border-primary/30 transition-all text-left"
        >
            <div className="flex items-center gap-3">
                <div className="p-1.5 rounded bg-muted">
                    {icon}
                </div>
                <span className="text-sm font-medium">{label}</span>
            </div>
            <ChevronRight className="h-4 w-4 text-muted-foreground" />
        </button>
    );
}
