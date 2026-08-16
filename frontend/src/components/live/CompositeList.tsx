import { FC, useState, useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Pencil, X, GripVertical, Trash2, Move, Info } from 'lucide-react';
import { Checkbox } from "@/components/ui/checkbox";
import { useLiveSelection } from '@/contexts/LiveSelectionContext';
import {
    SortableContext,
    rectSortingStrategy,
    verticalListSortingStrategy,
    useSortable
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { EPGDebugDialog } from './EPGDebugDialog';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';

interface SortableChannelItemProps {
    ch: any;
    customNames: Record<string, string>;
    sourceNames: Record<string, string>;
    editingId: string | null;
    editValue: string;
    setEditValue: (val: string) => void;
    startEditing: (id: string, value: string) => void;
    saveEdit: () => void;
    epgMappings: Record<string, string>;
    setMappingId: (id: string | null) => void;
    removeStreamFromBouquet: (id: number) => void;
    isSelected: boolean;
    toggleSelection: (id: number) => void;
    compactMode: boolean;
    jumpToPosition: (id: number, pos: number) => void;
    index: number;
    onDebug: (id: number) => void;
}

const SortableChannelItem: FC<SortableChannelItemProps> = ({
    ch, customNames, sourceNames, editingId, editValue, setEditValue,
    startEditing, saveEdit, epgMappings, setMappingId, removeStreamFromBouquet,
    isSelected, toggleSelection, compactMode, jumpToPosition, index, onDebug
}) => {
    // A channel row only stores a stream id; the readable name is either the
    // user's rename or the provider name resolved by the server.
    const displayName = (c: any) =>
        customNames[String(c.id)] || sourceNames[String(c.id)] || c.custom_name || `Channel ${c.stream_id}`;
    // When renaming, start from the real name rather than the placeholder so
    // the user edits text instead of deleting "Channel 48213".
    const editableName = (c: any) =>
        customNames[String(c.id)] || sourceNames[String(c.id)] || c.custom_name || '';

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

    return (
        <div
            ref={setNodeRef}
            style={style}
            className={`group flex flex-col ${compactMode ? 'gap-0.5 p-0.5' : 'gap-1.5 p-2'} bg-background hover:bg-muted/50 transition-colors ${isDragging ? 'shadow-xl border-primary ring-1 ring-primary' : ''}`}
        >
            <div className="flex items-center gap-1">
                <div className="flex items-center gap-1">
                    <div {...attributes} {...listeners} className="cursor-grab hover:text-primary transition-colors pr-1">
                        <GripVertical className={`${compactMode ? 'h-3 w-3' : 'h-4 w-4'} opacity-50`} />
                    </div>
                    <Checkbox
                        checked={isSelected}
                        onCheckedChange={() => toggleSelection(ch.id)}
                        className={`${compactMode ? 'h-3 w-3' : 'h-3.5 w-3.5'}`}
                    />
                    <div className="flex items-center bg-muted/50 rounded border border-muted-foreground/20 px-1 py-0.5">
                        <input
                            type="text"
                            className={`${compactMode ? 'w-5 text-[9px]' : 'w-6 text-[10px]'} bg-transparent font-bold text-center appearance-none focus:outline-none focus:ring-1 focus:ring-primary rounded h-3.5`}
                            defaultValue={index + 1}
                            onKeyDown={e => {
                                if (e.key === 'Enter') {
                                    const val = parseInt((e.target as HTMLInputElement).value);
                                    if (!isNaN(val)) jumpToPosition(ch.id, val);
                                    (e.target as HTMLInputElement).blur();
                                }
                            }}
                        />
                    </div>
                </div>

                <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1">
                        <div className="flex items-center gap-1.5 min-w-0 flex-1">
                            {editingId === String(ch.id) ? (
                                <input
                                    autoFocus
                                    className={`flex-1 ${compactMode ? 'text-[10px] h-5' : 'text-xs h-6'} p-0.5 border rounded w-full`}
                                    value={editValue}
                                    onChange={e => setEditValue(e.target.value)}
                                    onKeyDown={e => e.key === 'Enter' && saveEdit()}
                                    onClick={e => e.stopPropagation()}
                                />
                            ) : (
                                <>
                                    <span
                                        className={`font-bold line-clamp-2 leading-tight ${compactMode ? 'text-[10px]' : 'text-[12px]'} hover:text-primary cursor-text transition-colors flex-1`}
                                        title={`${displayName(ch)} — ID ${ch.stream_id} · click to rename`}
                                        onClick={() => startEditing(String(ch.id), editableName(ch))}
                                    >
                                        {displayName(ch)}
                                    </span>
                                    <span className={`text-[8px] px-1 py-0.5 rounded font-bold uppercase tracking-tighter border flex-shrink-0 ${(epgMappings[String(ch.id)] || ch.epg_channel_id)
                                        ? 'bg-emerald-500/10 text-emerald-600 border-emerald-500/20'
                                        : 'bg-amber-500/10 text-amber-600 border-amber-500/20'
                                        } ${compactMode ? 'scale-75 origin-left' : ''}`}>
                                        {(epgMappings[String(ch.id)] || ch.epg_channel_id) ? 'EPG' : 'NO'}
                                    </span>
                                </>
                            )}
                        </div>
                        <Button
                            size="icon"
                            variant="ghost"
                            className="h-5 w-5 opacity-0 group-hover:opacity-100"
                            onClick={() => startEditing(String(ch.id), editableName(ch))}
                        >
                            <Pencil className="h-3.5 w-3.5 text-muted-foreground" />
                        </Button>
                    </div>
                    {!compactMode && (
                        <div className="flex items-center gap-1 mt-0.5">
                            <span
                                className="text-[10px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded truncate max-w-[140px] font-medium"
                                title={epgMappings[String(ch.id)] || ch.epg_channel_id || ''}
                            >
                                EPG: {epgMappings[String(ch.id)] || ch.epg_channel_id || 'None'}
                            </span>
                            <Button
                                size="sm"
                                variant="link"
                                className="h-4 p-0 text-[10px] opacity-0 group-hover:opacity-100 text-primary"
                                onClick={() => setMappingId(String(ch.id))}
                            >
                                Edit
                            </Button>
                            <Button
                                size="sm"
                                variant="ghost"
                                className="h-4 w-4 p-0 opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-primary"
                                onClick={() => onDebug(ch.id)}
                                title="Debug EPG Match"
                            >
                                <Info className="h-3 w-3" />
                            </Button>
                        </div>
                    )}
                </div>

                <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    <Button
                        size="icon"
                        variant="ghost"
                        className={`${compactMode ? 'h-6 w-6' : 'h-7 w-7'} text-destructive hover:bg-destructive/10`}
                        onClick={() => removeStreamFromBouquet(ch.id)}
                        title="Remove"
                    >
                        <X className={`${compactMode ? 'h-3 w-3' : 'h-4 w-4'}`} />
                    </Button>
                </div>
            </div>
        </div>
    );
};

export const CompositeList: FC<{ columns?: number; compactMode: boolean }> = ({ columns = 1, compactMode }) => {
    const {
        playlist,
        selectedBouquetId,
        customNames,
        sourceNames,
        editingId,
        editValue,
        setEditValue,
        startEditing,
        saveEdit,
        epgMappings,
        setMappingId,
        removeStreamFromBouquet,
        selectedChannelIds,
        setSelectedChannelIds,
        toggleChannelSelection,
        bulkDeleteChannels,
        bulkMoveChannels,
        jumpToChannelPosition
    } = useLiveSelection();

    const [composerSearch, setComposerSearch] = useState("");
    const [isMoving, setIsMoving] = useState(false);
    const [debugChannelId, setDebugChannelId] = useState<number | null>(null);
    const [isBulkDeleteOpen, setIsBulkDeleteOpen] = useState(false);

    const currentBouquet = useMemo(() => {
        return playlist?.bouquets.find(b => b.id === selectedBouquetId);
    }, [playlist, selectedBouquetId]);

    const filteredChannels = useMemo(() => {
        if (!currentBouquet?.channels) return [];

        return [...currentBouquet.channels]
            .sort((a, b) => a.order - b.order)
            .filter(c => {
                const name = customNames[String(c.id)] || sourceNames[String(c.id)] || c.custom_name || String(c.stream_id);
                return !composerSearch || name.toLowerCase().includes(composerSearch.toLowerCase());
            });
    }, [currentBouquet, customNames, sourceNames, composerSearch]);

    const isAllSelected = useMemo(() => {
        if (filteredChannels.length === 0) return false;
        return filteredChannels.every(ch => selectedChannelIds.has(ch.id));
    }, [filteredChannels, selectedChannelIds]);

    const handleSelectAll = (checked: boolean) => {
        if (checked) {
            const newSelection = new Set(selectedChannelIds);
            filteredChannels.forEach(ch => newSelection.add(ch.id));
            setSelectedChannelIds(newSelection);
        } else {
            const newSelection = new Set(selectedChannelIds);
            filteredChannels.forEach(ch => newSelection.delete(ch.id));
            setSelectedChannelIds(newSelection);
        }
    };

    if (!currentBouquet) {
        return (
            <Card className="flex flex-col min-h-0 border-indigo-500/20 shadow-sm">
                <CardHeader className="py-2.5 px-3 border-b bg-indigo-500/5">
                    <CardTitle className="text-sm font-bold">Composite List</CardTitle>
                </CardHeader>
                <CardContent className="flex-1 flex items-center justify-center p-8 text-center text-muted-foreground text-xs italic">
                    Select a virtual group to view channels
                </CardContent>
            </Card>
        );
    }

    return (
        <Card className="flex flex-col min-h-0 border-indigo-500/20 shadow-sm">
            <CardHeader className="py-2.5 px-3 border-b bg-indigo-500/5">
                <CardTitle className="text-sm font-bold flex justify-between items-center">
                    <div className="flex items-center gap-2">
                        <Checkbox
                            checked={isAllSelected}
                            onCheckedChange={handleSelectAll}
                            className="h-3.5 w-3.5"
                        />
                        <span>Composite List</span>
                    </div>
                    <span className="text-[10px] bg-indigo-500/10 text-indigo-500 px-2 py-0.5 rounded-full font-bold">
                        {filteredChannels.length} Items
                    </span>
                </CardTitle>
                <input
                    type="text"
                    placeholder="Filter composition..."
                    className="w-full mt-2 p-1.5 text-xs border rounded bg-background"
                    value={composerSearch}
                    onChange={(e) => setComposerSearch(e.target.value)}
                />

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
                                <Move className="h-3 w-3" /> Move
                            </Button>
                            <Button
                                size="sm"
                                variant="ghost"
                                className="h-6 px-2 text-[10px] gap-1 hover:bg-destructive/10 hover:text-destructive"
                                onClick={() => setIsBulkDeleteOpen(true)}
                            >
                                <Trash2 className="h-3 w-3" /> Delete
                            </Button>
                        </div>
                    </div>
                )}

                {selectedChannelIds.size > 0 && isMoving && (
                    <div className="mt-2 p-1.5 bg-background border rounded shadow-sm animate-in fade-in slide-in-from-top-1">
                        <p className="text-[10px] font-bold mb-1 text-muted-foreground">Select Target Group:</p>
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
                                        {b.custom_name || (b.category_id ? `Smart: ${b.category_id}` : 'Unnamed Group')}
                                    </Button>
                                ))
                            }
                            {(playlist?.bouquets?.length || 0) <= 1 && (
                                <p className="text-[10px] p-2 text-center text-muted-foreground italic">No other groups available</p>
                            )}
                        </div>
                    </div>
                )}
            </CardHeader>
            <CardContent className="flex-1 overflow-y-auto p-0 scrollbar-thin">
                <div className="divide-y text-xs">
                    <SortableContext
                        items={filteredChannels.map(ch => `channel-${ch.id}`)}
                        strategy={columns > 1 ? rectSortingStrategy : verticalListSortingStrategy}
                    >
                        <div className={`
                            ${columns === 4 ? 'grid grid-cols-4 gap-2' :
                                columns === 3 ? 'grid grid-cols-3 gap-2' :
                                    columns === 2 ? 'grid grid-cols-2 gap-2' :
                                        'space-y-1.5'
                            }`}>
                            {filteredChannels.map((ch, idx) => (
                                <SortableChannelItem
                                    key={ch.id}
                                    ch={ch}
                                    customNames={customNames}
                                    sourceNames={sourceNames}
                                    editingId={editingId}
                                    editValue={editValue}
                                    setEditValue={setEditValue}
                                    startEditing={startEditing}
                                    saveEdit={saveEdit}
                                    epgMappings={epgMappings}
                                    setMappingId={setMappingId}
                                    removeStreamFromBouquet={removeStreamFromBouquet}
                                    isSelected={selectedChannelIds.has(ch.id)}
                                    toggleSelection={toggleChannelSelection}
                                    compactMode={compactMode}
                                    jumpToPosition={jumpToChannelPosition}
                                    index={idx}
                                    onDebug={setDebugChannelId}
                                />
                            ))}
                        </div>
                    </SortableContext>
                    {filteredChannels.length === 0 && (
                        <div className="p-8 text-center text-muted-foreground text-[10px] italic">
                            No channels added yet
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
                    They stay available in the library and can be added back. This can be undone with Ctrl+Z.
                </p>
            </ConfirmDialog>

            <EPGDebugDialog
                channelId={debugChannelId}
                onClose={() => setDebugChannelId(null)}
            />
        </Card>
    );
};
