import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Plus, Trash2, Edit3, Loader2, Radio, Tv, Globe, Activity, Copy, Check } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useToast } from '@/contexts/ToastContext';
import api from '@/lib/api';

interface LivePlaylist {
    id: number;
    subscription_id: number;
    name: string;
    description: string;
    created_at: string;
}

// Same shape the dashboard already consumes: channel counts and EPG coverage
// live here, so the dedicated page no longer says less than the home page.
interface PlaylistStats {
    id: number;
    channel_count: number;
    epg_coverage: number;
    epg_sources_count: number;
    m3u_url: string;
    epg_url: string;
}

export default function LivePlaylists() {
    const toast = useToast();
    const [playlists, setPlaylists] = useState<LivePlaylist[]>([]);
    const [stats, setStats] = useState<Record<number, PlaylistStats>>({});
    const [loading, setLoading] = useState(true);
    const [creating, setCreating] = useState(false);
    const [newPlaylistName, setNewPlaylistName] = useState("");
    const [newPlaylistDescription, setNewPlaylistDescription] = useState("");
    const [playlistToDelete, setPlaylistToDelete] = useState<LivePlaylist | null>(null);
    const [copiedId, setCopiedId] = useState<string | null>(null);
    const navigate = useNavigate();

    useEffect(() => {
        fetchPlaylists();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const fetchPlaylists = async () => {
        setLoading(true);
        try {
            const [listRes, statsRes] = await Promise.all([
                api.get<LivePlaylist[]>('/live/playlists'),
                api.get<PlaylistStats[]>('/dashboard/live-playlists-detail'),
            ]);
            setPlaylists(listRes.data);
            setStats(Object.fromEntries(statsRes.data.map(s => [s.id, s])));
        } catch (error) {
            console.error("Failed to fetch playlists", error);
            toast.apiError('Could not load playlists', error);
        } finally {
            setLoading(false);
        }
    };

    const createPlaylist = async () => {
        if (!newPlaylistName.trim()) return;
        setCreating(true);
        try {
            await api.post<LivePlaylist>('/live/playlists', {
                subscription_id: null,
                name: newPlaylistName.trim(),
                // Was hardcoded to a French string in an English UI, with no
                // way to change it from the interface.
                description: newPlaylistDescription.trim() || null,
            });
            setNewPlaylistName("");
            setNewPlaylistDescription("");
            toast.success('Playlist created', newPlaylistName.trim());
            await fetchPlaylists();
        } catch (error) {
            console.error("Failed to create playlist", error);
            toast.apiError('Failed to create playlist', error);
        } finally {
            setCreating(false);
        }
    };

    const confirmDeletePlaylist = async () => {
        if (!playlistToDelete) return;
        try {
            await api.delete(`/live/playlists/${playlistToDelete.id}`);
            setPlaylists(prev => prev.filter(p => p.id !== playlistToDelete.id));
            toast.success('Playlist deleted', playlistToDelete.name);
        } catch (error) {
            console.error("Failed to delete playlist", error);
            toast.apiError('Failed to delete playlist', error);
        } finally {
            setPlaylistToDelete(null);
        }
    };

    const copyUrl = (path: string, id: string) => {
        navigator.clipboard.writeText(`${window.location.origin}${path}`);
        setCopiedId(id);
        setTimeout(() => setCopiedId(null), 2000);
    };

    return (
        <div className="space-y-6">
            <div>
                <h2 className="text-3xl font-bold tracking-tight">Live Playlists</h2>
                <p className="text-muted-foreground">Manage your custom Live TV configurations</p>
            </div>

            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                <Card className="border-dashed flex flex-col items-center justify-center p-6 text-center">
                    <Radio className="h-10 w-10 text-muted-foreground mb-4" />
                    <CardTitle className="mb-2 text-lg">Create Playlist</CardTitle>
                    <CardDescription className="mb-4">Multiple configurations per subscription</CardDescription>
                    <div className="w-full space-y-2">
                        <Input
                            placeholder="Playlist name"
                            value={newPlaylistName}
                            onChange={(e) => setNewPlaylistName(e.target.value)}
                            onKeyDown={(e) => e.key === 'Enter' && createPlaylist()}
                        />
                        <Input
                            placeholder="Description (optional)"
                            value={newPlaylistDescription}
                            onChange={(e) => setNewPlaylistDescription(e.target.value)}
                            onKeyDown={(e) => e.key === 'Enter' && createPlaylist()}
                        />
                        <Button
                            className="w-full"
                            onClick={createPlaylist}
                            disabled={creating || !newPlaylistName.trim()}
                        >
                            {creating
                                ? <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                                : <Plus className="h-4 w-4 mr-2" />}
                            Create
                        </Button>
                    </div>
                </Card>

                {loading ? (
                    <div className="col-span-full flex justify-center py-10">
                        <Loader2 className="h-8 w-8 animate-spin text-primary" />
                    </div>
                ) : (
                    playlists.map((playlist: LivePlaylist) => {
                        const stat = stats[playlist.id];
                        return (
                            <Card key={playlist.id} className="flex flex-col">
                                <CardHeader className="pb-3">
                                    <CardTitle className="truncate" title={playlist.name}>{playlist.name}</CardTitle>
                                    <CardDescription>{playlist.description || "No description"}</CardDescription>
                                </CardHeader>
                                <CardContent className="flex-1 flex flex-col gap-3 pt-0">
                                    {stat && (
                                        <>
                                            <div className="flex items-center gap-3 text-xs text-muted-foreground border-y py-2">
                                                <span className="flex items-center gap-1">
                                                    <Tv className="h-3.5 w-3.5" /> {stat.channel_count}
                                                </span>
                                                <span className="flex items-center gap-1">
                                                    <Globe className="h-3.5 w-3.5" /> {stat.epg_sources_count} EPG
                                                </span>
                                                <span className={`font-bold ml-auto ${stat.epg_coverage > 90 ? 'text-emerald-500' : 'text-amber-500'}`}>
                                                    {stat.epg_coverage}% mapped
                                                </span>
                                            </div>
                                            <div className="flex gap-2">
                                                <Button
                                                    variant="ghost"
                                                    size="sm"
                                                    className="flex-1 h-7 text-[11px] justify-start gap-1.5"
                                                    onClick={() => copyUrl(stat.m3u_url, `${playlist.id}-m3u`)}
                                                >
                                                    {copiedId === `${playlist.id}-m3u`
                                                        ? <Check className="h-3 w-3 text-emerald-500" />
                                                        : <Copy className="h-3 w-3" />}
                                                    Copy M3U
                                                </Button>
                                                <Button
                                                    variant="ghost"
                                                    size="sm"
                                                    className="flex-1 h-7 text-[11px] justify-start gap-1.5"
                                                    onClick={() => copyUrl(stat.epg_url, `${playlist.id}-epg`)}
                                                >
                                                    {copiedId === `${playlist.id}-epg`
                                                        ? <Check className="h-3 w-3 text-emerald-500" />
                                                        : <Copy className="h-3 w-3" />}
                                                    Copy EPG
                                                </Button>
                                            </div>
                                        </>
                                    )}

                                    <div className="mt-auto flex gap-2">
                                        <Button
                                            className="flex-1"
                                            variant="secondary"
                                            onClick={() => navigate(`/live-selection?playlist_id=${playlist.id}`)}
                                        >
                                            <Edit3 className="mr-2 h-4 w-4" />
                                            Configure
                                        </Button>
                                        {/* EPG configuration used to be reachable only from a small
                                            button buried inside the 4-column editor. */}
                                        <Button
                                            variant="outline"
                                            onClick={() => navigate(`/live-epg?playlist_id=${playlist.id}`)}
                                            title="Manage EPG sources for this playlist"
                                        >
                                            <Activity className="h-4 w-4" />
                                        </Button>
                                        <Button
                                            variant="destructive"
                                            size="icon"
                                            onClick={() => setPlaylistToDelete(playlist)}
                                            title="Delete this playlist"
                                        >
                                            <Trash2 className="h-4 w-4" />
                                        </Button>
                                    </div>
                                </CardContent>
                            </Card>
                        );
                    })
                )}
            </div>

            <ConfirmDialog
                isOpen={!!playlistToDelete}
                onClose={() => setPlaylistToDelete(null)}
                onConfirm={confirmDeletePlaylist}
                title="Delete playlist"
                variant="destructive"
                confirmLabel="Delete playlist"
            >
                <p>
                    Delete <strong>{playlistToDelete?.name}</strong>
                    {playlistToDelete && stats[playlistToDelete.id]
                        ? ` and its ${stats[playlistToDelete.id].channel_count} channel(s)`
                        : ''}?
                </p>
                <p className="text-muted-foreground">
                    Its groups, channel order, renames and EPG mappings are removed. The M3U and EPG
                    URLs for this playlist will stop working.
                </p>
            </ConfirmDialog>
        </div>
    );
}
