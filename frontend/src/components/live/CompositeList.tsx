import { FC, useState, useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Pencil, X, GripVertical, Trash2, Move, Info } from 'lucide-react';
import { Checkbox } from "@/components/ui/checkbox";
import { useLiveSelection, editKey } from '@/contexts/LiveSelectionContext';
import {
    SortableContext,
    rectSortingStrategy,
    useSortable
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { EPGDebugDialog } from './EPGDebugDialog';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';

const ACTION = "opacity-50 group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100";

interface SortableChannelItemProps {
    ch: any;
    label: string;
    editableName: string;
    editingId: string | null;
    editValue: string;
    setEditValue: (val: string) => void;
    startEditing: (id: string, value: string) => void;
    saveEdit: () => void;
    cancelEditing: () => void;
    setMappingId: (id: string | null) => void;
    removeStreamFromBouquet: (id: number) => void;
    isSelected: boolean;
    toggleSelection: (id: number) => void;
    compactMode: boolean;
    jumpToPosition: (id: number, value: number) => void;
    /** What the number box shows: the channel number, or the 1-based position. */
    badge: number;
    numbered: boolean;
    onDebug: (id: number) => void;
}

const SortableChannelItem: FC<SortableChannelItemProps> = ({
    ch, label, editableName, editingId, editValue, setEditValue,
    startEditing, saveEdit, cancelEditing, setMappingId, removeStreamFromBouquet,
    isSelected, toggleSelection, compactMode, jumpToPosition, badge, numbered, onDebug
}) => {
    const {
        attributes,
        listeners,
        setNodeRef,
        transform,
        transition,
        isDragging
    } = useSortable({ id: `channel-${ch.id}` });

    const style = {
        transform: CSS.Transform.toString(transform),
        transition,
        zIndex: isDragging ? 20 : 1,
        opacity: isDragging ? 0.5 : 1,
    };

    const hasGuide = !!ch.epg_channel_id;
    const isEditing = editingId === editKey('c', ch.id);

    return (
        <div
            ref={setNodeRef}
            style={style}
            className={`group flex flex-col ${compactMode ? 'gap-0.5 p-0.5' : 'gap-1.5 p-2'} bg-background hover:bg-muted/50 transition-colors ${isDragging ? 'shadow-xl border-primary ring-1 ring-primary' : ''}`}
        >
            <div className="flex items-center gap-1">
                <div className="flex items-center gap-1">
                    <div {...attributes} {...listeners} className="cursor-grab hover:text-primary transition-colors pr-1" title="Drag to reorder, or onto a group to move it">
                        <GripVertical className={`${compactMode ? 'h-3 w-3' : 'h-4 w-4'} opacity-50`} />
                    </div>
                    <Checkbox
                        checked={isSelected}
                        onCheckedChange={() => toggleSelection(ch.id)}
                        className={`${compactMode ? 'h-3 w-3' : 'h-3.5 w-3.5'}`}
                        aria-label={`Select ${label}`}
                    />
                    <div
                        className="flex items-center bg-muted/50 rounded border border-muted-foreground/20 px-1 py-0.5"
                        title={numbered
                            ? 'Channel number as the player shows it. Type another and press Enter.'
                            : 'Position in the group. Type another and press Enter.'}
                    >
                        {/* Remounted when the value changes: an uncontrolled input keeps the stale text otherwise. */}
                        <input
                            key={`${ch.id}-${badge}`}
                            type="text"
                            inputMode="numeric"
                            className={`${numbered ? 'w-9' : 'w-6'} ${compactMode ? 'text-[9px]' : 'text-[10px]'} bg-transparent font-bold text-center appearance-none focus:outline-none focus:ring-1 focus:ring-primary rounded h-3.5`}
                            defaultValue={badge}
                            onKeyDown={e => {
                                const input = e.target as HTMLInputElement;
                                if (e.key === 'Enter') {
                                    const val = parseInt(input.value, 10);
                                    if (!isNaN(val) && val !== badge) jumpToPosition(ch.id, val);
                                    input.blur();
                                }
                                if (e.key === 'Escape') {
                                    input.value = String(badge);
                                    input.blur();
                                }
                            }}
                            aria-label={numbered ? `Channel number of ${label}` : `Position of ${label}`}
                        />
                    </div>
                </div>

                <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1">
                        <div className="flex items-center gap-1.5 min-w-0 flex-1">
                            {isEditing ? (
                                <input
                                    autoFocus
                                    className={`flex-1 ${compactMode ? 'text-[10px] h-5' : 'text-xs h-6'} p-0.5 border rounded w-full bg-background`}
                                    value={editValue}
                                    onChange={e => setEditValue(e.target.value)}
                                    onKeyDown={e => {
                                        if (e.key === 'Enter') saveEdit();
                                        if (e.key === 'Escape') cancelEditing();
                                    }}
                                    onBlur={saveEdit}
                                    onClick={e => e.stopPropagation()}
                                    aria-label="Channel name"
                                />
                            ) : (
                                <>
                                    <span
                                        className={`font-bold line-clamp-2 leading-tight ${compactMode ? 'text-[10px]' : 'text-[12px]'} hover:text-primary cursor-text transition-colors flex-1`}
                                        title={`${label} — click to rename`}
                                        onClick={() => startEditing(editKey('c', ch.id), editableName)}
                                    >
                                        {label}
                                    </span>
                                    <span
                                        className={`text-[8px] px-1 py-0.5 rounded font-bold uppercase tracking-tighter border flex-shrink-0 ${hasGuide
                                            ? 'bg-emerald-500/10 text-emerald-600 border-emerald-500/20'
                                            : 'bg-amber-500/10 text-amber-600 border-amber-500/20'
                                            }`}
                                        title={hasGuide ? `Guide: ${ch.epg_channel_id}` : 'No guide mapped'}
                                    >
                                        {hasGuide ? 'EPG' : 'No EPG'}
                                    </span>
                                </>
                            )}
                        </div>
                        <Button
                            size="icon"
                            variant="ghost"
                            className={`h-5 w-5 ${ACTION}`}
                            onClick={() => startEditing(editKey('c', ch.id), editableName)}
                            title="Rename"
                            aria-label={`Rename ${label}`}
                        >
                            <Pencil className="h-3.5 w-3.5 text-muted-foreground" />
                        </Button>
                    </div>
                    {!compactMode && (
                        <div className="flex items-center gap-1 mt-0.5">
                            <span
                                className="text-[10px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded truncate max-w-[140px] font-medium"
                                title={ch.epg_channel_id || ''}
                            >
                                EPG: {ch.epg_channel_id || 'None'}
                            </span>
                            <Button
                                size="sm"
                                variant="link"
                                className={`h-4 p-0 text-[10px] text-primary ${ACTION}`}
                                onClick={() => setMappingId(String(ch.id))}
                            >
                                Edit
                            </Button>
                            <Button
                                size="sm"
                                variant="ghost"
                                className={`h-4 w-4 p-0 text-muted-foreground hover:text-primary ${ACTION}`}
                                onClick={() => onDebug(ch.id)}
                                title="Why this guide match?"
                                aria-label={`Why this guide match for ${label}`}
                            >
                                <Info className="h-3 w-3" />
                            </Button>
                        </div>
                    )}
                </div>

                <div className={`flex items-center gap-1 ${ACTION}`}>
                    <Button
                        size="icon"
                        variant="ghost"
                        className={`${compactMode ? 'h-6 w-6' : 'h-7 w-7'} text-destructive hover:bg-destructive/10`}
                        onClick={() => removeStreamFromBouquet(ch.id)}
                        title="Remove from the group"
                        aria-label={`Remove ${label}`}
                    >
                        <X className={`${compactMode ? 'h-3 w-3' : 'h-4 w-4'}`} />
                    </Button>
                </div>
            </div>
        </div>
    );
};

export const CompositeList: FC<{ compactMode: boolean }> = ({ compactMode }) => {
    const {
        playlist,
        selectedBouquetId,
        bouquetLabel,
        channelLabel,
        channelEditableName,
        editingId,
        editValue,
        setEditValue,
        startEditing,
        cancelEditing,
        saveEdit,
        setMappingId,
        removeStreamFromBouquet,
        selectedChannelIds,
        setSelectedChannelIds,
        toggleChannelSelection,
        bulkDeleteChannels,
        bulkMoveChannels,
        jumpToChannelPosition,
        useChannelNumbers,
    } = useLiveSelection();

    const [composerSearch, setComposerSearch] = useState("");
    const [isMoving, setIsMoving] = useState(false);
    const [debugChannelId, setDebugChannelId] = useState<number | null>(null);
    const [isBulkDeleteOpen, setIsBulkDeleteOpen] = useState(false);

    const currentBouquet = useMemo(() => {
        return playlist?.bouquets.find(b => b.id === selectedBouquetId);
    }, [playlist, selectedBouquetId]);

    // Real position of every channel in the full group, so the number box stays
    // truthful while the list is filtered.
    const rank = useMemo(() => {
        const map = new Map<number, number>();
        [...(currentBouquet?.channels ?? [])]
            .sort((a, b) => a.order - b.order)
            .forEach((c, i) => map.set(c.id, i + 1));
        return map;
    }, [currentBouquet]);

    const filteredChannels = useMemo(() => {
        if (!currentBouquet?.channels) return [];
        const needle = composerSearch.toLowerCase();
        return [...currentBouquet.channels]
            .sort((a, b) => a.order - b.order)
            .filter(c => !needle || channelLabel(c).toLowerCase().includes(needle));
    }, [currentBouquet, channelLabel, composerSearch]);

    const isAllSelected = useMemo(() => {
        if (filteredChannels.length === 0) return false;
        return filteredChannels.every(ch => selectedChannelIds.has(ch.id));
    }, [filteredChannels, selectedChannelIds]);

    const handleSelectAll = (checked: boolean) => {
        const next = new Set(selectedChannelIds);
        filteredChannels.forEach(ch => (checked ? next.add(ch.id) : next.delete(ch.id)));
        setSelectedChannelIds(next);
    };

    if (!currentBouquet) {
        return (
            <Card className="flex flex-col min-h-0 border-indigo-500/20 shadow-sm">
                <CardHeader className="py-2.5 px-3 border-b bg-indigo-500/5">
                    <CardTitle className="text-sm font-bold">4. Channels</CardTitle>
                </CardHeader>
                <CardContent className="flex-1 flex items-center justify-center p-8 text-center text-muted-foreground text-xs italic">
                    Select a group to see and order its channels
                </CardContent>
            </Card>
        );
    }

    return (
        <Card className="flex flex-col min-h-0 h-full border-indigo-500/20 shadow-sm">
            <CardHeader className="py-2.5 px-3 border-b bg-indigo-500/5">
                <CardTitle className="text-sm font-bold flex justify-between items-center">
                    <div className="flex items-center gap-2 min-w-0">
                        <Checkbox
                            checked={isAllSelected}
                            onCheckedChange={handleSelectAll}
                            className="h-3.5 w-3.5"
                            aria-label="Select every channel shown"
                        />
                        <span className="truncate" title={bouquetLabel(currentBouquet)}>
                            4. {bouquetLabel(currentBouquet)}
                        </span>
                    </div>
                    <span className="text-[10px] bg-indigo-500/10 text-indigo-500 px-2 py-0.5 rounded-full font-bold flex-shrink-0">
                        {composerSearch
                            ? `${filteredChannels.length} / ${currentBouquet.channels.length}`
                            : `${currentBouquet.channels.length}`} channels
                    </span>
                </CardTitle>
                <input
                    type="text"
                    placeholder="Filter this group…"
                    className="w-full mt-2 p-1.5 text-xs border rounded bg-background"
                    value={composerSearch}
                    onChange={(e) => setComposerSearch(e.target.value)}
                />
                {useChannelNumbers && (
                    <p className="mt-1 text-[10px] text-muted-foreground leading-tight">
                        Numbered playlist: the box is the channel number the player shows. Reordering keeps the
                        numbers of the group and reassigns them in the new order.
                    </p>
                )}

                {selectedChannelIds.size > 0 && (
                    <div className="mt-2 flex items-center justify-between bg-indigo-500/10 p-1.5 rounded border border-indigo-500/20 animate-in fade-in slide-in-from-top-1">
                        <span className="text-[10px] font-bold text-indigo-600 px-1">
                            {selectedChannelIds.size} selected
                        </span>
                        <div className="flex items-center gap-1">
                            <Button
                                size="sm"
                                variant="ghost"
                                className="h-6 px-2 text-[10px] gap-1 hover:bg-indigo-500/10"
                                onClick={() => setIsMoving(!isMoving)}
                            >
                                <Move className="h-3 w-3" /> Move to…
                            </Button>
                            <Button
                                size="sm"
                                variant="ghost"
                                className="h-6 px-2 text-[10px] gap-1 hover:bg-destructive/10 hover:text-destructive"
                                onClick={() => setIsBulkDeleteOpen(true)}
                            >
                                <Trash2 className="h-3 w-3" /> Remove
                            </Button>
                            <Button
                                size="sm"
                                variant="ghost"
                                className="h-6 px-2 text-[10px]"
                                onClick={() => { setSelectedChannelIds(new Set()); setIsMoving(false); }}
                            >
                                Clear
                            </Button>
                        </div>
                    </div>
                )}

                {selectedChannelIds.size > 0 && isMoving && (
                    <div className="mt-2 p-1.5 bg-background border rounded shadow-sm animate-in fade-in slide-in-from-top-1">
                        <p className="text-[10px] font-bold mb-1 text-muted-foreground">Move the selection to:</p>
                        <div className="flex flex-col gap-1 max-h-[150px] overflow-y-auto scrollbar-thin">
                            {playlist?.bouquets
                                .filter(b => b.id !== selectedBouquetId)
                                .map(b => (
                                    <Button
                                        key={b.id}
                                        variant="ghost"
                                        size="sm"
                                        className="h-7 justify-start text-[11px] px-2 py-1"
                                        onClick={() => {
                                            bulkMoveChannels(Array.from(selectedChannelIds), b.id);
                                            setIsMoving(false);
                                        }}
                                    >
                                        {bouquetLabel(b)}
                                    </Button>
                                ))
                            }
                            {(playlist?.bouquets?.length || 0) <= 1 && (
                                <p className="text-[10px] p-2 text-center text-muted-foreground italic">No other group available</p>
                            )}
                        </div>
                    </div>
                )}
            </CardHeader>
            <CardContent className="flex-1 overflow-y-auto p-0 scrollbar-thin">
                <div className="divide-y text-xs">
                    <SortableContext
                        items={filteredChannels.map(ch => `channel-${ch.id}`)}
                        strategy={rectSortingStrategy}
                    >
                        {/* As many columns as fit: the list uses the room it is given. */}
                        <div
                            className="grid gap-2"
                            style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 19rem), 1fr))' }}
                        >
                            {filteredChannels.map(ch => (
                                <SortableChannelItem
                                    key={ch.id}
                                    ch={ch}
                                    label={channelLabel(ch)}
                                    editableName={channelEditableName(ch)}
                                    editingId={editingId}
                                    editValue={editValue}
                                    setEditValue={setEditValue}
                                    startEditing={startEditing}
                                    saveEdit={saveEdit}
                                    cancelEditing={cancelEditing}
                                    setMappingId={setMappingId}
                                    removeStreamFromBouquet={removeStreamFromBouquet}
                                    isSelected={selectedChannelIds.has(ch.id)}
                                    toggleSelection={toggleChannelSelection}
                                    compactMode={compactMode}
                                    jumpToPosition={jumpToChannelPosition}
                                    badge={useChannelNumbers ? ch.order : (rank.get(ch.id) ?? 0)}
                                    numbered={useChannelNumbers}
                                    onDebug={setDebugChannelId}
                                />
                            ))}
                        </div>
                    </SortableContext>
                    {filteredChannels.length === 0 && (
                        <div className="p-8 text-center text-muted-foreground text-[10px] italic">
                            {composerSearch ? 'No channel matches the filter' : 'No channel in this group yet — add some from the library on the left'}
                        </div>
                    )}
                </div>
            </CardContent>

            <ConfirmDialog
                isOpen={isBulkDeleteOpen}
                onClose={() => setIsBulkDeleteOpen(false)}
                onConfirm={() => {
                    bulkDeleteChannels(Array.from(selectedChannelIds));
                    setIsBulkDeleteOpen(false);
                }}
                title="Remove channels from group"
                variant="destructive"
                confirmLabel={`Remove ${selectedChannelIds.size} channel(s)`}
            >
                <p>
                    Remove <strong>{selectedChannelIds.size}</strong> channel(s) from this group?
                </p>
                <p className="text-muted-foreground">
                    They stay available in the library and can be added back. Undo (Ctrl+Z) restores them.
                </p>
            </ConfirmDialog>

            <EPGDebugDialog
                channelId={debugChannelId}
                onClose={() => setDebugChannelId(null)}
            />
        </Card>
    );
};
