import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import api from "@/lib/api";
import { formatDateTime } from '@/lib/utils';
import { Plus, Upload, Trash2, FileText, Link as LinkIcon, RefreshCw } from "lucide-react";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { useToast } from '@/contexts/ToastContext';

interface M3USource {
    id: number;
    name: string;
    source_type: string;
    url?: string;
    file_path?: string;
    output_dir: string;
    is_active: boolean;
    sync_status?: string;
    last_sync?: string;
    created_at: string;
}

export default function M3USources() {
    const toast = useToast();
    const [sources, setSources] = useState<M3USource[]>([]);
    const [syncingId, setSyncingId] = useState<number | null>(null);
    const [loading, setLoading] = useState(false);
    const [activeTab, setActiveTab] = useState<'url' | 'file'>('url');
    const [sourceToDelete, setSourceToDelete] = useState<{ id: number, name: string } | null>(null);

    // URL form
    const [urlForm, setUrlForm] = useState({
        name: '',
        url: '',
        movies_dir: '',
        series_dir: ''
    });

    // File form
    const [fileForm, setFileForm] = useState({
        name: '',
        file: null as File | null,
        movies_dir: '',
        series_dir: ''
    });

    useEffect(() => {
        fetchSources();
    }, []);

    // Only poll while a sync is actually running. Polling every 3s forever was
    // the most aggressive refresh in the app on the page that needs it least.
    const hasRunningSync = sources.some(s => s.sync_status === 'syncing');
    useEffect(() => {
        if (!hasRunningSync) return;
        const interval = setInterval(fetchSources, 3000);
        return () => clearInterval(interval);
    }, [hasRunningSync]);

    const fetchSources = async () => {
        try {
            const res = await api.get<M3USource[]>('/m3u-sources/');
            setSources(res.data);
        } catch (error) {
            console.error("Failed to fetch M3U sources", error);
        }
    };

    const handleUrlSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setLoading(true);
        try {
            await api.post('/m3u-sources/url', urlForm);
            setUrlForm({ name: '', url: '', movies_dir: '', series_dir: '' });
            await fetchSources();
            // The backend deliberately does not sync on create: groups have to
            // be selected first. Saying "sync started" here was a lie.
            toast.success('M3U source added', 'Pick the groups to import in Group Selection, then sync.');
        } catch (error) {
            console.error("Failed to add M3U source", error);
            toast.apiError('Failed to add M3U source', error);
        } finally {
            setLoading(false);
        }
    };

    const handleFileSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!fileForm.file) {
            toast.warning('No file selected', 'Choose an .m3u or .m3u8 file first.');
            return;
        }

        setLoading(true);
        try {
            const formData = new FormData();
            formData.append('name', fileForm.name);
            formData.append('file', fileForm.file);
            // These two were rendered but never sent, so whatever the user
            // typed was silently discarded.
            formData.append('movies_dir', fileForm.movies_dir);
            formData.append('series_dir', fileForm.series_dir);

            await api.post('/m3u-sources/upload', formData, {
                headers: {
                    'Content-Type': 'multipart/form-data',
                },
            });

            setFileForm({ name: '', file: null, movies_dir: '', series_dir: '' });
            await fetchSources();
            toast.success('M3U file uploaded', 'Pick the groups to import in Group Selection, then sync.');
        } catch (error) {
            console.error("Failed to upload M3U file", error);
            toast.apiError('Failed to upload M3U file', error);
        } finally {
            setLoading(false);
        }
    };

    // The page that owns the sources could not re-sync them: the only
    // "Refresh Source" button lived on Group Selection.
    const resyncSource = async (source: M3USource) => {
        setSyncingId(source.id);
        try {
            await api.post(`/m3u-sources/${source.id}/sync?force=true`);
            toast.success('Sync started', source.name);
            await fetchSources();
        } catch (error) {
            console.error("Failed to sync source", error);
            toast.apiError('Failed to start sync', error);
        } finally {
            setSyncingId(null);
        }
    };

    const confirmDelete = (sourceId: number, sourceName: string) => {
        setSourceToDelete({ id: sourceId, name: sourceName });
    };

    const handleDelete = async () => {
        if (!sourceToDelete) return;

        setLoading(true);
        try {
            await api.delete(`/m3u-sources/${sourceToDelete.id}`);
            await fetchSources();
            toast.success('Source deleted', sourceToDelete.name);
            setSourceToDelete(null);
        } catch (error) {
            console.error("Failed to delete source", error);
            toast.apiError('Failed to delete source', error);
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="space-y-8">
            <div>
                <h2 className="text-3xl font-bold tracking-tight">M3U Import</h2>
                <p className="text-muted-foreground">Import M3U playlists from URLs or files and convert to STRM format.</p>
            </div>

            {/* Import Form */}
            <Card>
                <CardHeader>
                    <CardTitle>Add M3U Source</CardTitle>
                </CardHeader>
                <CardContent>
                    {/* Tab Buttons */}
                    <div className="flex gap-2 mb-6">
                        <Button
                            variant={activeTab === 'url' ? 'default' : 'outline'}
                            onClick={() => setActiveTab('url')}
                            className="flex-1"
                        >
                            <LinkIcon className="w-4 h-4 mr-2" />
                            From URL
                        </Button>
                        <Button
                            variant={activeTab === 'file' ? 'default' : 'outline'}
                            onClick={() => setActiveTab('file')}
                            className="flex-1"
                        >
                            <Upload className="w-4 h-4 mr-2" />
                            Upload File
                        </Button>
                    </div>

                    {/* URL Form */}
                    {activeTab === 'url' && (
                        <form onSubmit={handleUrlSubmit} className="space-y-4">
                            <div>
                                <label className="block text-sm font-medium mb-2">Source Name</label>
                                <Input
                                    placeholder="My M3U Playlist"
                                    value={urlForm.name}
                                    onChange={(e) => setUrlForm({ ...urlForm, name: e.target.value })}
                                    required
                                />
                            </div>
                            <div>
                                <label className="block text-sm font-medium mb-2">M3U URL</label>
                                <Input
                                    placeholder="http://example.com/playlist.m3u"
                                    value={urlForm.url}
                                    onChange={(e) => setUrlForm({ ...urlForm, url: e.target.value })}
                                    required
                                />
                            </div>
                            <div>
                                <label className="block text-sm font-medium mb-2">Movies Directory (Optional)</label>
                                <Input
                                    placeholder="/output/m3u/movies (default if empty)"
                                    value={urlForm.movies_dir}
                                    onChange={(e) => setUrlForm({ ...urlForm, movies_dir: e.target.value })}
                                />
                            </div>
                            <div>
                                <label className="block text-sm font-medium mb-2">Series Directory (Optional)</label>
                                <Input
                                    placeholder="/output/m3u/series (default if empty)"
                                    value={urlForm.series_dir}
                                    onChange={(e) => setUrlForm({ ...urlForm, series_dir: e.target.value })}
                                />
                            </div>
                            <Button type="submit" disabled={loading} className="w-full">
                                <Plus className="w-4 h-4 mr-2" />
                                {loading ? 'Adding...' : 'Add M3U Source'}
                            </Button>
                        </form>
                    )}

                    {/* File Upload Form */}
                    {activeTab === 'file' && (
                        <form onSubmit={handleFileSubmit} className="space-y-4">
                            <div>
                                <label className="block text-sm font-medium mb-2">Source Name</label>
                                <Input
                                    placeholder="My M3U Playlist"
                                    value={fileForm.name}
                                    onChange={(e) => setFileForm({ ...fileForm, name: e.target.value })}
                                    required
                                />
                            </div>
                            <div>
                                <label className="block text-sm font-medium mb-2">M3U File</label>
                                <Input
                                    type="file"
                                    accept=".m3u,.m3u8"
                                    onChange={(e) => setFileForm({ ...fileForm, file: e.target.files?.[0] || null })}
                                    required
                                />
                                <p className="text-sm text-muted-foreground mt-1">Accepts .m3u and .m3u8 files</p>
                            </div>
                            <div>
                                <label className="block text-sm font-medium mb-2">Movies Directory (Optional)</label>
                                <Input
                                    placeholder="/output/m3u/movies (default if empty)"
                                    value={fileForm.movies_dir}
                                    onChange={(e) => setFileForm({ ...fileForm, movies_dir: e.target.value })}
                                />
                            </div>
                            <div>
                                <label className="block text-sm font-medium mb-2">Series Directory (Optional)</label>
                                <Input
                                    placeholder="/output/m3u/series (default if empty)"
                                    value={fileForm.series_dir}
                                    onChange={(e) => setFileForm({ ...fileForm, series_dir: e.target.value })}
                                />
                            </div>
                            <Button type="submit" disabled={loading} className="w-full">
                                <Upload className="w-4 h-4 mr-2" />
                                {loading ? 'Uploading...' : 'Upload & Import'}
                            </Button>
                        </form>
                    )}
                </CardContent>
            </Card>

            {/* Sources List */}
            <Card>
                <CardHeader>
                    <CardTitle>M3U Sources</CardTitle>
                </CardHeader>
                <CardContent>
                    {sources.length === 0 ? (
                        <div className="text-center py-8 text-muted-foreground">
                            No M3U sources added yet. Add one using the form above.
                        </div>
                    ) : (
                        <div className="border rounded-md">
                            <table className="w-full text-sm">
                                <thead className="bg-muted/50 text-muted-foreground">
                                    <tr>
                                        <th className="p-3 text-left">Name</th>
                                        <th className="p-3 text-left">Type</th>
                                        <th className="p-3 text-left">Source</th>
                                        <th className="p-3 text-left">Last Sync</th>
                                        <th className="p-3 text-right">Actions</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y">
                                    {sources.map(source => (
                                        <tr key={source.id} className="hover:bg-muted/50 transition-colors">
                                            <td className="p-3 font-medium">{source.name}</td>
                                            <td className="p-3">
                                                <span className="inline-flex items-center px-2 py-1 rounded-full text-xs bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200">
                                                    {source.source_type === 'url' ? <LinkIcon className="w-3 h-3 mr-1" /> : <FileText className="w-3 h-3 mr-1" />}
                                                    {source.source_type.toUpperCase()}
                                                </span>
                                            </td>
                                            <td className="p-3 text-muted-foreground text-xs max-w-xs truncate">
                                                {source.source_type === 'url' ? source.url : source.file_path}
                                            </td>
                                            <td className="p-3 text-muted-foreground text-xs">
                                                {formatDateTime(source.last_sync)}
                                                {source.sync_status === 'syncing' && (
                                                    <span className="ml-2 inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-yellow-100 text-yellow-800">
                                                        Syncing...
                                                    </span>
                                                )}
                                                {source.sync_status === 'error' && (
                                                    <span className="ml-2 inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-red-100 text-red-800">
                                                        Error
                                                    </span>
                                                )}
                                                {source.sync_status === 'success' && (
                                                    <span className="ml-2 inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-green-100 text-green-800">
                                                        Success
                                                    </span>
                                                )}
                                            </td>
                                            <td className="p-3">
                                                <div className="flex gap-2 justify-end">
                                                    <Button
                                                        onClick={() => resyncSource(source)}
                                                        disabled={loading || syncingId === source.id || source.sync_status === 'syncing'}
                                                        size="sm"
                                                        variant="outline"
                                                        title="Re-import this source now"
                                                    >
                                                        <RefreshCw className={`w-4 h-4 ${syncingId === source.id ? 'animate-spin' : ''}`} />
                                                    </Button>
                                                    <Button
                                                        onClick={() => confirmDelete(source.id, source.name)}
                                                        disabled={loading}
                                                        size="sm"
                                                        variant="destructive"
                                                        title="Delete this source"
                                                    >
                                                        <Trash2 className="w-4 h-4" />
                                                    </Button>
                                                </div>
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}
                </CardContent>
            </Card>

            <ConfirmDialog
                isOpen={!!sourceToDelete}
                onClose={() => setSourceToDelete(null)}
                onConfirm={handleDelete}
                title="Delete M3U Source"
                variant="destructive"
                confirmLabel="Delete source"
                busy={loading}
            >
                <p>
                    Delete <strong>{sourceToDelete?.name}</strong>?
                </p>
                <p className="text-muted-foreground">
                    This removes the source configuration and all files generated from it.
                </p>
            </ConfirmDialog>
        </div>
    );
}
