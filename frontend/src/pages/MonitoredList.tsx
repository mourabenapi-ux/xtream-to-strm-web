import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { Trash2, Eye, EyeOff, Clock, ListFilter, Search, Loader2 } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useToast } from '@/contexts/ToastContext';
import api from '@/lib/api';

interface MonitoredItem {
    id: number;
    subscription_id: number;
    media_type: string;
    media_id: string;
    title: string;
    is_active: boolean;
    last_check: string | null;
    created_at: string;
}

export default function MonitoredList() {
    const toast = useToast();
    const navigate = useNavigate();
    const [items, setItems] = useState<MonitoredItem[]>([]);
    const [loading, setLoading] = useState(true);
    const [itemToDelete, setItemToDelete] = useState<MonitoredItem | null>(null);
    const [search, setSearch] = useState("");
    const [typeFilter, setTypeFilter] = useState<string>("all");
    const [checking, setChecking] = useState(false);

    useEffect(() => {
        fetchItems();
    }, []);

    const fetchItems = async () => {
        setLoading(true);
        try {
            const res = await api.get<MonitoredItem[]>('/downloads/monitored');
            setItems(res.data);
        } catch (error) {
            console.error("Failed to fetch monitored items", error);
        } finally {
            setLoading(false);
        }
    };

    const confirmDelete = (item: MonitoredItem) => {
        setItemToDelete(item);
    };

    const handleDelete = async () => {
        if (!itemToDelete) return;

        try {
            await api.delete(`/downloads/monitored/${itemToDelete.id}`);
            setItems(prev => prev.filter(i => i.id !== itemToDelete.id));
            toast.success('Monitoring stopped', itemToDelete.title);
            setItemToDelete(null);
        } catch (error) {
            console.error("Failed to remove monitored item", error);
            toast.apiError('Failed to remove item', error);
        }
    };

    /**
     * Pauses a watch instead of destroying it. is_active came back from the API
     * but was never shown or editable, so the only way to stop a watch
     * temporarily was to delete it and rebuild it later.
     */
    const toggleActive = async (item: MonitoredItem) => {
        try {
            await api.put(`/downloads/monitored/${item.id}`, { is_active: !item.is_active });
            setItems(prev => prev.map(i => i.id === item.id ? { ...i, is_active: !i.is_active } : i));
            toast.success(item.is_active ? 'Monitoring paused' : 'Monitoring resumed', item.title);
        } catch (error) {
            console.error("Failed to toggle monitored item", error);
            toast.apiError('Failed to update item', error);
        }
    };

    const triggerCheck = async () => {
        setChecking(true);
        try {
            await api.post('/downloads/monitored/check');
            toast.success('Check started', 'New items will appear in the Download Manager.');
            await fetchItems();
        } catch (error) {
            console.error("Failed to trigger check", error);
            toast.apiError('Failed to start check', error);
        } finally {
            setChecking(false);
        }
    };

    const mediaTypes = Array.from(new Set(items.map(i => i.media_type)));
    const visibleItems = items.filter(i => {
        if (typeFilter !== 'all' && i.media_type !== typeFilter) return false;
        const needle = search.trim().toLowerCase();
        return !needle || i.title.toLowerCase().includes(needle);
    });

    return (
        <div className="space-y-6">
            <div className="flex justify-between items-center">
                <div>
                    <h2 className="text-3xl font-bold tracking-tight">Active Surveillance</h2>
                    <p className="text-muted-foreground">Manage categories and series being automatically checked for new content every hour.</p>
                </div>
                <Button onClick={triggerCheck} disabled={checking} className="flex items-center gap-2">
                    {checking ? <Loader2 className="w-4 h-4 animate-spin" /> : <Clock className="w-4 h-4" />}
                    Check for New Items Now
                </Button>
            </div>

            <Card>
                <CardHeader className="space-y-3">
                    <CardTitle className="flex items-center gap-2">
                        <ListFilter className="w-5 h-5 text-blue-500" />
                        Monitored Items
                        <span className="text-sm font-normal text-muted-foreground">
                            ({visibleItems.length}{visibleItems.length !== items.length ? ` of ${items.length}` : ''})
                        </span>
                    </CardTitle>
                    {items.length > 0 && (
                        <div className="flex flex-col sm:flex-row gap-2">
                            <div className="relative flex-1">
                                <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                                <Input
                                    placeholder="Search monitored items…"
                                    className="pl-8 h-9"
                                    value={search}
                                    onChange={(e) => setSearch(e.target.value)}
                                />
                            </div>
                            <select
                                value={typeFilter}
                                onChange={(e) => setTypeFilter(e.target.value)}
                                className="h-9 rounded-md border border-input bg-background px-3 text-sm"
                            >
                                <option value="all">All types</option>
                                {mediaTypes.map(t => (
                                    <option key={t} value={t}>{t.replace('_', ' ')}</option>
                                ))}
                            </select>
                        </div>
                    )}
                </CardHeader>
                <CardContent>
                    {loading ? (
                        <p className="text-center py-8">Loading monitored items...</p>
                    ) : items.length === 0 ? (
                        <div className="text-center py-12 border-2 border-dashed rounded-lg">
                            <Eye className="w-12 h-12 text-muted-foreground/40 mx-auto mb-4" />
                            <h3 className="text-lg font-medium">No items under surveillance</h3>
                            <p className="text-muted-foreground mb-4">
                                Add categories or series to watch from the Media Selection page.
                            </p>
                            <Button variant="outline" onClick={() => navigate('/downloads/selection')}>
                                Go to Media Selection
                            </Button>
                        </div>
                    ) : visibleItems.length === 0 ? (
                        <div className="text-center py-12 text-muted-foreground">
                            No item matches the current filter.
                        </div>
                    ) : (
                        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                            {visibleItems.map(item => (
                                <Card
                                    key={item.id}
                                    className={`overflow-hidden border-l-4 ${item.is_active ? 'border-l-blue-500' : 'border-l-muted opacity-60'}`}
                                >
                                    <CardContent className="p-4">
                                        <div className="flex justify-between items-start mb-2">
                                            <div className="flex items-center gap-2">
                                                <div className="p-1 bg-primary/10 text-primary rounded text-[10px] uppercase font-bold px-2">
                                                    {item.media_type.replace('_', ' ')}
                                                </div>
                                                {!item.is_active && (
                                                    <span className="text-[10px] uppercase font-bold text-muted-foreground">
                                                        Paused
                                                    </span>
                                                )}
                                            </div>
                                            <div className="flex">
                                                <Button
                                                    variant="ghost"
                                                    size="sm"
                                                    type="button"
                                                    onClick={() => toggleActive(item)}
                                                    title={item.is_active ? 'Pause this watch' : 'Resume this watch'}
                                                >
                                                    {item.is_active
                                                        ? <EyeOff className="w-4 h-4" />
                                                        : <Eye className="w-4 h-4" />}
                                                </Button>
                                                <Button
                                                    variant="ghost"
                                                    size="sm"
                                                    type="button"
                                                    onClick={(e) => {
                                                        e.stopPropagation();
                                                        confirmDelete(item);
                                                    }}
                                                    className="text-destructive hover:text-destructive hover:bg-destructive/10"
                                                    title="Stop and remove this watch"
                                                >
                                                    <Trash2 className="w-4 h-4" />
                                                </Button>
                                            </div>
                                        </div>
                                        <h4 className="font-semibold text-lg line-clamp-1 mb-1" title={item.title}>
                                            {item.title}
                                        </h4>
                                        <div className="space-y-1 text-xs text-muted-foreground">
                                            <div className="flex items-center gap-1">
                                                <Clock className="w-3 h-3" />
                                                Created: {new Date(item.created_at).toLocaleDateString()}
                                            </div>
                                            <div className="flex items-center gap-1">
                                                <Eye className="w-3 h-3" />
                                                Last check: {item.last_check ? new Date(item.last_check).toLocaleString() : 'Never'}
                                            </div>
                                        </div>
                                    </CardContent>
                                </Card>
                            ))}
                        </div>
                    )}
                </CardContent>
            </Card>

            <ConfirmDialog
                isOpen={!!itemToDelete}
                onClose={() => setItemToDelete(null)}
                onConfirm={handleDelete}
                title="Stop monitoring"
                variant="destructive"
                confirmLabel="Stop monitoring"
            >
                <p>Stop monitoring <strong>{itemToDelete?.title}</strong>?</p>
                <p className="text-muted-foreground">
                    Automatic downloads stop for this item and it is removed from the list.
                    Files already downloaded are kept. To pause it temporarily instead, use the eye button.
                </p>
            </ConfirmDialog>
        </div>
    );
}
