import { FC, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Plus, ListPlus, Pencil, Trash2, GripVertical, Copy, Download, Upload, ChevronLeft } from 'lucide-react';
import { useLiveSelection, editKey } from '@/contexts/LiveSelectionContext';
import {
    SortableContext,
    verticalListSortingStrategy,
    useSortable
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';

// Row actions stay faintly visible: on a touch screen there is no hover to reveal them.
const ACTION = "h-6 w-6 opacity-50 group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100";

interface SortableBouquetItemProps {
    b: any;
    isSelected: boolean;
    label: string;
    editingId: string | null;
    editValue: string;
    setEditValue: (val: string) => void;
    startEditing: (id: string, value: string) => void;
    saveEdit: () => void;
    cancelEditing: () => void;
    onRequestDelete: (bouquet: any) => void;
    duplicateBouquet: (id: number) => void;
    exportBouquet: (id: number) => void;
    onSelect: (b: any) => void;
    compactMode: boolean;
}

const SortableBouquetItem: FC<SortableBouquetItemProps> = ({
    b, isSelected, label, editingId, editValue, setEditValue,
    startEditing, saveEdit, cancelEditing, onRequestDelete, duplicateBouquet, exportBouquet,
    onSelect, compactMode
}) => {
    const {
        attributes,
        listeners,
        setNodeRef,
        transform,
        transition,
        isDragging,
        isOver,
        active,
    } = useSortable({ id: `bouquet-${b.id}` });

    const style = {
        transform: CSS.Transform.toString(transform),
        transition,
        zIndex: isDragging ? 10 : 1,
        opacity: isDragging ? 0.5 : 1,
    };

    // A channel dragged over a group is about to be moved into it.
    const receivesChannel = isOver && !isSelected && String(active?.id ?? '').startsWith('channel-');
    const isEditing = editingId === editKey('b', b.id);

    return (
        <div
            ref={setNodeRef}
            style={style}
            className={`group flex items-center gap-2 border-l-4 cursor-pointer ${isSelected ? 'bg-indigo-500/10 border-indigo-500' : 'border-transparent hover:bg-muted/40'} ${isDragging ? 'shadow-lg border-primary' : ''} ${receivesChannel ? 'bg-emerald-500/15 border-emerald-500 ring-2 ring-inset ring-emerald-500' : ''} ${compactMode ? 'p-1' : 'p-2'}`}
            onClick={() => onSelect(b)}
        >
            <div {...attributes} {...listeners} className="cursor-grab hover:text-primary transition-colors" title="Drag to reorder">
                <GripVertical className="h-4 w-4 opacity-50" />
            </div>

            <div className="flex-1 truncate min-w-0">
                {isEditing ? (
                    <input
                        autoFocus
                        className="w-full text-xs p-1 border rounded bg-background"
                        value={editValue}
                        onChange={e => setEditValue(e.target.value)}
                        onKeyDown={e => {
                            if (e.key === 'Enter') saveEdit();
                            if (e.key === 'Escape') cancelEditing();
                        }}
                        onBlur={saveEdit}
                        onClick={e => e.stopPropagation()}
                        aria-label="Group name"
                    />
                ) : (
                    <>
                        <span
                            className={`font-medium truncate block ${compactMode ? 'text-xs' : 'text-sm'}`}
                            title={label}
                            onDoubleClick={e => { e.stopPropagation(); startEditing(editKey('b', b.id), b.custom_name || ''); }}
                        >
                            {label}
                        </span>
                        <div className="flex items-center gap-1.5 mt-0.5">
                            <span className="text-[10px] bg-indigo-500/10 text-indigo-500 px-1.5 py-0.5 rounded-full font-bold">
                                {b.channels.length} {b.channels.length === 1 ? 'channel' : 'channels'}
                            </span>
                            {b.category_id && (
                                <span
                                    className="text-[10px] bg-primary/10 text-primary px-1.5 py-0.5 rounded-full font-medium"
                                    title="Smart group: follows a provider category"
                                >
                                    Smart
                                </span>
                            )}
                        </div>
                    </>
                )}
            </div>

            <div className="flex items-center gap-0.5 flex-shrink-0">
                <Button
                    size="icon"
                    variant="ghost"
                    className={ACTION}
                    onClick={(e) => { e.stopPropagation(); startEditing(editKey('b', b.id), b.custom_name || ''); }}
                    title="Rename"
                    aria-label={`Rename ${label}`}
                >
                    <Pencil className="h-3 w-3" />
                </Button>
                <Button
                    size="icon"
                    variant="ghost"
                    className={ACTION}
                    onClick={(e) => { e.stopPropagation(); duplicateBouquet(b.id); }}
                    title="Duplicate"
                    aria-label={`Duplicate ${label}`}
                >
                    <Copy className="h-3 w-3" />
                </Button>
                <Button
                    size="icon"
                    variant="ghost"
                    className={ACTION}
                    onClick={(e) => { e.stopPropagation(); exportBouquet(b.id); }}
                    title="Export as JSON"
                    aria-label={`Export ${label}`}
                >
                    <Download className="h-3 w-3" />
                </Button>
                <Button
                    size="icon"
                    variant="ghost"
                    className={`${ACTION} text-destructive`}
                    onClick={(e) => {
                        e.stopPropagation();
                        onRequestDelete(b);
                    }}
                    title="Delete"
                    aria-label={`Delete ${label}`}
                >
                    <Trash2 className="h-3 w-3" />
                </Button>
            </div>
        </div>
    );
};

interface BouquetListProps {
    onCollapse?: () => void;
    compactMode?: boolean;
}

export const BouquetList: FC<BouquetListProps> = ({ onCollapse }) => {
    const {
        playlist,
        selectedBouquetId,
        setSelectedBouquetId,
        bouquetLabel,
        editingId,
        editValue,
        setEditValue,
        startEditing,
        cancelEditing,
        saveEdit,
        addVirtualBouquet,
        deleteBouquet,
        duplicateBouquet,
        exportBouquet,
        importBouquet,
        compactMode,
        sourceSubscriptionId,
        setSourceSubscriptionId,
        setSelectedCategory,
    } = useLiveSelection();

    const [isAddingBouquet, setIsAddingBouquet] = useState(false);
    const [newBouquetName, setNewBouquetName] = useState("");
    const [bouquetToDelete, setBouquetToDelete] = useState<any | null>(null);

    const handleAddBouquet = async () => {
        if (!newBouquetName.trim()) return;
        await addVirtualBouquet(newBouquetName);
        setNewBouquetName("");
        setIsAddingBouquet(false);
    };

    const handleSelect = (b: any) => {
        setSelectedBouquetId(b.id);
        // A smart group points at a provider category: show it in the library.
        if (b.category_id) {
            if (b.subscription_id && b.subscription_id !== sourceSubscriptionId) setSourceSubscriptionId(b.subscription_id);
            setSelectedCategory(b.category_id);
        }
    };

    const sortedBouquets = playlist?.bouquets ? [...playlist.bouquets].sort((a, b) => a.order - b.order) : [];

    return (
        <div className="flex flex-col h-full overflow-hidden">
            <Card className="flex flex-col h-full border-indigo-500/20 shadow-sm">
                <CardHeader className={`py-2.5 px-3 border-b bg-indigo-500/5 ${compactMode ? 'py-1.5' : ''}`}>
                    <CardTitle className="text-sm font-bold flex justify-between items-center">
                        <span className="flex items-center gap-2"><ListPlus className="h-4 w-4 text-indigo-500" /> 3. Groups</span>
                        <div className="flex items-center gap-1">
                            <Button
                                size="icon"
                                variant="ghost"
                                className="h-6 w-6 text-muted-foreground hover:text-indigo-500"
                                onClick={() => document.getElementById('bouquet-import-input')?.click()}
                                title="Import a group from a JSON file"
                                aria-label="Import a group"
                            >
                                <Upload className="h-3.5 w-3.5" />
                            </Button>
                            <input
                                id="bouquet-import-input"
                                type="file"
                                accept=".json"
                                className="hidden"
                                onChange={(e) => {
                                    const file = e.target.files?.[0];
                                    if (file) importBouquet(file);
                                    e.target.value = '';
                                }}
                            />
                            <Button
                                size="icon"
                                variant="ghost"
                                className="h-6 w-6 text-indigo-500"
                                onClick={() => setIsAddingBouquet(true)}
                                title="New group"
                                aria-label="New group"
                            >
                                <Plus className="h-4 w-4" />
                            </Button>
                            {onCollapse && (
                                <Button
                                    size="icon"
                                    variant="ghost"
                                    className="h-6 w-6 text-muted-foreground hover:text-foreground ml-1"
                                    onClick={onCollapse}
                                    title="Collapse this panel"
                                >
                                    <ChevronLeft className="h-3 w-3" />
                                </Button>
                            )}
                        </div>
                    </CardTitle>
                    {isAddingBouquet && (
                        <div className="mt-2 flex gap-1">
                            <input
                                autoFocus
                                className="flex-1 text-xs p-1 border rounded bg-background"
                                placeholder="Group name…"
                                value={newBouquetName}
                                onChange={e => setNewBouquetName(e.target.value)}
                                onKeyDown={e => {
                                    if (e.key === 'Enter') handleAddBouquet();
                                    if (e.key === 'Escape') { setIsAddingBouquet(false); setNewBouquetName(""); }
                                }}
                            />
                            <Button size="sm" className="h-7 px-2" onClick={handleAddBouquet}>Add</Button>
                            <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => setIsAddingBouquet(false)}>Cancel</Button>
                        </div>
                    )}
                </CardHeader>
                <CardContent className="flex-1 overflow-y-auto p-0 scrollbar-thin">
                    <div className="divide-y text-sm">
                        <SortableContext items={sortedBouquets.map(b => `bouquet-${b.id}`)} strategy={verticalListSortingStrategy}>
                            {sortedBouquets.map(b => (
                                <SortableBouquetItem
                                    key={b.id}
                                    b={b}
                                    isSelected={selectedBouquetId === b.id}
                                    label={bouquetLabel(b)}
                                    editingId={editingId}
                                    editValue={editValue}
                                    setEditValue={setEditValue}
                                    startEditing={startEditing}
                                    saveEdit={saveEdit}
                                    cancelEditing={cancelEditing}
                                    onRequestDelete={setBouquetToDelete}
                                    duplicateBouquet={duplicateBouquet}
                                    exportBouquet={exportBouquet}
                                    onSelect={handleSelect}
                                    compactMode={compactMode}
                                />
                            ))}
                        </SortableContext>
                        {sortedBouquets.length === 0 && (
                            <p className="p-6 text-center text-xs text-muted-foreground italic">
                                No group yet. Use + to create one, then add channels to it.
                            </p>
                        )}
                    </div>
                    {sortedBouquets.length > 0 && (
                        <p className="px-3 py-2 text-[10px] text-muted-foreground border-t">
                            Drag a channel onto a group to move it there.
                        </p>
                    )}
                </CardContent>
            </Card>

            <ConfirmDialog
                isOpen={!!bouquetToDelete}
                onClose={() => setBouquetToDelete(null)}
                onConfirm={() => {
                    deleteBouquet(bouquetToDelete.id);
                    setBouquetToDelete(null);
                }}
                title="Delete group"
                variant="destructive"
                confirmLabel="Delete group"
            >
                <p>
                    Delete <strong>{bouquetToDelete ? bouquetLabel(bouquetToDelete) : ''}</strong>
                    {bouquetToDelete ? ` and its ${bouquetToDelete.channels?.length ?? 0} channel(s)` : ''}?
                </p>
                <p className="text-muted-foreground">
                    The channels stay available in the library. Undo (Ctrl+Z) brings the group back, with its channels.
                </p>
            </ConfirmDialog>
        </div>
    );
};
