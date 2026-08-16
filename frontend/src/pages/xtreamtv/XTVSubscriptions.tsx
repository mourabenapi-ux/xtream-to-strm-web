import React, { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { Plus, Edit, Trash2, Save, X, Check, Eye, EyeOff } from 'lucide-react';
import { useToast } from '@/contexts/ToastContext';
import api from '@/lib/api';

interface Subscription {
    id: number;
    name: string;
    xtream_url: string;
    username: string;
    password: string;
    movies_dir: string;
    series_dir: string;
    download_movies_dir: string;
    download_series_dir: string;
    max_parallel_downloads: number;
    download_segments: number;
    is_active: boolean;
}

interface SubscriptionForm {
    name: string;
    xtream_url: string;
    username: string;
    password: string;
    movies_dir: string;
    series_dir: string;
    download_movies_dir: string;
    download_series_dir: string;
    max_parallel_downloads: number;
    download_segments: number;
    is_active: boolean;
}



export default function XTVSubscriptions() {
    const toast = useToast();
    const [subscriptions, setSubscriptions] = useState<Subscription[]>([]);
    const [loading, setLoading] = useState(false);
    const [editingId, setEditingId] = useState<number | null>(null);
    const [isAdding, setIsAdding] = useState(false);
    const [subToDelete, setSubToDelete] = useState<Subscription | null>(null);
    const [showPassword, setShowPassword] = useState(false);
    const [formError, setFormError] = useState<string | null>(null);
    const [formData, setFormData] = useState<SubscriptionForm>({
        name: '',
        xtream_url: '',
        username: '',
        password: '',
        movies_dir: '/output/movies',
        series_dir: '/output/series',
        download_movies_dir: '/output/downloads/movies',
        download_series_dir: '/output/downloads/series',
        max_parallel_downloads: 2,
        download_segments: 1,
        is_active: true
    });

    const fetchData = async () => {
        try {
            const subsRes = await api.get<Subscription[]>('/subscriptions/');
            setSubscriptions(subsRes.data);
        } catch (error) {
            console.error("Failed to fetch data", error);
            toast.apiError('Could not load subscriptions', error);
        }
    };

    /** Nothing validated the form before, so an all-blank row could be saved. */
    const validate = (): string | null => {
        if (!formData.name.trim()) return 'Name is required.';
        if (!formData.xtream_url.trim()) return 'Xtream URL is required.';
        if (!/^https?:\/\//i.test(formData.xtream_url.trim())) {
            return 'Xtream URL must start with http:// or https://';
        }
        if (!formData.username.trim()) return 'Username is required.';
        if (!formData.password) return 'Password is required.';
        if (Number(formData.max_parallel_downloads) < 1) return 'Parallel downloads must be at least 1.';
        if (Number(formData.download_segments) < 1) return 'Segments must be at least 1.';
        return null;
    };

    useEffect(() => {
        fetchData();
    }, []);

    const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const { name, value, type, checked } = e.target;
        setFormData(prev => ({
            ...prev,
            [name]: type === 'checkbox' ? checked : value
        }));
    };

    const startAdd = () => {
        setFormData({
            name: '',
            xtream_url: '',
            username: '',
            password: '',
            movies_dir: '/output/movies',
            series_dir: '/output/series',
            download_movies_dir: '/output/downloads/movies',
            download_series_dir: '/output/downloads/series',
            max_parallel_downloads: 2,
            download_segments: 1,
            is_active: true
        });
        setIsAdding(true);
        setEditingId(null);
    };

    const startEdit = (sub: Subscription) => {
        setFormData({
            name: sub.name,
            xtream_url: sub.xtream_url,
            username: sub.username,
            password: sub.password,
            movies_dir: sub.movies_dir,
            series_dir: sub.series_dir,
            download_movies_dir: sub.download_movies_dir || '/output/downloads/movies',
            download_series_dir: sub.download_series_dir || '/output/downloads/series',
            max_parallel_downloads: sub.max_parallel_downloads || 2,
            download_segments: sub.download_segments || 1,
            is_active: sub.is_active
        });
        setEditingId(sub.id);
        setIsAdding(false);
    };

    const cancelEdit = () => {
        setEditingId(null);
        setIsAdding(false);
        setFormError(null);
        setShowPassword(false);
        setFormData({
            name: '',
            xtream_url: '',
            username: '',
            password: '',
            movies_dir: '/output/movies',
            series_dir: '/output/series',
            download_movies_dir: '/output/downloads/movies',
            download_series_dir: '/output/downloads/series',
            max_parallel_downloads: 2,
            download_segments: 1,
            is_active: true
        });
    };

    const handleSave = async () => {
        const problem = validate();
        if (problem) {
            setFormError(problem);
            toast.warning('Check the form', problem);
            return;
        }
        setFormError(null);
        setLoading(true);
        try {
            if (isAdding) {
                await api.post('/subscriptions/', formData);
                toast.success('Subscription added', formData.name);
            } else if (editingId) {
                await api.put(`/subscriptions/${editingId}`, formData);
                toast.success('Subscription updated', formData.name);
            }
            await fetchData();
            cancelEdit();
        } catch (error) {
            console.error("Failed to save subscription", error);
            toast.apiError('Failed to save subscription', error);
        } finally {
            setLoading(false);
        }
    };

    const confirmDelete = (sub: Subscription) => {
        setSubToDelete(sub);
    };

    const handleDelete = async () => {
        if (!subToDelete) return;

        setLoading(true);
        try {
            await api.delete(`/subscriptions/${subToDelete.id}`);
            toast.success('Subscription deleted', subToDelete.name);
            await fetchData();
            setSubToDelete(null);
        } catch (error) {
            console.error("Failed to delete subscription", error);
            toast.apiError('Failed to delete subscription', error);
        } finally {
            setLoading(false);
        }
    };

    const toggleActive = async (sub: Subscription) => {
        setLoading(true);
        try {
            await api.put(`/subscriptions/${sub.id}`, {
                is_active: !sub.is_active
            });
            toast.success(sub.is_active ? 'Subscription disabled' : 'Subscription enabled', sub.name);
            await fetchData();
        } catch (error) {
            console.error("Failed to toggle subscription", error);
            toast.apiError('Failed to update subscription', error);
        } finally {
            setLoading(false);
        }
    };



    return (
        <div className="space-y-8">
            <div>
                <h2 className="text-3xl font-bold tracking-tight">XtreamTV Subscriptions</h2>
                <p className="text-muted-foreground">Manage your Xtream Codes subscriptions and synchronization.</p>
            </div>

            {/* Subscription Management Table */}
            <Card>
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-4">
                    <CardTitle>Configuration</CardTitle>
                    <Button onClick={startAdd} disabled={isAdding || editingId !== null || loading} size="sm">
                        <Plus className="w-4 h-4 mr-2" />
                        Add Subscription
                    </Button>
                </CardHeader>
                <CardContent>
                    {formError && (
                        <div className="mb-4 bg-destructive/10 text-destructive border border-destructive/20 px-4 py-2 rounded-md text-sm">
                            {formError}
                        </div>
                    )}
                    {/* Six columns of inputs overflowed the viewport with no way
                        to reach them; the table now scrolls inside its own box. */}
                    <div className="border rounded-md overflow-x-auto">
                        <table className="w-full text-sm min-w-[900px]">
                            <thead className="bg-muted/50 text-muted-foreground">
                                <tr>
                                    <th className="p-3 text-left">Subscription Detail</th>
                                    <th className="p-3 text-left">STRM Directories</th>
                                    <th className="p-3 text-left">Download Directories</th>
                                    <th className="p-3 text-center">Limits (Paral/Seg)</th>
                                    <th className="p-3 text-center">Active</th>
                                    <th className="p-3 text-right">Actions</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y">
                                {isAdding && (
                                    <tr className="bg-accent/50">
                                        <td className="p-2 space-y-1">
                                            <Input name="name" value={formData.name} onChange={handleInputChange} placeholder="Name" className="h-8" />
                                            <Input name="xtream_url" value={formData.xtream_url} onChange={handleInputChange} placeholder="URL" className="h-8" />
                                            <div className="flex gap-1">
                                                <Input name="username" value={formData.username} onChange={handleInputChange} placeholder="User" className="h-8" />
                                                <div className="relative flex-1">
                                                    <Input
                                                        name="password"
                                                        type={showPassword ? 'text' : 'password'}
                                                        value={formData.password}
                                                        onChange={handleInputChange}
                                                        placeholder="Pass"
                                                        className="h-8 pr-8"
                                                    />
                                                    <button
                                                        type="button"
                                                        onClick={() => setShowPassword(!showPassword)}
                                                        className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                                                        title={showPassword ? 'Hide password' : 'Show password'}
                                                    >
                                                        {showPassword ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                                                    </button>
                                                </div>
                                            </div>
                                        </td>
                                        <td className="p-2 space-y-1">
                                            <Input name="movies_dir" value={formData.movies_dir} onChange={handleInputChange} placeholder="Movies STRM" className="h-8" />
                                            <Input name="series_dir" value={formData.series_dir} onChange={handleInputChange} placeholder="Series STRM" className="h-8" />
                                        </td>
                                        <td className="p-2 space-y-1">
                                            <Input name="download_movies_dir" value={formData.download_movies_dir} onChange={handleInputChange} placeholder="Movies Download" className="h-8" />
                                            <Input name="download_series_dir" value={formData.download_series_dir} onChange={handleInputChange} placeholder="Series Download" className="h-8" />
                                        </td>
                                        <td className="p-2">
                                            <div className="flex gap-1">
                                                <Input name="max_parallel_downloads" type="number" value={formData.max_parallel_downloads} onChange={handleInputChange} className="h-8 w-16" />
                                                <Input name="download_segments" type="number" value={formData.download_segments} onChange={handleInputChange} className="h-8 w-16" />
                                            </div>
                                        </td>
                                        <td className="p-2 text-center">
                                            <input type="checkbox" name="is_active" checked={formData.is_active} onChange={handleInputChange} className="w-4 h-4" />
                                        </td>
                                        <td className="p-2">
                                            <div className="flex gap-2 justify-end">
                                                <Button onClick={handleSave} disabled={loading} size="sm" variant="default"><Save className="w-4 h-4" /></Button>
                                                <Button onClick={cancelEdit} disabled={loading} size="sm" variant="outline"><X className="w-4 h-4" /></Button>
                                            </div>
                                        </td>
                                    </tr>
                                )}
                                {subscriptions.map(sub => (
                                    editingId === sub.id ? (
                                        <tr key={sub.id} className="bg-accent/50">
                                            <td className="p-2 space-y-1">
                                                <Input name="name" value={formData.name} onChange={handleInputChange} className="h-8" />
                                                <Input name="xtream_url" value={formData.xtream_url} onChange={handleInputChange} className="h-8" />
                                                <div className="flex gap-1">
                                                    <Input name="username" value={formData.username} onChange={handleInputChange} className="h-8" />
                                                    <div className="relative flex-1">
                                                        <Input
                                                            name="password"
                                                            type={showPassword ? 'text' : 'password'}
                                                            value={formData.password}
                                                            onChange={handleInputChange}
                                                            className="h-8 pr-8"
                                                        />
                                                        <button
                                                            type="button"
                                                            onClick={() => setShowPassword(!showPassword)}
                                                            className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                                                            title={showPassword ? 'Hide password' : 'Show password'}
                                                        >
                                                            {showPassword ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                                                        </button>
                                                    </div>
                                                </div>
                                            </td>
                                            <td className="p-2 space-y-1">
                                                <Input name="movies_dir" value={formData.movies_dir} onChange={handleInputChange} className="h-8" />
                                                <Input name="series_dir" value={formData.series_dir} onChange={handleInputChange} className="h-8" />
                                            </td>
                                            <td className="p-2 space-y-1">
                                                <Input name="download_movies_dir" value={formData.download_movies_dir} onChange={handleInputChange} className="h-8" />
                                                <Input name="download_series_dir" value={formData.download_series_dir} onChange={handleInputChange} className="h-8" />
                                            </td>
                                            <td className="p-2">
                                                <div className="flex gap-1">
                                                    <Input name="max_parallel_downloads" type="number" value={formData.max_parallel_downloads} onChange={handleInputChange} className="h-8 w-16" />
                                                    <Input name="download_segments" type="number" value={formData.download_segments} onChange={handleInputChange} className="h-8 w-16" />
                                                </div>
                                            </td>
                                            <td className="p-2 text-center">
                                                <input type="checkbox" name="is_active" checked={formData.is_active} onChange={handleInputChange} className="w-4 h-4" />
                                            </td>
                                            <td className="p-2">
                                                <div className="flex gap-2 justify-end">
                                                    <Button onClick={handleSave} disabled={loading} size="sm" variant="default"><Save className="w-4 h-4" /></Button>
                                                    <Button onClick={cancelEdit} disabled={loading} size="sm" variant="outline"><X className="w-4 h-4" /></Button>
                                                </div>
                                            </td>
                                        </tr>
                                    ) : (
                                        <tr key={sub.id} className="hover:bg-muted/50 transition-colors">
                                            <td className="p-3">
                                                <div className="font-bold">{sub.name}</div>
                                                <div className="text-xs text-muted-foreground truncate max-w-[200px]">{sub.xtream_url}</div>
                                                <div className="text-xs text-muted-foreground">{sub.username}</div>
                                            </td>
                                            <td className="p-3 text-xs">
                                                <div>Movies: {sub.movies_dir}</div>
                                                <div>Series: {sub.series_dir}</div>
                                            </td>
                                            <td className="p-3 text-xs">
                                                <div>Movies: {sub.download_movies_dir}</div>
                                                <div>Series: {sub.download_series_dir}</div>
                                            </td>
                                            <td className="p-3 text-center text-xs">
                                                {sub.max_parallel_downloads || 2} / {sub.download_segments || 1}
                                            </td>
                                            <td className="p-3 text-center">
                                                <button
                                                    onClick={() => toggleActive(sub)}
                                                    disabled={loading}
                                                    className={`w-5 h-5 rounded flex items-center justify-center ${sub.is_active ? 'bg-green-500 text-white' : 'bg-gray-300'
                                                        }`}
                                                >
                                                    {sub.is_active && <Check className="w-3 h-3" />}
                                                </button>
                                            </td>
                                            <td className="p-3">
                                                <div className="flex gap-2 justify-end">
                                                    <Button
                                                        onClick={() => startEdit(sub)}
                                                        disabled={loading || isAdding || editingId !== null}
                                                        size="sm"
                                                        variant="outline"
                                                    >
                                                        <Edit className="w-4 h-4" />
                                                    </Button>
                                                    <Button
                                                        onClick={() => confirmDelete(sub)}
                                                        disabled={loading || isAdding || editingId !== null}
                                                        size="sm"
                                                        variant="destructive"
                                                    >
                                                        <Trash2 className="w-4 h-4" />
                                                    </Button>
                                                </div>
                                            </td>
                                        </tr>
                                    )
                                ))}
                                {subscriptions.length === 0 && !isAdding && (
                                    <tr>
                                        <td colSpan={6} className="p-8 text-center text-muted-foreground">
                                            No subscriptions configured. Click "Add Subscription" to get started.
                                        </td>
                                    </tr>
                                )}
                            </tbody>
                        </table>
                    </div>
                </CardContent>
            </Card>

            <ConfirmDialog
                isOpen={!!subToDelete}
                onClose={() => setSubToDelete(null)}
                onConfirm={handleDelete}
                title="Delete Subscription"
                variant="destructive"
                confirmLabel="Delete subscription"
                busy={loading}
            >
                <p>
                    Delete <strong>{subToDelete?.name}</strong>?
                </p>
                <p className="text-muted-foreground">
                    Its category selections, schedules and sync history are removed. Files already
                    generated on disk are kept.
                </p>
            </ConfirmDialog>
        </div >
    );
}
