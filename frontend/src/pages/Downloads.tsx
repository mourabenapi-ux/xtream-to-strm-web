import { useEffect, useState, ChangeEvent } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
    Download, Trash2, CheckCircle, XCircle, Clock,
    ArrowUp, ArrowDown, Pause, Play, RotateCcw,
    Search, Settings
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import api from '@/lib/api';
import { Checkbox } from "@/components/ui/checkbox";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { useToast } from '@/contexts/ToastContext';
import DownloadStats from '@/components/DownloadStats';

const PAGE_SIZE = 50;

interface DownloadTask {
    id: number;
    title: string;
    media_type: string;
    status: string;
    progress: number;
    file_size: number | null;
    downloaded_bytes: number;
    save_path: string | null;
    error_message: string | null;
    created_at: string;
    started_at: string | null;
    completed_at: string | null;
    priority: number;
    retry_count: number;
    next_retry_at: string | null;
    current_speed_kbps: number;
    estimated_time_remaining: number | null;
}

export default function Downloads() {
    const toast = useToast();
    const navigate = useNavigate();
    const [tasks, setTasks] = useState<DownloadTask[]>([]);
    const [filter, setFilter] = useState<string>('all');
    const [searchTerm, setSearchTerm] = useState<string>('');
    const [selectedTasks, setSelectedTasks] = useState<number[]>([]);
    const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
    const [pendingDelete, setPendingDelete] = useState<{ ids: number[]; label: string } | null>(null);

    const fetchTasks = async () => {
        try {
            const params = new URLSearchParams();
            if (filter !== 'all') params.append('status', filter);
            if (searchTerm) params.append('q', searchTerm);

            const res = await api.get<DownloadTask[]>(`/downloads/tasks?${params.toString()}`);
            setTasks(res.data);
        } catch (error) {
            console.error("Failed to fetch download tasks", error);
        }
    };

    useEffect(() => {
        // Reset the window whenever the query changes, otherwise a narrow
        // filter would still be rendering hundreds of rows.
        setVisibleCount(PAGE_SIZE);
        fetchTasks();
        const interval = setInterval(fetchTasks, 2000);
        return () => clearInterval(interval);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [filter, searchTerm]);

    const handleAction = async (action: string, taskId: number) => {
        try {
            await api.post(`/downloads/tasks/${taskId}/${action}`);
            fetchTasks();
        } catch (error) {
            console.error(`Failed to ${action} task`, error);
            toast.apiError(`Failed to ${action} task`, error);
        }
    };

    // Deleting used to fire straight off a single click, for one task or for a
    // whole batch. It is the only irreversible action on this page.
    const confirmDelete = async () => {
        if (!pendingDelete) return;
        const { ids } = pendingDelete;
        try {
            if (ids.length === 1) {
                await api.delete(`/downloads/tasks/${ids[0]}`);
            } else {
                await api.post('/downloads/tasks/batch/delete', ids);
            }
            setSelectedTasks(prev => prev.filter(id => !ids.includes(id)));
            toast.success(`${ids.length} task${ids.length === 1 ? '' : 's'} deleted`);
            fetchTasks();
        } catch (error) {
            console.error("Failed to delete task(s)", error);
            toast.apiError('Failed to delete', error);
        } finally {
            setPendingDelete(null);
        }
    };

    const handlePriority = async (action: 'move-up' | 'move-down', taskId: number) => {
        try {
            await api.post(`/downloads/tasks/${taskId}/${action}`);
            fetchTasks();
        } catch (error) {
            console.error(`Failed to ${action} task`, error);
        }
    };

    const handleBatchAction = async (action: string) => {
        if (selectedTasks.length === 0) return;
        try {
            await api.post(`/downloads/tasks/batch/${action}`, selectedTasks);
            toast.success(`${selectedTasks.length} task(s) ${action}d`);
            setSelectedTasks([]);
            fetchTasks();
        } catch (error) {
            console.error(`Failed to batch ${action}`, error);
            toast.apiError(`Failed to ${action} selected tasks`, error);
        }
    };

    const toggleSelection = (taskId: number) => {
        setSelectedTasks((prev: number[]) =>
            prev.includes(taskId) ? prev.filter((id: number) => id !== taskId) : [...prev, taskId]
        );
    };

    const visibleTasks = tasks.slice(0, visibleCount);

    // Only ever selects the rows on screen, so "select all" cannot silently
    // pick up thousands of off-screen tasks.
    const selectAll = () => {
        const visibleIds = visibleTasks.map((t: DownloadTask) => t.id);
        const allVisibleSelected = visibleIds.length > 0 && visibleIds.every(id => selectedTasks.includes(id));
        setSelectedTasks(allVisibleSelected ? [] : visibleIds);
    };

    const formatBytes = (bytes: number | null) => {
        if (!bytes || bytes === 0) return '0 B';
        const sizes = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
        // Clamp the index: past the last unit this produced "1.42 undefined".
        const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), sizes.length - 1);
        return `${(bytes / Math.pow(1024, i)).toFixed(2)} ${sizes[i]}`;
    };

    const formatSpeed = (kbps: number) => {
        if (kbps < 1024) return `${kbps.toFixed(1)} KB/s`;
        return `${(kbps / 1024).toFixed(2)} MB/s`;
    };

    const formatETA = (seconds: number | null) => {
        if (seconds === null) return 'N/A';
        if (seconds < 60) return `${seconds}s`;
        const mins = Math.floor(seconds / 60);
        if (mins < 60) return `${mins}m ${seconds % 60}s`;
        const hours = Math.floor(mins / 60);
        return `${hours}h ${mins % 60}m`;
    };

    const getStatusIcon = (status: string) => {
        switch (status) {
            case 'completed': return <CheckCircle className="h-5 w-5 text-green-500" />;
            case 'failed': return <XCircle className="h-5 w-5 text-red-500" />;
            case 'cancelled': return <Trash2 className="h-5 w-5 text-gray-500" />;
            case 'downloading': return <Download className="h-5 w-5 text-blue-500 animate-pulse" />;
            case 'pending': return <Clock className="h-5 w-5 text-yellow-500" />;
            case 'paused': return <Pause className="h-5 w-5 text-orange-500" />;
            default: return null;
        }
    };

    const activeCount = tasks.filter((t: DownloadTask) => t.status === 'downloading').length;
    const pendingCount = tasks.filter((t: DownloadTask) => t.status === 'pending').length;
    const failedCount = tasks.filter((t: DownloadTask) => t.status === 'failed').length;

    return (
        <div className="space-y-6">
            <DownloadStats />
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                <div>
                    <h2 className="text-3xl font-bold tracking-tight">Downloads</h2>
                    <p className="text-muted-foreground">Advanced Download Manager</p>
                </div>
                <div className="flex items-center gap-2">
                    <div className="relative">
                        <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                        <Input
                            placeholder="Search tasks..."
                            className="pl-8 w-[200px] lg:w-[300px]"
                            value={searchTerm}
                            onChange={(e: ChangeEvent<HTMLInputElement>) => setSearchTerm(e.target.value)}
                        />
                    </div>
                    <Button
                        variant="outline"
                        size="icon"
                        onClick={() => navigate('/admin')}
                        title="Download settings (Administration)"
                    >
                        <Settings className="h-4 w-4" />
                    </Button>
                </div>
            </div>

            {/* Statistics */}
            <div className="grid gap-4 md:grid-cols-3">
                <Card className="bg-blue-50/50 dark:bg-blue-900/10">
                    <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                        <CardTitle className="text-sm font-medium">Active</CardTitle>
                        <Download className="h-4 w-4 text-blue-500" />
                    </CardHeader>
                    <CardContent>
                        <div className="text-2xl font-bold">{activeCount}</div>
                    </CardContent>
                </Card>
                <Card className="bg-yellow-50/50 dark:bg-yellow-900/10">
                    <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                        <CardTitle className="text-sm font-medium">Queued</CardTitle>
                        <Clock className="h-4 w-4 text-yellow-500" />
                    </CardHeader>
                    <CardContent>
                        <div className="text-2xl font-bold">{pendingCount}</div>
                    </CardContent>
                </Card>
                <Card className="bg-red-50/50 dark:bg-red-900/10">
                    <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                        <CardTitle className="text-sm font-medium">Failed</CardTitle>
                        <XCircle className="h-4 w-4 text-red-500" />
                    </CardHeader>
                    <CardContent>
                        <div className="text-2xl font-bold">{failedCount}</div>
                    </CardContent>
                </Card>
            </div>

            {/* Toolbar */}
            <div className="flex flex-wrap items-center justify-between gap-4 bg-muted/30 p-2 rounded-lg border">
                <div className="flex flex-wrap gap-2">
                    {['all', 'downloading', 'pending', 'paused', 'completed', 'failed'].map(s => (
                        <Button
                            key={s}
                            variant={filter === s ? 'default' : 'ghost'}
                            size="sm"
                            className="capitalize"
                            onClick={() => setFilter(s)}
                        >
                            {s}
                        </Button>
                    ))}
                </div>

                {selectedTasks.length > 0 && (
                    <div className="flex items-center gap-2 border-l pl-4 animate-in fade-in slide-in-from-right-2">
                        <span className="text-sm font-medium">{selectedTasks.length} selected</span>
                        <Button variant="outline" size="sm" onClick={() => handleBatchAction('pause')} title="Pause All">
                            <Pause className="h-3.5 w-3.5" />
                        </Button>
                        <Button variant="outline" size="sm" onClick={() => handleBatchAction('resume')} title="Resume All">
                            <Play className="h-3.5 w-3.5" />
                        </Button>
                        <Button variant="outline" size="sm" onClick={() => handleBatchAction('retry')} title="Retry All">
                            <RotateCcw className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                            variant="destructive"
                            size="sm"
                            onClick={() => setPendingDelete({
                                ids: [...selectedTasks],
                                label: `${selectedTasks.length} selected task(s)`
                            })}
                            title="Delete All"
                        >
                            <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                    </div>
                )}
            </div>

            {/* Tasks List */}
            <div className="space-y-3">
                {/* Hidden below xl: the fixed column widths stop lining up with
                    the rows once the viewport gets narrow. */}
                <div className="hidden xl:flex items-center px-4 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wider">
                    <div className="w-10 flex justify-center">
                        <Checkbox
                            checked={visibleTasks.length > 0 && visibleTasks.every(t => selectedTasks.includes(t.id))}
                            onCheckedChange={selectAll}
                        />
                    </div>
                    <div className="flex-1 ml-4">Media Info</div>
                    <div className="w-48 text-center">Progress</div>
                    <div className="w-32 text-center">Priority</div>
                    <div className="w-32 text-right">Actions</div>
                </div>

                {tasks.length === 0 ? (
                    <Card>
                        <CardContent className="py-12 flex flex-col items-center justify-center text-muted-foreground">
                            <Download className="h-12 w-12 mb-4 opacity-20" />
                            <p>No download tasks found</p>
                        </CardContent>
                    </Card>
                ) : (
                    visibleTasks.map((task: DownloadTask) => (
                        <Card key={task.id} className={`transition-all ${selectedTasks.includes(task.id) ? 'ring-1 ring-primary border-primary/50' : ''}`}>
                            <CardContent className="p-0">
                                <div className="flex flex-wrap xl:flex-nowrap items-center gap-y-3 p-4">
                                    <div className="w-10 flex justify-center">
                                        <Checkbox
                                            checked={selectedTasks.includes(task.id)}
                                            onCheckedChange={() => toggleSelection(task.id)}
                                        />
                                    </div>

                                    <div className="flex-1 ml-4 overflow-hidden">
                                        <div className="flex items-center gap-2">
                                            {getStatusIcon(task.status)}
                                            <p className="font-semibold truncate">{task.title}</p>
                                        </div>
                                        <div className="flex flex-wrap gap-x-4 gap-y-1 mt-1 text-xs text-muted-foreground capitalize">
                                            <span>{task.media_type}</span>
                                            {task.status === 'downloading' && (
                                                <>
                                                    <span className="text-blue-600 font-medium">{formatSpeed(task.current_speed_kbps)}</span>
                                                    <span className="text-orange-600 font-medium">ETA: {formatETA(task.estimated_time_remaining)}</span>
                                                </>
                                            )}
                                            {task.status === 'failed' && (
                                                <span className="text-red-500 font-medium truncate max-w-[200px]">{task.error_message}</span>
                                            )}
                                            {task.status === 'completed' && task.save_path && (
                                                <span className="truncate max-w-[300px]" title={task.save_path}>{task.save_path}</span>
                                            )}
                                        </div>
                                    </div>

                                    <div className="w-full xl:w-48 order-last xl:order-none px-0 xl:px-4 flex flex-col gap-1">
                                        <div className="flex justify-between text-[10px] font-medium text-muted-foreground uppercase">
                                            <span>{formatBytes(task.downloaded_bytes)}</span>
                                            <span>{formatBytes(task.file_size)}</span>
                                        </div>
                                        <div className="w-full bg-secondary rounded-full h-1.5 overflow-hidden">
                                            <div
                                                className={`h-full transition-all ${task.status === 'downloading' ? 'bg-blue-500' :
                                                    task.status === 'completed' ? 'bg-green-500' :
                                                        task.status === 'failed' ? 'bg-red-500' :
                                                            task.status === 'paused' ? 'bg-orange-500' : 'bg-gray-400'
                                                    }`}
                                                style={{ width: `${task.progress}%` }}
                                            />
                                        </div>
                                        <div className="text-right text-[10px] font-bold">{task.progress.toFixed(1)}%</div>
                                    </div>

                                    <div className="w-32 flex justify-center items-center gap-1 ml-auto xl:ml-0">
                                        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => handlePriority('move-down', task.id)} disabled={task.status !== 'pending'}>
                                            <ArrowDown className="h-4 w-4" />
                                        </Button>
                                        <span className="text-xs font-bold w-4 text-center">{task.priority}</span>
                                        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => handlePriority('move-up', task.id)} disabled={task.status !== 'pending'}>
                                            <ArrowUp className="h-4 w-4" />
                                        </Button>
                                    </div>

                                    <div className="w-32 flex justify-end gap-1">
                                        {task.status === 'downloading' && (
                                            <Button variant="outline" size="icon" className="h-8 w-8 text-orange-500" onClick={() => handleAction('pause', task.id)}>
                                                <Pause className="h-4 w-4" />
                                            </Button>
                                        )}
                                        {task.status === 'paused' && (
                                            <Button variant="outline" size="icon" className="h-8 w-8 text-green-500" onClick={() => handleAction('resume', task.id)}>
                                                <Play className="h-4 w-4" />
                                            </Button>
                                        )}
                                        {(task.status === 'failed' || task.status === 'cancelled') && (
                                            <Button variant="outline" size="icon" className="h-8 w-8 text-blue-500" onClick={() => handleAction('retry', task.id)}>
                                                <RotateCcw className="h-4 w-4" />
                                            </Button>
                                        )}
                                        <Button
                                            variant="ghost"
                                            size="icon"
                                            className="h-8 w-8 text-destructive"
                                            onClick={() => setPendingDelete({ ids: [task.id], label: task.title })}
                                        >
                                            <Trash2 className="h-4 w-4" />
                                        </Button>
                                    </div>
                                </div>
                            </CardContent>
                        </Card>
                    ))
                )}
            </div>

            {visibleCount < tasks.length && (
                <div className="flex items-center justify-between p-3 rounded-lg border bg-muted/30">
                    <span className="text-xs text-muted-foreground">
                        Showing {visibleTasks.length} of {tasks.length} tasks
                    </span>
                    <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setVisibleCount(c => c + PAGE_SIZE)}
                    >
                        Load {Math.min(PAGE_SIZE, tasks.length - visibleCount)} more
                    </Button>
                </div>
            )}

            <ConfirmDialog
                isOpen={!!pendingDelete}
                onClose={() => setPendingDelete(null)}
                onConfirm={confirmDelete}
                title="Delete download task?"
                variant="destructive"
                confirmLabel={pendingDelete && pendingDelete.ids.length > 1 ? 'Delete all selected' : 'Delete task'}
            >
                <p>
                    Delete <strong>{pendingDelete?.label}</strong>?
                </p>
                <p className="text-muted-foreground">
                    This removes the task from the queue. Files already downloaded are kept on disk.
                </p>
            </ConfirmDialog>
        </div>
    );
}
