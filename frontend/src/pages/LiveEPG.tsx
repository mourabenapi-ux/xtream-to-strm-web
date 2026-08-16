import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
    Plus, Trash2, RefreshCw, Loader2, ArrowLeft,
    Settings, ExternalLink, Activity, Zap, Globe, FileText
} from 'lucide-react';
import { useSearchParams, useNavigate } from 'react-router-dom';
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
    last_updated: string | null;
    channel_count: number;
}

interface PlaylistEPGLink {
    id: number;
    playlist_id: number;
    epg_source_id: number;
    priority: number;
    epg_source: EPGSourceGlobal;
}

export default function LiveEPG() {
    const toast = useToast();
    const [searchParams] = useSearchParams();
    const navigate = useNavigate();
    const playlistId = searchParams.get('playlist_id');

    const [links, setLinks] = useState<PlaylistEPGLink[]>([]);
    const [globalSources, setGlobalSources] = useState<EPGSourceGlobal[]>([]);
    const [loading, setLoading] = useState(true);
    const [isLinkOpen, setIsLinkOpen] = useState(false);
    const [matching, setMatching] = useState(false);

    const [selectedGlobalId, setSelectedGlobalId] = useState<string>("");
    const [playlists, setPlaylists] = useState<any[]>([]);
    // Priority edits are held locally and pushed once the user stops typing.
    const [priorityDraft, setPriorityDraft] = useState<Record<number, string>>({});
    const [linkToUnlink, setLinkToUnlink] = useState<PlaylistEPGLink | null>(null);

    useEffect(() => {
        if (!playlistId) {
            fetchPlaylists();
        } else {
            fetchLinks();
            fetchGlobalSources();
        }
    }, [playlistId]);

    const fetchPlaylists = async () => {
        setLoading(true);
        try {
            // One flat call instead of a serial request per subscription.
            const plRes = await api.get('/live/playlists');
            setPlaylists(plRes.data);
        } catch (error) {
            console.error("Failed to fetch playlists", error);
            toast.apiError('Could not load playlists', error);
        } finally {
            setLoading(false);
        }
    };

    const fetchLinks = async () => {
        if (!playlistId) return;
        setLoading(true);
        try {
            const res = await api.get<PlaylistEPGLink[]>(`/live/playlists/${playlistId}/epg-sources`);
            setLinks(res.data);
        } catch (error) {
            console.error("Failed to fetch EPG links", error);
        } finally {
            setLoading(false);
        }
    };

    const fetchGlobalSources = async () => {
        try {
            const res = await api.get<EPGSourceGlobal[]>('/epg-sources');
            setGlobalSources(res.data);
        } catch (error) {
            console.error("Failed to fetch global EPG sources", error);
        }
    };

    const linkSource = async () => {
        if (!playlistId || !selectedGlobalId) return;
        try {
            await api.post(`/live/playlists/${playlistId}/epg-sources`, {
                epg_source_id: Number(selectedGlobalId),
                priority: links.length
            });
            setIsLinkOpen(false);
            setSelectedGlobalId("");
            toast.success('EPG source linked');
            fetchLinks();
        } catch (error) {
            console.error("Failed to link EPG source", error);
            toast.apiError('Failed to link EPG source', error);
        }
    };

    const confirmUnlink = async () => {
        if (!linkToUnlink) return;
        try {
            await api.delete(`/live/epg-sources/links/${linkToUnlink.id}`);
            toast.success('EPG source unlinked', linkToUnlink.epg_source.name);
            fetchLinks();
        } catch (error) {
            console.error("Failed to unlink EPG source", error);
            toast.apiError('Failed to unlink EPG source', error);
        } finally {
            setLinkToUnlink(null);
        }
    };

    /**
     * Commits a priority edit on blur or Enter rather than on every keystroke.
     * Typing "12" used to PUT 1 and then 12, and clearing the field sent
     * priority 0 because parseInt of an empty string is NaN.
     */
    const commitPriority = async (link: PlaylistEPGLink) => {
        const raw = priorityDraft[link.id];
        if (raw === undefined) return;

        const clearDraft = () => setPriorityDraft(prev => {
            const next = { ...prev };
            delete next[link.id];
            return next;
        });

        const parsed = parseInt(raw, 10);
        if (Number.isNaN(parsed) || parsed < 0) {
            toast.warning('Priority unchanged', 'Enter a positive whole number.');
            clearDraft();
            return;
        }
        if (parsed === link.priority) {
            clearDraft();
            return;
        }

        try {
            await api.put(`/live/epg-sources/links/${link.id}?priority=${parsed}`);
            toast.success('Priority updated', `${link.epg_source.name} -> ${parsed}`);
            fetchLinks();
        } catch (error) {
            console.error("Failed to update priority", error);
            // The field used to keep showing a value that was never persisted.
            toast.apiError('Failed to update priority', error);
        } finally {
            clearDraft();
        }
    };

    const triggerAutoMatch = async () => {
        if (!playlistId) return;
        setMatching(true);
        try {
            const res = await api.post(`/live/playlists/${playlistId}/epg-auto-match`);
            // The backend now explains itself: "0 matched" because nothing
            // scored high enough and "0 matched" because no EPG source is
            // linked used to produce the identical, useless message.
            const detail: string = res.data.message
                || `${res.data.matched_count} channel(s) matched.`;
            if (res.data.matched_count > 0) {
                toast.success('Auto-match complete', `${detail} Open the playlist editor to review them.`);
            } else {
                toast.warning('Auto-match matched nothing', detail);
            }
            // The list was never refreshed after matching, so nothing moved on screen.
            await fetchLinks();
        } catch (error) {
            console.error("Failed to trigger auto-match", error);
            toast.apiError('Auto-match failed', error);
        } finally {
            setMatching(false);
        }
    };

    if (!playlistId) {
        return (
            <div className="p-6 max-w-4xl mx-auto space-y-6">
                <div>
                    <h2 className="text-3xl font-bold tracking-tight">EPG Configuration</h2>
                    <p className="text-muted-foreground">Select a playlist to configure its EPG sources</p>
                </div>

                {loading ? (
                    <div className="flex justify-center py-10">
                        <Loader2 className="h-8 w-8 animate-spin text-primary" />
                    </div>
                ) : (
                    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                        {playlists.map((playlist: any) => (
                            <Card
                                key={playlist.id}
                                className="cursor-pointer hover:bg-accent transition-colors"
                                onClick={() => navigate(`/live-epg?playlist_id=${playlist.id}`)}
                            >
                                <CardHeader>
                                    <CardTitle className="flex items-center gap-2">
                                        <Activity className="h-5 w-5 text-primary" />
                                        {playlist.name}
                                    </CardTitle>
                                    <CardDescription>{playlist.description || "No description"}</CardDescription>
                                </CardHeader>
                            </Card>
                        ))}
                        {playlists.length === 0 && (
                            <div className="col-span-full text-center py-10 text-muted-foreground">
                                No playlists found. <br />
                                <Button variant="link" onClick={() => navigate('/live-playlists')}>Create a playlist</Button>
                            </div>
                        )}
                    </div>
                )}
            </div>
        );
    }

    return (
        <div className="space-y-6 max-w-5xl mx-auto">
            <div className="flex justify-between items-center">
                <div className="flex items-center gap-4">
                    <Button variant="ghost" size="icon" onClick={() => {
                        if (playlistId) {
                            navigate(`/live-selection?playlist_id=${playlistId}`);
                        } else {
                            navigate(`/live-playlists`);
                        }
                    }}>
                        <ArrowLeft className="h-5 w-5" />
                    </Button>
                    <div>
                        <h2 className="text-3xl font-bold tracking-tight">EPG Sources</h2>
                        <CardDescription>Manage Electronic Program Guide sources for this playlist</CardDescription>
                    </div>
                </div>
                <div className="flex gap-2">
                    <Button variant="outline" onClick={triggerAutoMatch} disabled={matching || loading}>
                        {matching ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Zap className="h-4 w-4 mr-2 text-yellow-500" />}
                        Auto-Match
                    </Button>
                    <Button variant="outline" onClick={fetchLinks} disabled={loading}>
                        <RefreshCw className={`h-4 w-4 mr-2 ${loading ? 'animate-spin' : ''}`} />
                        Refresh
                    </Button>
                    <Button onClick={() => navigate('/epg-admin')}>
                        <Settings className="h-4 w-4 mr-2" />
                        Manage Global Sources
                    </Button>
                </div>
            </div>

            <div className="grid gap-6">
                {/* Link New Source */}
                <Card className="border-dashed border-2">
                    <CardHeader className="pb-3 text-center">
                        <CardTitle className="text-lg flex items-center justify-center gap-2">
                            <Plus className="h-5 w-5" />
                            Link Global EPG Source
                        </CardTitle>
                        <CardDescription>Select an existing source from the global library</CardDescription>
                    </CardHeader>
                    <CardContent className="flex justify-center">
                        <Button onClick={() => setIsLinkOpen(true)}>
                            Choose Source to Link
                        </Button>
                    </CardContent>
                </Card>

                {/* Links List */}
                {loading && links.length === 0 ? (
                    <div className="flex justify-center p-12">
                        <Loader2 className="h-8 w-8 animate-spin text-primary" />
                    </div>
                ) : (
                    <div className="grid gap-4">
                        {links.map(link => (
                            <Card key={link.id}>
                                <CardContent className="p-4 flex flex-col md:flex-row items-center justify-between gap-4">
                                    <div className="flex items-center gap-4 flex-1">
                                        <div className="p-2 rounded-full bg-primary/10 text-primary">
                                            {link.epg_source.source_type === 'url' ? <Globe className="h-5 w-5" /> : <FileText className="h-5 w-5" />}
                                        </div>
                                        <div className="truncate">
                                            <div className="font-semibold flex items-center gap-2">
                                                {link.epg_source.name}
                                                <div className="bg-primary/20 text-primary px-2 py-0.5 rounded text-xs">Priority: {link.priority}</div>
                                            </div>
                                            <div className="text-sm text-muted-foreground truncate max-w-md">
                                                {link.epg_source.source_url || link.epg_source.file_path}
                                            </div>
                                            <div className="text-xs text-muted-foreground mt-1">
                                                Channels: {link.epg_source.channel_count} • Last updated: {link.epg_source.last_updated ? new Date(link.epg_source.last_updated).toLocaleString() : "Never"}
                                            </div>
                                        </div>
                                    </div>

                                    <div className="flex items-center gap-2">
                                        <div className="flex items-center gap-1 mr-4">
                                            <span className="text-xs text-muted-foreground">Priority:</span>
                                            <input
                                                type="number"
                                                min="0"
                                                className="w-16 p-1 border rounded text-xs bg-background"
                                                value={priorityDraft[link.id] ?? String(link.priority)}
                                                onChange={(e) => setPriorityDraft(prev => ({ ...prev, [link.id]: e.target.value }))}
                                                onBlur={() => commitPriority(link)}
                                                onKeyDown={(e) => {
                                                    if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                                                }}
                                                title="Press Enter or click away to apply"
                                            />
                                        </div>
                                        <Button variant="ghost" size="icon" className="text-destructive" onClick={() => setLinkToUnlink(link)}>
                                            <Trash2 className="h-4 w-4" />
                                        </Button>
                                    </div>
                                </CardContent>
                            </Card>
                        ))}
                        {links.length === 0 && !loading && (
                            <div className="text-center p-12 text-muted-foreground border rounded-lg border-dashed">
                                No EPG sources linked to this playlist.
                            </div>
                        )}
                    </div>
                )}
            </div>

            <Card>
                <CardHeader>
                    <CardTitle className="text-lg flex items-center gap-2">
                        <Settings className="h-5 w-5" />
                        EPG Info
                    </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4 text-sm text-muted-foreground">
                    <p>
                        XMLTV sources are parsed and cached in Redis. High priority sources take precedence for program data.
                    </p>
                    <div className="p-3 bg-muted rounded-md flex items-center justify-between">
                        <div className="flex items-center gap-2">
                            <span className="font-mono text-xs">XMLTV URL:</span>
                            <span className="text-xs select-all text-foreground">
                                {window.location.origin}/api/v1/live/playlist.xml?playlist_id={playlistId}
                            </span>
                        </div>
                        <Button variant="ghost" size="icon" onClick={() => window.open(`${window.location.origin}/api/v1/live/playlist.xml?playlist_id=${playlistId}`, '_blank')}>
                            <ExternalLink className="h-4 w-4" />
                        </Button>
                    </div>
                </CardContent>
            </Card>

            <ConfirmDialog
                isOpen={!!linkToUnlink}
                onClose={() => setLinkToUnlink(null)}
                onConfirm={confirmUnlink}
                title="Unlink EPG source"
                variant="destructive"
                confirmLabel="Unlink"
            >
                <p>
                    Unlink <strong>{linkToUnlink?.epg_source.name}</strong> from this playlist?
                </p>
                <p className="text-muted-foreground">
                    The global source itself is kept, but this playlist stops using its programme data.
                </p>
            </ConfirmDialog>

            <Dialog
                isOpen={isLinkOpen}
                onClose={() => setIsLinkOpen(false)}
                title="Link Global EPG Source"
            >
                <div className="space-y-4">
                    <p className="text-sm text-muted-foreground">
                        Select a global EPG source to link to this playlist.
                    </p>
                    <div className="space-y-2">
                        <label className="text-sm font-medium">EPG Source</label>
                        <select
                            className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                            value={selectedGlobalId}
                            onChange={e => setSelectedGlobalId(e.target.value)}
                        >
                            <option value="">Select a source...</option>
                            {globalSources
                                .filter(s => !links.some(l => l.epg_source_id === s.id))
                                .map(s => (
                                    <option key={s.id} value={s.id}>{s.name} ({s.source_type})</option>
                                ))
                            }
                        </select>
                    </div>
                    <div className="flex justify-end gap-2 pt-4">
                        <Button variant="outline" onClick={() => setIsLinkOpen(false)}>Cancel</Button>
                        <Button onClick={linkSource} disabled={!selectedGlobalId}>Link Source</Button>
                    </div>
                </div>
            </Dialog>
        </div>
    );
}
