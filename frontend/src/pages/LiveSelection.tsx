import { useEffect, FC, useState, useMemo, ReactNode, useRef } from 'react';
import { Button } from "@/components/ui/button";
import {
    Loader2, RefreshCw, ArrowLeft, Undo2, Redo2, Search, AlertTriangle, Check, Minimize2, Maximize2, Eye,
    ChevronRight, Wrench, Library, Copy, ExternalLink, Wand2, ListOrdered, Hash, CopyX, HeartPulse, Tv, Repeat,
    Type, History, MonitorPlay, ListPlus, Settings2,
} from 'lucide-react';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { LiveSelectionProvider, useLiveSelection, BasketItem } from '@/contexts/LiveSelectionContext';
import { useToast } from '@/contexts/ToastContext';
import { EPGMappingModal } from '@/components/live/EPGMappingModal';
import { LibraryPanel } from '@/components/live/StreamLibrary';
import { BouquetList } from '@/components/live/BouquetList';
import { CompositeList } from '@/components/live/CompositeList';
import { PlaylistStatistics } from '@/components/live/PlaylistStatistics';
import { HealthPanel } from '@/components/live/HealthPanel';
import { CommandPalette } from '@/components/live/CommandPalette';
import M3UPreviewModal from '@/components/live/M3UPreviewModal';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { BulkRenameDialog } from '@/components/live/BulkRenameDialog';
import { VersionsDialog } from '@/components/live/VersionsDialog';
import { TvPreview } from '@/components/live/TvPreview';
import { PlaylistSettingsDialog, playerUrls } from '@/components/live/PlaylistSettingsDialog';

import {
    DndContext, closestCenter, pointerWithin, KeyboardSensor, PointerSensor, useSensor, useSensors,
    DragEndEvent, DragStartEvent, DragOverlay, CollisionDetection,
} from '@dnd-kit/core';
import { sortableKeyboardCoordinates } from '@dnd-kit/sortable';

const usePersisted = (key: string, initial: boolean): [boolean, (v: boolean) => void] => {
    const [value, setValue] = useState(() => {
        try { const v = localStorage.getItem(key); return v === null ? initial : v === 'true'; } catch { return initial; }
    });
    const change = (v: boolean) => {
        setValue(v);
        try { localStorage.setItem(key, String(v)); } catch { /* private mode */ }
    };
    return [value, change];
};

/** A side column that can shrink to a narrow rail, remembering the choice. */
const Rail: FC<{ collapsed: boolean; onExpand: () => void; label: string; width: string; children: ReactNode }> =
    ({ collapsed, onExpand, label, width, children }) => (
        <div className={`flex-shrink-0 flex flex-col min-h-0 ${collapsed ? 'w-full lg:w-10' : width}`}>
            {collapsed ? (
                <button type="button" onClick={onExpand} title={`Show the ${label.toLowerCase()}`}
                    className="h-full flex lg:flex-col items-center gap-2 p-2 lg:pt-3 bg-card border rounded-lg hover:bg-muted">
                    <ChevronRight className="h-4 w-4" />
                    <span className="lg:[writing-mode:vertical-rl] text-xs font-medium text-muted-foreground whitespace-nowrap">{label}</span>
                </button>
            ) : children}
        </div>
    );

const isTyping = (target: EventTarget | null) => {
    const el = target as HTMLElement | null;
    return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
};

// The pointer decides first, so a channel dropped from the library lands on the
// group under the cursor; the nearest centre only breaks ties (reordering).
const collision: CollisionDetection = (args) => {
    const hits = pointerWithin(args);
    return hits.length ? hits : closestCenter(args);
};

type ToolKey = 'fix_numbering' | 'reference_numbering' | 'dedupe' | 'repair_dead' | 'auto_match' | 'refresh_rules';

const LiveSelectionLayout: FC<{ playlistId: string }> = ({ playlistId }) => {
    const navigate = useNavigate();
    const toast = useToast();
    const {
        playlist, loading, fetchPlaylist, resetPlaylist, compactMode, setCompactMode,
        reorderBouquets, reorderChannels, moveChannelToBouquet, addStreams, selectedBouquetId,
        undo, redo, canUndo, canRedo, saving, syncError, runTool, useChannelNumbers, focus,
        channelLabel, bouquetLabel,
    } = useLiveSelection();

    const [isPreviewOpen, setIsPreviewOpen] = useState(false);
    const [isResetOpen, setIsResetOpen] = useState(false);
    const [paletteOpen, setPaletteOpen] = useState(false);
    const [healthTab, setHealthTab] = useState<'issues' | 'new' | 'missing' | null>(null);
    const [renameOpen, setRenameOpen] = useState(false);
    const [versionsOpen, setVersionsOpen] = useState(false);
    const [tvOpen, setTvOpen] = useState(false);
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [toolsOpen, setToolsOpen] = useState(false);
    const [confirmTool, setConfirmTool] = useState<ToolKey | null>(null);
    const [busyTool, setBusyTool] = useState<ToolKey | null>(null);
    const [dragLabel, setDragLabel] = useState<string | null>(null);
    const [libraryHidden, setLibraryHidden] = usePersisted('live-library-hidden', false);
    const [groupsHidden, setGroupsHidden] = usePersisted('live-groups-hidden', false);
    const toolsRef = useRef<HTMLDivElement>(null);

    const sensors = useSensors(
        useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
        useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
    );

    useEffect(() => {
        if (playlistId) fetchPlaylist(Number(playlistId));
    }, [playlistId, fetchPlaylist]);

    // Shortcuts. Inside a text box Ctrl+Z belongs to the text, not to the
    // playlist; Ctrl+K works everywhere.
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            const mod = e.ctrlKey || e.metaKey;
            const key = e.key.toLowerCase();
            if (mod && key === 'k') {
                e.preventDefault();
                setPaletteOpen(true);
                return;
            }
            if (isTyping(e.target)) return;
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

    useEffect(() => {
        if (!toolsOpen) return;
        const close = (e: MouseEvent) => { if (!toolsRef.current?.contains(e.target as Node)) setToolsOpen(false); };
        window.addEventListener('mousedown', close);
        return () => window.removeEventListener('mousedown', close);
    }, [toolsOpen]);

    const idOf = (value: string) => Number(value.split('-')[1]);

    const handleDragStart = (event: DragStartEvent) => {
        const id = String(event.active.id);
        if (id.startsWith('lib|')) {
            const items: BasketItem[] = event.active.data.current?.items ?? [];
            setDragLabel(items.length === 1 ? items[0].stream.name : `${items.length} channels`);
        } else if (id.startsWith('channel-')) {
            const channel = playlist?.bouquets.flatMap(b => b.channels).find(c => c.id === idOf(id));
            setDragLabel(channel ? channelLabel(channel) : null);
        } else if (id.startsWith('bouquet-')) {
            const group = playlist?.bouquets.find(b => b.id === idOf(id));
            setDragLabel(group ? bouquetLabel(group) : null);
        }
    };

    const handleDragEnd = (event: DragEndEvent) => {
        setDragLabel(null);
        const { active, over } = event;
        if (!over) return;
        const activeId = String(active.id);
        const overId = String(over.id);
        if (activeId === overId) return;

        if (activeId.startsWith('lib|')) {
            const items: BasketItem[] = active.data.current?.items ?? [];
            if (overId.startsWith('bouquet-')) addStreams(items, idOf(overId));
            else if ((overId.startsWith('channel-') || overId === 'composite-drop') && !focus) addStreams(items, selectedBouquetId);
            return;
        }
        if (activeId.startsWith('bouquet-') && overId.startsWith('bouquet-')) {
            reorderBouquets(idOf(activeId), idOf(overId));
        } else if (activeId.startsWith('channel-') && overId.startsWith('channel-')) {
            reorderChannels(idOf(activeId), idOf(overId));
        } else if (activeId.startsWith('channel-') && overId.startsWith('bouquet-')) {
            moveChannelToBouquet(idOf(activeId), idOf(overId));
        }
    };

    const runServerTool = async (tool: ToolKey) => {
        setToolsOpen(false);
        setConfirmTool(null);
        setBusyTool(tool);
        const r = await runTool(tool);
        setBusyTool(null);
        if (!r) return;
        const message: Record<ToolKey, () => string> = {
            fix_numbering: () => `${r.changed} number(s) changed. Every group now owns a range.`,
            reference_numbering: () => r.profile ? `Profile "${r.profile}": ${r.matched} recognised, ${r.changed} number(s) changed.` : 'No reference profile recognises these channels.',
            dedupe: () => `${r.removed} copy(ies) removed.`,
            repair_dead: () => `${r.repaired.length} repaired, ${r.unresolved.length} without a replacement.`,
            auto_match: () => `${r.matched_count ?? 0} channel(s) matched.${r.message ? ` ${r.message}` : ''}`,
            refresh_rules: () => {
                const added = (r.groups ?? []).reduce((n: number, g: any) => n + g.added, 0);
                return (r.groups ?? []).length ? `${added} channel(s) added to the rule groups.` : 'This playlist has no rule group yet (gear icon on a group).';
            },
        };
        toast.success('Done', `${message[tool]()} Ctrl+Z undoes it.`);
    };

    const copy = (url: string, what: string) => {
        navigator.clipboard.writeText(url);
        toast.success(`${what} URL copied`, url);
        setToolsOpen(false);
    };

    const statusBadge = useMemo(() => {
        if (syncError) {
            return (
                <div className="flex items-center gap-1.5 px-2 py-1 bg-destructive/10 text-destructive rounded-md border border-destructive/20"
                    title={`${syncError}. The screen was reloaded from the server, so what you see is what is saved.`}>
                    <AlertTriangle className="h-4 w-4" />
                    <span className="text-xs font-medium hidden xl:inline">Last change failed</span>
                </div>
            );
        }
        if (saving) {
            return (
                <div className="flex items-center gap-1.5 px-2 py-1 bg-amber-500/10 text-amber-600 dark:text-amber-400 rounded-md border border-amber-500/20">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    <span className="text-xs font-medium hidden xl:inline">Saving…</span>
                </div>
            );
        }
        return (
            <div className="flex items-center gap-1.5 px-2 py-1 bg-green-500/10 text-green-600 dark:text-green-400 rounded-md border border-green-500/20" title="Every change is saved as you make it">
                <Check className="h-4 w-4" />
                <span className="text-xs font-medium hidden xl:inline">Saved</span>
            </div>
        );
    }, [syncError, saving]);

    if (loading && !playlist) {
        return (
            <div className="flex h-full items-center justify-center bg-background">
                <div className="flex flex-col items-center gap-4">
                    <Loader2 className="h-12 w-12 animate-spin text-primary" />
                    <p className="text-lg font-medium animate-pulse">Loading playlist data...</p>
                </div>
            </div>
        );
    }

    if (!playlist) return null;

    const menu = (icon: ReactNode, label: string, hint: string, onClick: () => void) => (
        <button type="button" key={label} onClick={() => { setToolsOpen(false); onClick(); }}
            className="w-full flex items-start gap-2 px-3 py-2 text-left hover:bg-muted">
            <span className="mt-0.5 text-primary">{icon}</span>
            <span>
                <span className="block text-sm font-medium">{label}</span>
                <span className="block text-[11px] text-muted-foreground leading-snug">{hint}</span>
            </span>
        </button>
    );

    const tool = (key: ToolKey, icon: ReactNode, label: string, hint: string, confirm = false) => (
        <button type="button" key={key} disabled={!!busyTool}
            onClick={() => (confirm ? (setToolsOpen(false), setConfirmTool(key)) : runServerTool(key))}
            className="w-full flex items-start gap-2 px-3 py-2 text-left hover:bg-muted disabled:opacity-50">
            <span className="mt-0.5 text-primary">{busyTool === key ? <Loader2 className="h-4 w-4 animate-spin" /> : icon}</span>
            <span>
                <span className="block text-sm font-medium">{label}</span>
                <span className="block text-[11px] text-muted-foreground leading-snug">{hint}</span>
            </span>
        </button>
    );

    return (
        <DndContext sensors={sensors} collisionDetection={collision} onDragStart={handleDragStart} onDragEnd={handleDragEnd} onDragCancel={() => setDragLabel(null)}>
            {/* The layout gives this screen the whole content area (no padding,
                no page scroll), so it fills it rather than guessing at 100vh. */}
            <div className={`flex flex-col h-full bg-background overflow-hidden ${compactMode ? 'text-xs' : ''}`}>
                {/* On a phone the header takes two lines: name and save state,
                    then search and tools. On one line the name was squeezed to
                    nothing and the last buttons were cut off. */}
                <header className="flex flex-wrap md:flex-nowrap items-center gap-x-2 gap-y-1.5 px-3 lg:px-4 py-2 border-b bg-card shadow-sm z-10">
                    <Button variant="ghost" size="icon" onClick={() => navigate('/live-playlists')} title="Back to the playlists" aria-label="Back to the playlists">
                        <ArrowLeft className="h-5 w-5" />
                    </Button>
                    <button type="button" className="min-w-0 flex-1 md:flex-initial text-left group" onClick={() => setSettingsOpen(true)}
                        title="Name, description, short URLs">
                        <h1 className="text-lg font-bold tracking-tight truncate flex items-center gap-1.5">
                            {playlist.name}
                            <Settings2 className="h-3.5 w-3.5 text-muted-foreground opacity-0 group-hover:opacity-100" />
                        </h1>
                        <p className="text-[11px] text-muted-foreground truncate">{playlist.description || 'Playlist editor'}</p>
                    </button>
                    <div className="md:hidden flex-shrink-0">{statusBadge}</div>
                    <div className="basis-full h-0 md:hidden" aria-hidden="true" />

                    <button type="button" onClick={() => setPaletteOpen(true)}
                        className="flex-1 md:flex-initial min-w-0 md:mx-auto flex items-center gap-2 md:w-full max-w-sm h-9 px-3 rounded-md border bg-muted/30 text-xs text-muted-foreground hover:bg-muted/60">
                        <Search className="h-4 w-4" />
                        <span className="flex-1 text-left truncate">Search the playlist and every provider…</span>
                        <kbd className="hidden md:inline px-1.5 py-0.5 border rounded text-[10px] bg-background">Ctrl K</kbd>
                    </button>

                    <div className="flex items-center gap-1.5 flex-shrink-0">
                        <div className="flex items-center border-r pr-1.5 gap-0.5">
                            <Button variant="ghost" size="sm" onClick={undo} disabled={!canUndo} className="h-8 w-8 p-0" title="Undo (Ctrl+Z)" aria-label="Undo">
                                <Undo2 className="h-4 w-4" />
                            </Button>
                            <Button variant="ghost" size="sm" onClick={redo} disabled={!canRedo} className="h-8 w-8 p-0" title="Redo (Ctrl+Y)" aria-label="Redo">
                                <Redo2 className="h-4 w-4" />
                            </Button>
                        </div>

                        <div className="relative" ref={toolsRef}>
                            <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setToolsOpen(o => !o)} aria-expanded={toolsOpen}>
                                <Wrench className="h-4 w-4" /> <span className="hidden lg:inline">Tools</span>
                            </Button>
                            {toolsOpen && (
                                // On a phone the button is not at the screen edge, so a
                                // 20rem menu anchored to it ran off the left side.
                                <div className="fixed inset-x-3 mt-1 max-h-[60vh] md:absolute md:inset-x-auto md:right-0 md:w-80 md:max-h-[80vh] bg-card border rounded-md shadow-xl z-40 py-1 overflow-y-auto overscroll-contain">
                                    {tool('fix_numbering', <ListOrdered className="h-4 w-4" />, 'Fix the numbering',
                                        useChannelNumbers ? 'Every group gets a range; duplicates, 0 and overlapping groups are renumbered. Valid numbers are kept.' : 'Rewrites the positions 1, 2, 3… in every group.', true)}
                                    {useChannelNumbers && tool('reference_numbering', <Hash className="h-4 w-4" />, 'Number from the reference',
                                        'TF1 1, France 2 2… for every recognised channel, then settles the rest.', true)}
                                    {tool('dedupe', <CopyX className="h-4 w-4" />, 'Remove duplicates', 'The same provider stream twice: the first one stays.')}
                                    {tool('repair_dead', <HeartPulse className="h-4 w-4" />, 'Repair dead channels', 'Replaces streams the provider dropped by the same channel under its new id or at the other provider.')}
                                    {tool('auto_match', <Tv className="h-4 w-4" />, 'Match guides automatically', 'Proposes a guide id for channels that have none.')}
                                    {tool('refresh_rules', <Repeat className="h-4 w-4" />, 'Refresh rule groups now', 'Adds the provider\'s new matching channels (runs every hour anyway).')}
                                    <div className="border-t my-1" />
                                    {menu(<ListPlus className="h-4 w-4" />, 'Missing reference channels', 'France 2 and others the providers carry but this playlist lacks.', () => setHealthTab('missing'))}
                                    {menu(<Type className="h-4 w-4" />, 'Rename channels by rules…', 'Remove "FR|", "HD", "(1080p)"… with a preview.', () => setRenameOpen(true))}
                                    {menu(<MonitorPlay className="h-4 w-4" />, 'Preview as on the TV', 'Groups, numbers, logos, now and next.', () => setTvOpen(true))}
                                    {menu(<History className="h-4 w-4" />, 'Versions…', 'Save the playlist under a name, restore an earlier state.', () => setVersionsOpen(true))}
                                    <div className="border-t my-1" />
                                    <button type="button" className="w-full flex items-center gap-2 px-3 py-2 text-left text-sm hover:bg-muted"
                                        onClick={() => navigate(`/live-organizer?playlist_id=${playlist.id}`)}>
                                        <Wand2 className="h-4 w-4 text-primary" /> Re-run the Auto Organizer on this playlist
                                    </button>
                                    <button type="button" className="w-full flex items-center gap-2 px-3 py-2 text-left text-sm hover:bg-muted"
                                        onClick={() => copy(playerUrls(playlist).m3u, 'Playlist')}>
                                        <Copy className="h-4 w-4 text-primary" /> Copy the playlist URL (M3U)
                                    </button>
                                    <button type="button" className="w-full flex items-center gap-2 px-3 py-2 text-left text-sm hover:bg-muted"
                                        onClick={() => copy(playerUrls(playlist).xml, 'Guide')}>
                                        <Copy className="h-4 w-4 text-primary" /> Copy the guide URL (XMLTV)
                                    </button>
                                    <button type="button" className="w-full flex items-center gap-2 px-3 py-2 text-left text-sm hover:bg-muted"
                                        onClick={() => { setToolsOpen(false); setIsPreviewOpen(true); }}>
                                        <Eye className="h-4 w-4 text-primary" /> Preview the M3U
                                    </button>
                                    <button type="button" className="w-full flex items-center gap-2 px-3 py-2 text-left text-sm hover:bg-muted"
                                        onClick={() => window.open(`/api/v1/live/playlist.m3u?playlist_id=${playlist.public_id ?? playlist.id}`, '_blank')}>
                                        <ExternalLink className="h-4 w-4 text-primary" /> Open the M3U file
                                    </button>
                                    <button type="button" className="w-full flex items-center gap-2 px-3 py-2 text-left text-sm hover:bg-muted"
                                        onClick={() => { setToolsOpen(false); setIsResetOpen(true); }}>
                                        <RefreshCw className="h-4 w-4 text-primary" /> Reload from the server (Alt+R)
                                    </button>
                                </div>
                            )}
                        </div>

                        <Button variant={libraryHidden ? 'outline' : 'secondary'} size="sm" className="gap-1.5"
                            onClick={() => setLibraryHidden(!libraryHidden)} title={libraryHidden ? 'Show the library' : 'Hide the library to give the channel list more room'}>
                            <Library className="h-4 w-4" /> <span className="hidden xl:inline">Library</span>
                        </Button>
                        <Button variant={compactMode ? 'default' : 'outline'} size="sm" className="h-8 w-8 p-0"
                            onClick={() => setCompactMode(!compactMode)} title={compactMode ? "Comfortable rows" : "Compact rows"} aria-label="Toggle compact rows">
                            {compactMode ? <Maximize2 className="h-4 w-4" /> : <Minimize2 className="h-4 w-4" />}
                        </Button>
                        <div className="hidden md:block">{statusBadge}</div>
                    </div>
                </header>

                <PlaylistStatistics onOpenHealth={setHealthTab} />

                <div className="flex-1 flex flex-col lg:flex-row gap-3 min-h-0 p-3 overflow-auto lg:overflow-hidden">
                    <Rail collapsed={libraryHidden} onExpand={() => setLibraryHidden(false)} label="Library" width="w-full lg:w-72 xl:w-80 2xl:w-96 h-[28rem] lg:h-auto">
                        <ErrorBoundary label="The library"><LibraryPanel onCollapse={() => setLibraryHidden(true)} /></ErrorBoundary>
                    </Rail>
                    <Rail collapsed={groupsHidden} onExpand={() => setGroupsHidden(false)} label="Groups" width="w-full lg:w-52 xl:w-60 h-72 lg:h-auto">
                        <BouquetList onCollapse={() => setGroupsHidden(true)} />
                    </Rail>
                    <div className="flex-1 min-w-0 min-h-[24rem] lg:min-h-0 flex flex-col">
                        <ErrorBoundary label="The channel list"><CompositeList compactMode={compactMode} onBulkRename={() => setRenameOpen(true)} /></ErrorBoundary>
                    </div>
                </div>

                <DragOverlay dropAnimation={null}>
                    {dragLabel ? (
                        <div className="px-3 py-1.5 rounded-md bg-primary text-primary-foreground text-xs font-semibold shadow-xl max-w-xs truncate">
                            {dragLabel}
                        </div>
                    ) : null}
                </DragOverlay>

                <EPGMappingModal />
                <M3UPreviewModal isOpen={isPreviewOpen} onClose={() => setIsPreviewOpen(false)} playlistId={playlist.id} />
                <CommandPalette isOpen={paletteOpen} onClose={() => setPaletteOpen(false)} />
                <HealthPanel isOpen={healthTab !== null} initialTab={healthTab ?? 'issues'} onClose={() => setHealthTab(null)} />
                <BulkRenameDialog isOpen={renameOpen} onClose={() => setRenameOpen(false)} />
                <VersionsDialog isOpen={versionsOpen} onClose={() => setVersionsOpen(false)} />
                <TvPreview isOpen={tvOpen} onClose={() => setTvOpen(false)} />
                <PlaylistSettingsDialog isOpen={settingsOpen} onClose={() => setSettingsOpen(false)} />
                <ConfirmDialog
                    isOpen={confirmTool !== null}
                    onClose={() => setConfirmTool(null)}
                    onConfirm={() => { if (confirmTool) runServerTool(confirmTool); }}
                    title={confirmTool === 'reference_numbering' ? 'Number from the reference' : 'Fix the numbering'}
                    confirmLabel="Renumber"
                >
                    <p>
                        {confirmTool === 'reference_numbering'
                            ? 'Recognised channels take their official number; the others follow them. This changes the numbers TiviMate shows.'
                            : 'Each group gets a number range; channels numbered 0, twice, or inside another group\'s range get a new number. Valid numbers are kept.'}
                    </p>
                    <p className="text-muted-foreground">Ctrl+Z puts every number back.</p>
                </ConfirmDialog>
                <ConfirmDialog
                    isOpen={isResetOpen}
                    onClose={() => setIsResetOpen(false)}
                    onConfirm={() => { resetPlaylist(); setIsResetOpen(false); }}
                    title="Reload from the server"
                    confirmLabel="Reload"
                >
                    <p>Reload this playlist from the server?</p>
                    <p className="text-muted-foreground">
                        Every change is saved as you make it, so nothing is lost. The undo history is cleared.
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
        if (!playlistId) navigate('/live-playlists');
    }, [playlistId, navigate]);

    if (!playlistId) return null;

    return (
        <ErrorBoundary label="The playlist editor">
            <LiveSelectionProvider key={playlistId}>
                <LiveSelectionLayout playlistId={playlistId} />
            </LiveSelectionProvider>
        </ErrorBoundary>
    );
}
