import { useEffect, FC, useState, useMemo, ReactNode } from 'react';
import { Button } from "@/components/ui/button";
import { Download, Loader2, RefreshCw, ArrowLeft, Undo2, Redo2, Search, AlertTriangle, Check, Minimize2, Maximize2, Eye, ChevronRight } from 'lucide-react';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { LiveSelectionProvider, useLiveSelection } from '@/contexts/LiveSelectionContext';
import { EPGMappingModal } from '@/components/live/EPGMappingModal';
import { SourceExplorer, ChannelLibrary } from '@/components/live/StreamLibrary';
import { BouquetList } from '@/components/live/BouquetList';
import { CompositeList } from '@/components/live/CompositeList';
import { PlaylistStatistics } from '@/components/live/PlaylistStatistics';
import M3UPreviewModal from '@/components/live/M3UPreviewModal';
import GlobalSearchBar from '@/components/live/GlobalSearchBar';
import SearchResultsModal from '@/components/live/SearchResultsModal';
import api from '@/lib/api';

import {
    DndContext,
    closestCenter,
    KeyboardSensor,
    PointerSensor,
    useSensor,
    useSensors,
    DragEndEvent
} from '@dnd-kit/core';
import {
    sortableKeyboardCoordinates,
} from '@dnd-kit/sortable';

const PANEL_WIDTH = 'w-full lg:w-56 xl:w-64 lg:min-w-[14rem] xl:min-w-[16rem] h-72 lg:h-auto';

/** A side panel that can shrink to a narrow rail, remembering the choice. */
const CollapsiblePanel: FC<{
    storageKey: string;
    railLabel: string;
    expandTitle: string;
    children: (collapse: () => void) => ReactNode;
}> = ({ storageKey, railLabel, expandTitle, children }) => {
    const [collapsed, setCollapsed] = useState(() => {
        try { return localStorage.getItem(storageKey) === 'true'; } catch { return false; }
    });
    const change = (value: boolean) => {
        setCollapsed(value);
        try { localStorage.setItem(storageKey, String(value)); } catch { /* private mode */ }
    };

    return (
        <div className={`transition-all duration-300 flex-shrink-0 flex flex-col ${collapsed ? 'w-full lg:w-12 lg:min-w-[3rem]' : PANEL_WIDTH}`}>
            {collapsed ? (
                <div className="h-full flex lg:flex-col items-center justify-start gap-2 lg:pt-4 p-2 lg:p-0 bg-card border rounded-lg">
                    <Button variant="ghost" size="icon" onClick={() => change(false)} className="lg:mb-2" title={expandTitle} aria-label={expandTitle}>
                        <ChevronRight className="h-4 w-4" />
                    </Button>
                    <div className="lg:[writing-mode:vertical-rl] text-xs font-medium text-muted-foreground whitespace-nowrap">
                        {railLabel}
                    </div>
                </div>
            ) : (
                <div className="h-full relative flex flex-col min-w-0">
                    {children(() => change(true))}
                </div>
            )}
        </div>
    );
};

const isTyping = (target: EventTarget | null) => {
    const el = target as HTMLElement | null;
    return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
};

// Layout component that uses the context
const LiveSelectionLayout: FC<{ playlistId: string }> = ({ playlistId }) => {
    const navigate = useNavigate();
    const {
        playlist,
        loading,
        fetchPlaylist,
        resetPlaylist,
        compactMode,
        setCompactMode,
        reorderBouquets,
        reorderChannels,
        moveChannelToBouquet,
        undo,
        redo,
        canUndo,
        canRedo,
        saving,
        syncError,
        sourceSubscriptionId,
        sourceSubscriptionName,
    } = useLiveSelection();

    const [isPreviewOpen, setIsPreviewOpen] = useState(false);
    const [isResetOpen, setIsResetOpen] = useState(false);
    const [searchQuery, setSearchQuery] = useState("");
    const [searchResults, setSearchResults] = useState<any[]>([]);
    const [isSearching, setIsSearching] = useState(false);
    const [isSearchOpen, setIsSearchOpen] = useState(false);
    const [showMobileSearch, setShowMobileSearch] = useState(false);

    const sensors = useSensors(
        useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
        useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
    );

    useEffect(() => {
        if (playlistId) {
            fetchPlaylist(Number(playlistId));
        }
    }, [playlistId, fetchPlaylist]);

    // Keyboard shortcuts. Inside a text box Ctrl+Z belongs to the text, not to
    // the playlist, so the shortcuts stand aside there.
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (isTyping(e.target)) return;
            const mod = e.ctrlKey || e.metaKey;
            const key = e.key.toLowerCase();
            if (e.altKey && key === 'r') {
                e.preventDefault();
                setIsResetOpen(true);
            } else if (mod && key === 'z') {
                e.preventDefault();
                if (e.shiftKey) redo(); else undo();
            } else if (mod && key === 'y') {
                e.preventDefault();
                redo();
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [undo, redo]);

    const handleDragEnd = (event: DragEndEvent) => {
        const { active, over } = event;
        if (!over) return;

        const activeId = String(active.id);
        const overId = String(over.id);
        if (activeId === overId) return;

        const idOf = (value: string) => Number(value.split('-')[1]);

        if (activeId.startsWith('bouquet-') && overId.startsWith('bouquet-')) {
            reorderBouquets(idOf(activeId), idOf(overId));
        } else if (activeId.startsWith('channel-') && overId.startsWith('channel-')) {
            reorderChannels(idOf(activeId), idOf(overId));
        } else if (activeId.startsWith('channel-') && overId.startsWith('bouquet-')) {
            moveChannelToBouquet(idOf(activeId), idOf(overId));
        }
    };

    const runSearch = async (q: string) => {
        if (!sourceSubscriptionId) return;
        setSearchQuery(q);
        setIsSearchOpen(true);
        setIsSearching(true);
        setShowMobileSearch(false);
        try {
            const res = await api.get(`/live/streams/search`, {
                params: { subscription_id: sourceSubscriptionId, q }
            });
            setSearchResults(res.data.items);
        } catch (error) {
            console.error("Search failed", error);
            setSearchResults([]);
        } finally {
            setIsSearching(false);
        }
    };

    const statusBadge = useMemo(() => {
        if (syncError) {
            return (
                <div
                    className="flex items-center gap-2 px-3 py-1.5 bg-destructive/10 text-destructive rounded-md border border-destructive/20"
                    title={`${syncError}. The screen was reloaded from the server, so what you see is what is saved.`}
                >
                    <AlertTriangle className="h-4 w-4" />
                    <span className="text-xs font-medium">Last change failed</span>
                </div>
            );
        }
        if (saving) {
            return (
                <div className="flex items-center gap-2 px-3 py-1.5 bg-amber-500/10 text-amber-600 dark:text-amber-400 rounded-md border border-amber-500/20">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    <span className="text-xs font-medium">Saving…</span>
                </div>
            );
        }
        return (
            <div className="flex items-center gap-2 px-3 py-1.5 bg-green-500/10 text-green-600 dark:text-green-400 rounded-md border border-green-500/20">
                <Check className="h-4 w-4" />
                <span className="text-xs font-medium">Saved</span>
            </div>
        );
    }, [syncError, saving]);

    if (loading && !playlist) {
        return (
            <div className="flex h-[60vh] items-center justify-center bg-background">
                <div className="flex flex-col items-center gap-4">
                    <Loader2 className="h-12 w-12 animate-spin text-primary" />
                    <p className="text-lg font-medium animate-pulse">Loading playlist data...</p>
                </div>
            </div>
        );
    }

    if (!playlist) return null;

    const searchPlaceholder = sourceSubscriptionName ? `Search in ${sourceSubscriptionName}…` : undefined;

    return (
        <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
        >
            <div className={`flex flex-col h-[calc(100vh-4rem)] bg-background overflow-hidden -m-4 lg:-m-8 ${compactMode ? 'text-xs' : ''}`}>
                <header className="flex items-center justify-between gap-3 px-4 lg:px-6 py-3 border-b bg-card shadow-sm z-10 relative">
                    <div className="flex items-center gap-3 flex-1 min-w-0">
                        <Button variant="ghost" size="icon" onClick={() => navigate('/live-playlists')} className="hover:bg-primary/10" title="Back to the playlists" aria-label="Back to the playlists">
                            <ArrowLeft className="h-5 w-5" />
                        </Button>
                        <div className="min-w-0">
                            <h1 className="text-xl font-bold tracking-tight truncate">{playlist.name}</h1>
                            <p className="text-xs text-muted-foreground mt-0.5 truncate">{playlist.description || 'Playlist editor'}</p>
                        </div>
                    </div>

                    <div className="flex-1 max-w-md px-4 hidden md:block">
                        <GlobalSearchBar isLoading={isSearching} onSearch={runSearch} placeholder={searchPlaceholder} />
                    </div>

                    <div className="md:hidden">
                        <Button variant="ghost" size="icon" onClick={() => setShowMobileSearch(!showMobileSearch)} aria-label="Search">
                            <Search className="h-5 w-5" />
                        </Button>
                    </div>

                    {showMobileSearch && (
                        <div className="absolute top-0 left-0 right-0 z-50 p-2 bg-card border-b animate-in slide-in-from-top-2 md:hidden">
                            <div className="flex items-center gap-2">
                                <GlobalSearchBar isLoading={isSearching} onSearch={runSearch} placeholder={searchPlaceholder} />
                                <Button variant="ghost" size="sm" onClick={() => setShowMobileSearch(false)}>
                                    Cancel
                                </Button>
                            </div>
                        </div>
                    )}

                    <div className="flex items-center gap-2">
                        <div className="flex items-center border-r pr-2 mr-1 gap-1">
                            <Button variant="ghost" size="sm" onClick={undo} disabled={!canUndo} className="h-8 w-8 p-0" title="Undo (Ctrl+Z)" aria-label="Undo">
                                <Undo2 className="h-4 w-4" />
                            </Button>
                            <Button variant="ghost" size="sm" onClick={redo} disabled={!canRedo} className="h-8 w-8 p-0" title="Redo (Ctrl+Y)" aria-label="Redo">
                                <Redo2 className="h-4 w-4" />
                            </Button>
                        </div>

                        <Button
                            variant={compactMode ? 'default' : 'outline'}
                            size="sm"
                            className="gap-2"
                            onClick={() => setCompactMode(!compactMode)}
                            title={compactMode ? "Back to the comfortable layout" : "Show more rows on screen"}
                        >
                            {compactMode ? <Maximize2 className="h-4 w-4" /> : <Minimize2 className="h-4 w-4" />}
                            <span className="hidden xl:inline">{compactMode ? 'Comfortable' : 'Compact'}</span>
                        </Button>
                        <Button variant="outline" size="sm" className="gap-2" onClick={() => setIsResetOpen(true)} title="Reload from the server (Alt+R)">
                            <RefreshCw className="h-4 w-4" /> <span className="hidden xl:inline">Reload</span>
                        </Button>
                        <Button
                            variant="outline"
                            size="sm"
                            className="gap-2 text-indigo-500 border-indigo-500/30 hover:bg-indigo-500/10"
                            onClick={() => setIsPreviewOpen(true)}
                            title="See the M3U this playlist produces"
                        >
                            <Eye className="h-4 w-4" /> <span className="hidden xl:inline">Preview M3U</span>
                        </Button>
                        <Button
                            variant="outline"
                            size="sm"
                            className="gap-2 text-indigo-500 border-indigo-500/30 hover:bg-indigo-500/10"
                            onClick={() => window.open(`/api/v1/live/playlist.m3u?playlist_id=${playlist.public_id ?? playlist.id}`, '_blank')}
                            title="Open the playlist file your player uses"
                        >
                            <Download className="h-4 w-4" /> <span className="hidden xl:inline">Export M3U</span>
                        </Button>
                        {statusBadge}
                    </div>
                </header>

                <PlaylistStatistics />

                {/* Flow: pick a source category, choose channels, send them to a group, order the group. */}
                <div className="flex-1 flex flex-col lg:flex-row gap-4 min-h-0 px-4 pb-4 pt-4 overflow-auto lg:overflow-hidden">
                    <CollapsiblePanel storageKey="live-source-panel-collapsed" railLabel="1. Source" expandTitle="Expand the source panel">
                        {(collapse) => <SourceExplorer onCollapse={collapse} compactMode={compactMode} />}
                    </CollapsiblePanel>

                    <CollapsiblePanel storageKey="live-library-panel-collapsed" railLabel="2. Channels" expandTitle="Expand the channel library">
                        {(collapse) => <ChannelLibrary onCollapse={collapse} compactMode={compactMode} />}
                    </CollapsiblePanel>

                    <CollapsiblePanel storageKey="live-middle-panel-collapsed" railLabel="3. Groups" expandTitle="Expand the groups">
                        {(collapse) => <BouquetList onCollapse={collapse} compactMode={compactMode} />}
                    </CollapsiblePanel>

                    <div className="flex-1 min-w-0 min-h-[24rem] lg:min-h-0 flex flex-col overflow-hidden">
                        <CompositeList compactMode={compactMode} />
                    </div>
                </div>

                <EPGMappingModal />
                <M3UPreviewModal
                    isOpen={isPreviewOpen}
                    onClose={() => setIsPreviewOpen(false)}
                    playlistId={playlist.id}
                />
                <SearchResultsModal
                    isOpen={isSearchOpen}
                    onClose={() => setIsSearchOpen(false)}
                    results={searchResults}
                    loading={isSearching}
                    query={searchQuery}
                />
                <ConfirmDialog
                    isOpen={isResetOpen}
                    onClose={() => setIsResetOpen(false)}
                    onConfirm={() => {
                        resetPlaylist();
                        setIsResetOpen(false);
                    }}
                    title="Reload from the server"
                    confirmLabel="Reload"
                >
                    <p>Reload this playlist from the server?</p>
                    <p className="text-muted-foreground">
                        Every change is saved as you make it, so nothing is lost. The view is refreshed and the
                        undo history is cleared.
                    </p>
                </ConfirmDialog>
            </div>
        </DndContext>
    );
};

export default function LiveSelection() {
    const [searchParams] = useSearchParams();
    const navigate = useNavigate();
    const playlistId = searchParams.get('playlist_id');

    useEffect(() => {
        if (!playlistId) {
            navigate('/live-playlists');
        }
    }, [playlistId, navigate]);

    if (!playlistId) return null;

    return (
        <LiveSelectionProvider key={playlistId}>
            <LiveSelectionLayout playlistId={playlistId} />
        </LiveSelectionProvider>
    );
}
