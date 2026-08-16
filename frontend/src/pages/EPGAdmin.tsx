import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
    Plus, Trash2, RefreshCw, Loader2, Pencil,
    Settings, Globe, FileText, Database, AlertCircle
} from 'lucide-react';
import { Dialog } from "@/components/ui/dialog";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { useToast } from '@/contexts/ToastContext';
import api from '@/lib/api';

interface EPGSourceGlobal {
    id: number;
    name: string;
    source_type: string;
    source_url: string | null;
    file_path: string | null;
    subscription_id: number | null;
    is_active: boolean;
    refresh_interval_hours: number;
    created_at: string;
    last_updated: string | null;
    channel_count: number;
    used_by_playlists_count: number;
}

interface SubscriptionOption {
    id: number;
    name: string;
}

const EMPTY_FORM = {
    name: "",
    source_type: "url",
    source_url: "",
    file_path: "",
    subscription_id: null as number | null,
    refresh_interval_hours: 24
};

// Never render an xtream source's real URL: it carries the provider password.
const describeLocation = (source: EPGSourceGlobal, subs: SubscriptionOption[]): string => {
    if (source.source_type === 'xtream') {
        const sub = subs.find(s => s.id === source.subscription_id);
        return sub ? `Provider guide — ${sub.name}` : "Provider guide — no subscription set";
    }
    return source.source_url || source.file_path || "No location set";
};

export default function EPGAdmin() {
    const toast = useToast();
    const [sources, setSources] = useState<EPGSourceGlobal[]>([]);
    const [loading, setLoading] = useState(true);
    const [isCreateOpen, setIsCreateOpen] = useState(false);
    const [isRefreshing, setIsRefreshing] = useState<Record<number, boolean>>({});
    // null = creating, otherwise the id being edited. There was previously no
    // way to change a source at all: a stale URL meant delete and recreate,
    // which is blocked while any playlist still links to it.
    const [editingId, setEditingId] = useState<number | null>(null);
    const [sourceToDelete, setSourceToDelete] = useState<EPGSourceGlobal | null>(null);
    const [formData, setFormData] = useState(EMPTY_FORM);
    // Needed to offer the provider's own guide, whose URL is derived from a
    // subscription's server and credentials.
    const [subscriptions, setSubscriptions] = useState<SubscriptionOption[]>([]);

    useEffect(() => {
        fetchSources();
        fetchSubscriptions();
    }, []);

    const fetchSubscriptions = async () => {
        try {
            const res = await api.get('/subscriptions/');
            setSubscriptions(res.data.map((s: any) => ({ id: s.id, name: s.name })));
        } catch (error) {
            console.error("Failed to fetch subscriptions", error);
        }
    };

    const fetchSources = async () => {
        setLoading(true);
        try {
            const res = await api.get('/epg-sources');
            setSources(res.data);
        } catch (error) {
            console.error("Failed to fetch EPG sources", error);
            toast.apiError('Could not load EPG sources', error);
        } finally {
            setLoading(false);
        }
    };

    const openCreate = () => {
        setEditingId(null);
        setFormData(EMPTY_FORM);
        setIsCreateOpen(true);
    };

    const openEdit = (source: EPGSourceGlobal) => {
        setEditingId(source.id);
        setFormData({
            name: source.name,
            source_type: source.source_type,
            source_url: source.source_url || "",
            file_path: source.file_path || "",
            subscription_id: source.subscription_id ?? null,
            refresh_interval_hours: source.refresh_interval_hours || 24
        });
        setIsCreateOpen(true);
    };

    const handleSubmit = async () => {
        try {
            if (editingId === null) {
                await api.post('/epg-sources', formData);
                toast.success('EPG source created', formData.name);
            } else {
                await api.put(`/epg-sources/${editingId}`, formData);
                toast.success('EPG source updated', formData.name);
            }
            setIsCreateOpen(false);
            setEditingId(null);
            setFormData(EMPTY_FORM);
            fetchSources();
        } catch (error) {
            console.error("Failed to save EPG source", error);
            toast.apiError('Failed to save EPG source', error);
        }
    };

    const confirmDelete = async () => {
        if (!sourceToDelete) return;
        try {
            await api.delete(`/epg-sources/${sourceToDelete.id}`);
            toast.success('EPG source deleted', sourceToDelete.name);
            fetchSources();
        } catch (error) {
            console.error("Failed to delete EPG source", error);
            toast.apiError('Failed to delete source', error);
        } finally {
            setSourceToDelete(null);
        }
    };

    const handleRefresh = async (id: number, name: string) => {
        setIsRefreshing(prev => ({ ...prev, [id]: true }));
        try {
            const res = await api.post(`/epg-sources/${id}/refresh`);
            // The endpoint now reports what it actually cached, so a source
            // that parsed nothing no longer reads as a successful refresh.
            if (res.data.status === 'empty') {
                toast.warning(`${name}: nothing cached`, res.data.message);
            } else {
                toast.success(`${name} refreshed`, res.data.message);
            }
            fetchSources();
        } catch (error) {
            console.error("Failed to trigger refresh", error);
            toast.apiError('Failed to start refresh', error);
        } finally {
            setIsRefreshing(prev => ({ ...prev, [id]: false }));
        }
    };

    const toggleActive = async (source: EPGSourceGlobal) => {
        try {
            await api.put(`/epg-sources/${source.id}`, {
                is_active: !source.is_active
            });
            toast.success(source.is_active ? 'Source deactivated' : 'Source activated', source.name);
            fetchSources();
        } catch (error) {
            console.error("Failed to update source", error);
            toast.apiError('Failed to update source', error);
        }
    };

    return (
        <div className="p-6 max-w-6xl mx-auto space-y-6">
            <div className="flex justify-between items-center">
                <div>
                    <h1 className="text-3xl font-bold tracking-tight">EPG Administration</h1>
                    <p className="text-muted-foreground">Manage centralized EPG sources for all your playlists.</p>
                </div>
                <Button onClick={openCreate} className="gap-2">
                    <Plus className="h-4 w-4" /> Add Global Source
                </Button>
            </div>

            {loading ? (
                <div className="flex justify-center py-20">
                    <Loader2 className="h-10 w-10 animate-spin text-primary" />
                </div>
            ) : (
                <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
                    {sources.map(source => (
                        <Card key={source.id} className={`${!source.is_active ? 'opacity-60' : ''} transition-opacity`}>
                            <CardHeader className="pb-3">
                                <div className="flex justify-between items-start">
                                    <div className="space-y-1">
                                        <CardTitle className="flex items-center gap-2">
                                            {source.source_type === 'xtream'
                                                ? <Database className="h-4 w-4 text-emerald-500" />
                                                : source.source_type === 'url'
                                                    ? <Globe className="h-4 w-4 text-blue-500" />
                                                    : <FileText className="h-4 w-4 text-orange-500" />}
                                            {source.name}
                                        </CardTitle>
                                        <CardDescription className="truncate max-w-[200px]" title={describeLocation(source, subscriptions)}>
                                            {describeLocation(source, subscriptions)}
                                        </CardDescription>
                                    </div>
                                    <div className={`px-2 py-1 rounded-full text-xs font-semibold ${source.is_active ? 'bg-primary/20 text-primary' : 'bg-muted text-muted-foreground'}`}>
                                        {source.is_active ? "Active" : "Inactive"}
                                    </div>
                                </div>
                            </CardHeader>
                            <CardContent className="space-y-4">
                                <div className="grid grid-cols-2 gap-2 text-sm">
                                    <div className="flex flex-col">
                                        <span className="text-muted-foreground">Channels</span>
                                        <span className="font-medium flex items-center gap-1">
                                            <Database className="h-3 w-3" /> {source.channel_count.toLocaleString()}
                                        </span>
                                    </div>
                                    <div className="flex flex-col">
                                        <span className="text-muted-foreground">Used by</span>
                                        <span className="font-medium">{source.used_by_playlists_count} playlists</span>
                                    </div>
                                    <div className="flex flex-col col-span-2 mt-1">
                                        <span className="text-muted-foreground">Last Updated</span>
                                        <span className="font-medium">
                                            {source.last_updated ? new Date(source.last_updated).toLocaleString() : "Never"}
                                        </span>
                                    </div>
                                    <div className="flex flex-col col-span-2">
                                        <span className="text-muted-foreground">Refresh every</span>
                                        <span className="font-medium">{source.refresh_interval_hours}h</span>
                                    </div>
                                </div>

                                <div className="flex flex-wrap gap-2 pt-2">
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        className="flex-1 gap-2"
                                        onClick={() => handleRefresh(source.id, source.name)}
                                        disabled={isRefreshing[source.id]}
                                    >
                                        {isRefreshing[source.id] ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
                                        Refresh
                                    </Button>
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        className="gap-2"
                                        onClick={() => openEdit(source)}
                                        title="Edit this source"
                                    >
                                        <Pencil className="h-3 w-3" />
                                        Edit
                                    </Button>
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        className="gap-2"
                                        onClick={() => toggleActive(source)}
                                    >
                                        <Settings className="h-3 w-3" />
                                        {source.is_active ? "Deactivate" : "Activate"}
                                    </Button>
                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        className="px-2 text-destructive hover:text-destructive hover:bg-destructive/10"
                                        onClick={() => setSourceToDelete(source)}
                                    >
                                        <Trash2 className="h-4 w-4" />
                                    </Button>
                                </div>
                            </CardContent>
                        </Card>
                    ))}

                    {sources.length === 0 && (
                        <div className="col-span-full flex flex-col items-center justify-center py-20 bg-accent/20 rounded-lg border-2 border-dashed">
                            <AlertCircle className="h-10 w-10 text-muted-foreground mb-4" />
                            <h3 className="text-lg font-medium">No EPG sources found</h3>
                            <p className="text-sm text-muted-foreground px-10 text-center">
                                Add your first global EPG source to make it available for your playlists.
                            </p>
                            <Button className="mt-4" onClick={openCreate}>
                                <Plus className="h-4 w-4 mr-2" /> Add Global Source
                            </Button>
                        </div>
                    )}
                </div>
            )}

            {/* Create Dialog */}
            <ConfirmDialog
                isOpen={!!sourceToDelete}
                onClose={() => setSourceToDelete(null)}
                onConfirm={confirmDelete}
                title="Delete EPG source"
                variant="destructive"
                confirmLabel="Delete source"
            >
                <p>
                    Delete <strong>{sourceToDelete?.name}</strong>?
                </p>
                <p className="text-muted-foreground">
                    {sourceToDelete && sourceToDelete.used_by_playlists_count > 0
                        ? `This source is still linked to ${sourceToDelete.used_by_playlists_count} playlist(s); unlink it there first or the delete will be refused.`
                        : 'It is not linked to any playlist, so it can be removed safely.'}
                </p>
            </ConfirmDialog>

            <Dialog
                isOpen={isCreateOpen}
                onClose={() => setIsCreateOpen(false)}
                title={editingId === null ? "Add Global EPG Source" : "Edit EPG Source"}
            >
                <div className="space-y-4">
                    <p className="text-sm text-muted-foreground">
                        A reusable EPG source: your provider's own guide, a remote URL, or a local file.
                    </p>
                    <div className="space-y-2">
                        <label className="text-sm font-medium">Source Name</label>
                        <Input
                            placeholder="e.g. My Premium EPG"
                            value={formData.name}
                            onChange={e => setFormData({ ...formData, name: e.target.value })}
                        />
                    </div>
                    <div className="space-y-2">
                        <label className="text-sm font-medium">Source Type</label>
                        <select
                            className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                            value={formData.source_type}
                            onChange={e => setFormData({ ...formData, source_type: e.target.value })}
                        >
                            <option value="xtream">Provider guide (Xtream XMLTV)</option>
                            <option value="url">Remote URL (XMLTV)</option>
                            <option value="file">Local File Path</option>
                        </select>
                    </div>
                    {formData.source_type === 'xtream' && (
                        <div className="space-y-2">
                            <label className="text-sm font-medium">Subscription</label>
                            <select
                                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                                value={formData.subscription_id ?? ""}
                                onChange={e => setFormData({
                                    ...formData,
                                    subscription_id: e.target.value ? parseInt(e.target.value) : null
                                })}
                            >
                                <option value="">Select a subscription…</option>
                                {subscriptions.map(s => (
                                    <option key={s.id} value={s.id}>{s.name}</option>
                                ))}
                            </select>
                            <p className="text-xs text-muted-foreground">
                                Reads this provider's own <code>xmltv.php</code>. Its channel ids match
                                your streams exactly, so channels map without any name guessing.
                            </p>
                        </div>
                    )}
                    {formData.source_type === 'url' && (
                        <div className="space-y-2">
                            <label className="text-sm font-medium">URL</label>
                            <Input
                                placeholder="http://example.com/guide.xml"
                                value={formData.source_url}
                                onChange={e => setFormData({ ...formData, source_url: e.target.value })}
                            />
                        </div>
                    )}
                    {formData.source_type === 'file' && (
                        <div className="space-y-2">
                            <label className="text-sm font-medium">File Path</label>
                            <Input
                                placeholder="/path/to/epg.xml"
                                value={formData.file_path}
                                onChange={e => setFormData({ ...formData, file_path: e.target.value })}
                            />
                        </div>
                    )}
                    <div className="space-y-2">
                        <label className="text-sm font-medium">Refresh Interval (Hours)</label>
                        <Input
                            type="number"
                            placeholder="24"
                            value={formData.refresh_interval_hours}
                            onChange={e => setFormData({ ...formData, refresh_interval_hours: parseInt(e.target.value) || 24 })}
                        />
                    </div>
                    <div className="flex justify-end gap-2 pt-4">
                        <Button variant="outline" onClick={() => setIsCreateOpen(false)}>Cancel</Button>
                        <Button
                            onClick={handleSubmit}
                            disabled={
                                !formData.name
                                // Each type has its own requirement; the old check
                                // accepted an xtream source with nothing filled in.
                                || (formData.source_type === 'url' && !formData.source_url)
                                || (formData.source_type === 'file' && !formData.file_path)
                                || (formData.source_type === 'xtream' && !formData.subscription_id)
                            }
                        >
                            {editingId === null ? 'Create Source' : 'Save Changes'}
                        </Button>
                    </div>
                </div>
            </Dialog>
        </div>
    );
}
