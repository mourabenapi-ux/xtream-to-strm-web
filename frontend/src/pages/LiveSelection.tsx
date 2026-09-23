import { useEffect, FC, useState, useMemo } from 'react';
import { Button } from "@/components/ui/button";
import { Download, Loader2, RefreshCw, ArrowLeft, Undo2, Redo2, Search, AlertTriangle, Check } from 'lucide-react';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { LiveSelectionProvider, useLiveSelection } from '@/contexts/LiveSelectionContext';
import { EPGMappingModal } from '@/components/live/EPGMappingModal';
import { SourceExplorer, ChannelLibrary } from '@/components/live/StreamLibrary';
import { BouquetList } from '@/components/live/BouquetList';
import { CompositeList } from '@/components/live/CompositeList';
import { PlaylistStatistics } from '@/components/live/PlaylistStatistics';
import { Minimize2, Maximize2, Eye, ChevronRight, AlignJustify } from 'lucide-react';
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
        syncError
    } = useLiveSelection();

    const [isPreviewOpen, setIsPreviewOpen] = useState(false);
    const [isResetOpen, setIsResetOpen] = useState(false);
    const [searchQuery, setSearchQuery] = useState("");
    const [searchResults, setSearchResults] = useState<any[]>([]);
    const [isSearching, setIsSearching] = useState(false);
    const [isSearchOpen, setIsSearchOpen] = useState(false);
    const [showMobileSearch, setShowMobileSearch] = useState(false);

    // Collapsible Columns State
    const [sourcePanelCollapsed, setSourcePanelCollapsed] = useState(() => {
        const saved = localStorage.getItem('live-source-panel-collapsed');
        return saved === 'true';
    });
    const [libraryPanelCollapsed, setLibraryPanelCollapsed] = useState(() => {
        const saved = localStorage.getItem('live-library-panel-collapsed');
        return saved === 'true';
    });
    const [middlePanelCollapsed, setMiddlePanelCollapsed] = useState(() => {
        const saved = localStorage.getItem('live-middle-panel-collapsed');
        return saved === 'true';
    });

    // Calculate composite columns based on collapsed state
    const compositeColumns = useMemo(() => {
        const collapsedCount = [sourcePanelCollapsed, libraryPanelCollapsed, middlePanelCollapsed].filter(Boolean).length;
        return Math.min(collapsedCount + 1, 4);
    }, [sourcePanelCollapsed, libraryPanelCollapsed, middlePanelCollapsed]);

    // Persist collapsed state
    useEffect(() => {
        localStorage.setItem('live-source-panel-collapsed', String(sourcePanelCollapsed));
    }, [sourcePanelCollapsed]);

    useEffect(() => {
        localStorage.setItem('live-library-panel-collapsed', String(libraryPanelCollapsed));
    }, [libraryPanelCollapsed]);

    useEffect(() => {
        localStorage.setItem('live-middle-panel-collapsed', String(middlePanelCollapsed));
    }, [middlePanelCollapsed]);

    const sensors = useSensors(
        useSensor(PointerSensor, {
            activationConstraint: {
                distance: 5,
            },
        }),
        useSensor(KeyboardSensor, {
            coordinateGetter: sortableKeyboardCoordinates,
        })
    );

    useEffect(() => {
        if (playlistId) {
            fetchPlaylist(Number(playlistId));
        }
    }, [playlistId, fetchPlaylist]);

    // Keyboard Shortcuts
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.altKey && e.key.toLowerCase() === 'r') {
                e.preventDefault();
                setIsResetOpen(true);
            }
            // Undo/Redo Shortcuts
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
                if (e.shiftKey) {
                    e.preventDefault();
                    redo();
                } else {
                    e.preventDefault();
                    undo();
                }
            }
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
                e.preventDefault();
                redo();
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [resetPlaylist, undo, redo]);

    const handleDragEnd = (event: DragEndEvent) => {
        const { active, over } = event;
        if (!over) return;

        const activeId = active.id as string;
        const overId = over.id as string;

        if (activeId === overId) return;

        // Handle Bouquet Reordering
        if (activeId.startsWith('bouquet-') && overId.startsWith('bouquet-')) {
            const aId = Number(activeId.replace('bouquet-', ''));
            const oId = Number(overId.replace('bouquet-', ''));
            reorderBouquets(aId, oId);
        }

        // Handle Channel Reordering
        if (activeId.startsWith('channel-') && overId.startsWith('channel-')) {
            const aId = Number(activeId.replace('channel-', ''));
            const oId = Number(overId.replace('channel-', ''));
            reorderChannels(aId, oId);
        }

        // Handle Moving Channel to Bouquet
        if (activeId.startsWith('channel-') && overId.startsWith('bouquet-')) {
            const cId = Number(activeId.replace('channel-', ''));
            const bId = Number(overId.replace('bouquet-', ''));
            moveChannelToBouquet(cId, bId);
        }
    };

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

    return (
        <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
        >
            <div className={`flex flex-col h-[calc(100vh-4rem)] lg:h-[calc(100vh-4rem)] bg-background overflow-hidden -m-4 lg:-m-8 ${compactMode ? 'text-xs' : ''}`}>
                {/* Header section remains simple */}
                <header className="flex items-center justify-between px-6 py-4 border-b bg-card shadow-sm z-10">
                    <div className="flex items-center gap-4 flex-1">
                        <Button variant="ghost" size="icon" onClick={() => navigate('/live-playlists')} className="hover:bg-primary/10">
                            <ArrowLeft className="h-5 w-5" />
                        </Button>
                        <div>
                            <h1 className="text-xl font-bold tracking-tight flex items-center gap-2">
                                {playlist?.name}
                                <span className="text-xs font-normal px-2 py-0.5 bg-primary/10 text-primary rounded-full">v3.0</span>
                            </h1>
                            <p className="text-xs text-muted-foreground mt-0.5 whitespace-nowrap">{playlist?.description || 'Virtual Playlist Builder'}</p>
                        </div>
                    </div>

                    <div className="flex-1 max-w-md px-4 hidden md:block">
                        <GlobalSearchBar
                            isLoading={isSearching}
                            onSearch={async (q) => {
                                setSearchQuery(q);
                                setIsSearchOpen(true);
                                setIsSearching(true);
                                try {
                                    const res = await api.get(`/live/streams/search`, {
                                        params: { subscription_id: playlist.subscription_id, q }
                                    });
                                    setSearchResults(res.data.items);
                                } catch (error) {
                                    console.error("Search failed", error);
                                    setSearchResults([]);
                                } finally {
                                    setIsSearching(false);
                                }
                            }}
                        />
                    </div>

                    {/* Mobile Search Trigger */}
                    <div className="md:hidden">
                        <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => setShowMobileSearch(!showMobileSearch)}
                        >
                            <Search className="h-5 w-5" />
                        </Button>
                    </div>

                    {/* Mobile Search Overlay */}
                    {showMobileSearch && (
                        <div className="absolute top-0 left-0 right-0 z-50 p-2 bg-card border-b animate-in slide-in-from-top-2 md:hidden">
                            <div className="flex items-center gap-2">
                                <GlobalSearchBar
                                    isLoading={isSearching}
                                    onSearch={async (q) => {
                                        setSearchQuery(q);
                                        setIsSearchOpen(true);
                                        setIsSearching(true);
                                        // Close mobile search bar after searching
                                        setShowMobileSearch(false);
                                        try {
                                            const res = await api.get(`/live/streams/search`, {
                                                params: { subscription_id: playlist.subscription_id, q }
                                            });
                                            setSearchResults(res.data.items);
                                        } catch (error) {
                                            console.error("Search failed", error);
                                            setSearchResults([]);
                                        } finally {
                                            setIsSearching(false);
                                        }
                                    }}
                                />
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => setShowMobileSearch(false)}
                                >
                                    Cancel
                                </Button>
                            </div>
                        </div>
                    )}

                    <div className="flex items-center gap-3">
                        <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setCompactMode(!compactMode)}
                            className={`h-8 w-8 p-0 ${compactMode ? 'text-primary bg-primary/10' : 'text-muted-foreground'}`}
                            title={compactMode ? "Disable Compact Mode" : "Enable Compact Mode"}
                        >
                            <AlignJustify className="h-4 w-4" />
                        </Button>
                        <div className="flex items-center border-r pr-3 mr-3 gap-1">
                            <Button
                                variant="ghost"
                                size="sm"
                                onClick={undo}
                                disabled={!canUndo}
                                className="h-8 w-8 p-0"
                                title="Undo (Ctrl+Z)"
                            >
                                <Undo2 className="h-4 w-4" />
                            </Button>
                            <Button
                                variant="ghost"
                                size="sm"
                                onClick={redo}
                                disabled={!canRedo}
                                className="h-8 w-8 p-0"
                                title="Redo (Ctrl+Y)"
                            >
                                <Redo2 className="h-4 w-4" />
                            </Button>
                        </div>

                        <Button
                            variant="outline"
                            size="sm"
                            className="hidden sm:flex gap-2"
                            onClick={() => setCompactMode(!compactMode)}
                            title={compactMode ? "Disable Compact Mode" : "Enable Compact Mode"}
                        >
                            {compactMode ? <Maximize2 className="h-4 w-4" /> : <Minimize2 className="h-4 w-4" />}
                            {compactMode ? 'Normal' : 'Compact'}
                        </Button>
                        <Button
                            variant="outline"
                            size="sm"
                            className="hidden sm:flex gap-2"
                            onClick={() => setIsResetOpen(true)}
                            title="Reload from server (Alt+R)"
                        >
                            <RefreshCw className="h-4 w-4" /> Reset
                        </Button>
                        <Button
                            variant="outline"
                            size="sm"
                            className="hidden sm:flex gap-2 text-indigo-500 border-indigo-500/30 hover:bg-indigo-500/10"
                            onClick={() => setIsPreviewOpen(true)}
                        >
                            <Eye className="h-4 w-4" /> Preview
                        </Button>
                        <Button variant="outline" size="sm" className="hidden sm:flex gap-2 text-indigo-500 border-indigo-500/30 hover:bg-indigo-500/10" onClick={() => window.open(`/api/v1/live/playlist.m3u?playlist_id=${playlist.public_id}`, '_blank')}>
                            <Download className="h-4 w-4" /> Export M3U
                        </Button>
                        {syncError ? (
                            <div
                                className="flex items-center gap-2 px-3 py-1.5 bg-destructive/10 text-destructive rounded-md border border-destructive/20"
                                title={`${syncError}. Your last change may not have been saved — reload to see the server state.`}
                            >
                                <AlertTriangle className="h-4 w-4" />
                                <span className="text-xs font-medium">Not saved</span>
                            </div>
                        ) : saving ? (
                            <div className="flex items-center gap-2 px-3 py-1.5 bg-amber-500/10 text-amber-600 dark:text-amber-400 rounded-md border border-amber-500/20">
                                <Loader2 className="h-4 w-4 animate-spin" />
                                <span className="text-xs font-medium">Saving…</span>
                            </div>
                        ) : (
                            <div className="flex items-center gap-2 px-3 py-1.5 bg-green-500/10 text-green-600 dark:text-green-400 rounded-md border border-green-500/20">
                                <Check className="h-4 w-4" />
                                <span className="text-xs font-medium">Auto-saved</span>
                            </div>
                        )}
                    </div>
                </header>

                <PlaylistStatistics />

                {/* 4-Pane Layout with Collapsible Columns */}
                <div className="flex-1 flex flex-col lg:flex-row gap-4 min-h-0 px-4 pb-4 pt-4 overflow-auto lg:overflow-hidden">
                    {/* Column 1: Source Explorer (Collapsible) */}
                    <div className={`transition-all duration-300 flex-shrink-0 flex flex-col ${sourcePanelCollapsed ? 'w-12 min-w-[3rem]' : 'w-full lg:w-56 xl:w-72 lg:min-w-[14rem] xl:min-w-[18rem] h-72 lg:h-auto'
                        }`}>
                        {sourcePanelCollapsed ? (
                            <div className="h-full flex flex-col items-center justify-start pt-4 bg-card border rounded-lg">
                                <Button
                                    variant="ghost"
                                    size="icon"
                                    onClick={() => setSourcePanelCollapsed(false)}
                                    className="mb-4"
                                    title="Expand Source Explorer"
                                >
                                    <ChevronRight className="h-4 w-4" />
                                </Button>
                                <div className="writing-mode-vertical text-xs font-medium text-muted-foreground whitespace-nowrap pt-2">
                                    Source
                                </div>
                            </div>
                        ) : (
                            <div className="h-full relative flex flex-col min-w-0">
                                <SourceExplorer onCollapse={() => setSourcePanelCollapsed(true)} compactMode={compactMode} />
                            </div>
                        )}
                    </div>

                    {/* Column 2: Channel Library (Collapsible) */}
                    <div className={`transition-all duration-300 flex-shrink-0 flex flex-col ${libraryPanelCollapsed ? 'w-12 min-w-[3rem]' : 'w-full lg:w-56 xl:w-72 lg:min-w-[14rem] xl:min-w-[18rem] h-72 lg:h-auto'
                        }`}>
                        {libraryPanelCollapsed ? (
                            <div className="h-full flex flex-col items-center justify-start pt-4 bg-card border rounded-lg">
                                <Button
                                    variant="ghost"
                                    size="icon"
                                    onClick={() => setLibraryPanelCollapsed(false)}
                                    className="mb-4"
                                    title="Expand Channel Library"
                                >
                                    <ChevronRight className="h-4 w-4" />
                                </Button>
                                <div className="writing-mode-vertical text-xs font-medium text-muted-foreground whitespace-nowrap pt-2">
                                    Library
                                </div>
                            </div>
                        ) : (
                            <div className="h-full relative flex flex-col min-w-0">
                                <ChannelLibrary onCollapse={() => setLibraryPanelCollapsed(true)} compactMode={compactMode} />
                            </div>
                        )}
                    </div>

                    {/* Column 3: Bouquet List (Collapsible) */}
                    <div className={`transition-all duration-300 flex-shrink-0 flex flex-col ${middlePanelCollapsed ? 'w-12 min-w-[3rem]' : 'w-full lg:w-56 xl:w-72 lg:min-w-[14rem] xl:min-w-[18rem] h-72 lg:h-auto'
                        }`}>
                        {middlePanelCollapsed ? (
                            <div className="h-full flex flex-col items-center justify-start pt-4 bg-card border rounded-lg">
                                <Button
                                    variant="ghost"
                                    size="icon"
                                    onClick={() => setMiddlePanelCollapsed(false)}
                                    className="mb-4"
                                    title="Expand Virtual Groups"
                                >
                                    <ChevronRight className="h-4 w-4" />
                                </Button>
                                <div className="writing-mode-vertical text-xs font-medium text-muted-foreground whitespace-nowrap pt-2">
                                    Groups
                                </div>
                            </div>
                        ) : (
                            <div className="h-full relative flex flex-col min-w-0">
                                <BouquetList onCollapse={() => setMiddlePanelCollapsed(true)} compactMode={compactMode} />
                            </div>
                        )}
                    </div>

                    {/* Column 4: Composite List (Adaptive) */}
                    <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
                        <CompositeList columns={compositeColumns} compactMode={compactMode} />
                    </div>
                </div>

                {/* Modals */}
                <EPGMappingModal />
                <M3UPreviewModal
                    isOpen={isPreviewOpen}
                    onClose={() => setIsPreviewOpen(false)}
                    playlistId={playlist?.id}
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
                    title="Reload playlist from server"
                    variant="destructive"
                    confirmLabel="Reload and discard"
                >
                    <p>Reload this playlist from the server?</p>
                    <p className="text-muted-foreground">
                        Anything not yet synced is discarded, and the undo history is cleared.
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
        <LiveSelectionProvider>
            <LiveSelectionLayout playlistId={playlistId} />
        </LiveSelectionProvider>
    );
}
