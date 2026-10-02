import { FC, useMemo, useState } from 'react';
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Plus, GripVertical, Copy, Download, Upload, ChevronLeft, Trash2, Settings2 } from 'lucide-react';
import { useLiveSelection, editKey, parseRule, PlaylistBouquet } from '@/contexts/LiveSelectionContext';
import { SortableContext, verticalListSortingStrategy, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { GroupSettingsDialog } from './GroupSettingsDialog';

const ACTION = "h-6 w-6 opacity-40 group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100";

interface ItemProps {
    b: PlaylistBouquet;
    isSelected: boolean;
    label: string;
    problems: { dead: number; noGuide: number };
    onSelect: (b: PlaylistBouquet) => void;
    onSettings: (b: PlaylistBouquet) => void;
    onDelete: (b: PlaylistBouquet) => void;
}

const GroupItem: FC<ItemProps> = ({ b, isSelected, label, problems, onSelect, onSettings, onDelete }) => {
    const {
        editingId, editValue, setEditValue, startEditing, saveEdit, cancelEditing,
        duplicateBouquet, exportBouquet, compactMode,
    } = useLiveSelection();
    const { attributes, listeners, setNodeRef, transform, transition, isDragging, isOver, active } =
        useSortable({ id: `bouquet-${b.id}` });

    const activeId = String(active?.id ?? '');
    // A channel, or a pick from the library, dragged over a group lands in it.
    const receives = isOver && !isSelected && (activeId.startsWith('channel-') || activeId.startsWith('lib|'));
    const isEditing = editingId === editKey('b', b.id);
    const range = b.number_start != null || b.number_end != null ? `${b.number_start ?? '…'}–${b.number_end ?? '…'}` : null;
    const shown = b.channels.filter(c => !c.is_excluded).length;

    return (
        <div
            ref={setNodeRef}
            style={{ transform: CSS.Transform.toString(transform), transition, zIndex: isDragging ? 10 : 1, opacity: isDragging ? 0.5 : 1 }}
            className={`group flex items-start gap-1.5 border-l-4 cursor-pointer ${compactMode ? 'px-1.5 py-1' : 'px-2 py-1.5'}
                ${isSelected ? 'bg-indigo-500/10 border-indigo-500' : 'border-transparent hover:bg-muted/40'}
                ${receives ? 'bg-emerald-500/15 border-emerald-500 ring-2 ring-inset ring-emerald-500' : ''}`}
            onClick={() => onSelect(b)}
        >
            <div {...attributes} {...listeners} className="cursor-grab hover:text-primary pt-0.5" title="Drag to reorder">
                <GripVertical className="h-3.5 w-3.5 opacity-50" />
            </div>
            <div className="flex-1 min-w-0">
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
                    // Wraps on two lines instead of truncating: 4 of 8 names were cut.
                    <span className="text-xs font-semibold leading-tight line-clamp-2 break-words" title={`${label} — double-click to rename`}
                        onDoubleClick={e => { e.stopPropagation(); startEditing(editKey('b', b.id), b.custom_name || ''); }}>
                        {label}
                    </span>
                )}
                <div className="flex flex-wrap items-center gap-1 mt-0.5">
                    <span className="text-[10px] text-muted-foreground font-medium">{shown}</span>
                    {range && <span className="text-[9px] px-1 rounded bg-muted text-muted-foreground font-mono">{range}</span>}
                    {parseRule(b.rule) && <span className="text-[9px] px-1 rounded bg-violet-500/15 text-violet-600 dark:text-violet-300" title="Rule group">Auto</span>}
                    {b.category_id && <span className="text-[9px] px-1 rounded bg-primary/10 text-primary" title="Smart group: follows a provider category">Smart</span>}
                    {problems.dead > 0 && <span className="text-[9px] px-1 rounded bg-destructive/15 text-destructive" title="Channels the provider no longer serves">{problems.dead} dead</span>}
                </div>
            </div>
            <div className="flex flex-col items-center">
                <Button size="icon" variant="ghost" className={ACTION}
                    onClick={(e) => { e.stopPropagation(); onSettings(b); }} title="Settings: name, number range, rule" aria-label={`Settings of ${label}`}>
                    <Settings2 className="h-3 w-3" />
                </Button>
                {!compactMode && (
                    <div className="hidden group-hover:flex flex-col items-center [@media(hover:none)]:flex">
                        <Button size="icon" variant="ghost" className={ACTION}
                            onClick={(e) => { e.stopPropagation(); duplicateBouquet(b.id); }} title="Duplicate" aria-label={`Duplicate ${label}`}>
                            <Copy className="h-3 w-3" />
                        </Button>
                        <Button size="icon" variant="ghost" className={ACTION}
                            onClick={(e) => { e.stopPropagation(); exportBouquet(b.id); }} title="Export as JSON" aria-label={`Export ${label}`}>
                            <Download className="h-3 w-3" />
                        </Button>
                        <Button size="icon" variant="ghost" className={`${ACTION} text-destructive`}
                            onClick={(e) => { e.stopPropagation(); onDelete(b); }} title="Delete" aria-label={`Delete ${label}`}>
                            <Trash2 className="h-3 w-3" />
                        </Button>
                    </div>
                )}
            </div>
        </div>
    );
};

export const BouquetList: FC<{ onCollapse?: () => void }> = ({ onCollapse }) => {
    const {
        playlist, selectedBouquetId, setSelectedBouquetId, bouquetLabel,
        addVirtualBouquet, deleteBouquet, importBouquet,
        sourceSubscriptionId, setSourceSubscriptionId, setSelectedCategory, health,
    } = useLiveSelection();

    const [isAdding, setIsAdding] = useState(false);
    const [newName, setNewName] = useState("");
    const [toDelete, setToDelete] = useState<PlaylistBouquet | null>(null);
    const [settingsFor, setSettingsFor] = useState<PlaylistBouquet | null>(null);

    const groups = useMemo(() => playlist?.bouquets ? [...playlist.bouquets].sort((a, b) => a.order - b.order) : [], [playlist]);

    const problems = useMemo(() => {
        const out = new Map<number, { dead: number; noGuide: number }>();
        groups.forEach(b => {
            let dead = 0, noGuide = 0;
            b.channels.forEach(c => {
                const e = health?.channels[String(c.id)];
                if (!e || c.is_excluded) return;
                if (!e.served) dead++;
                else if (e.guide !== 'live') noGuide++;
            });
            out.set(b.id, { dead, noGuide });
        });
        return out;
    }, [groups, health]);

    const add = async () => {
        if (!newName.trim()) return;
        await addVirtualBouquet(newName);
        setNewName("");
        setIsAdding(false);
    };

    const select = (b: PlaylistBouquet) => {
        setSelectedBouquetId(b.id);
        if (b.category_id) {
            if (b.subscription_id && b.subscription_id !== sourceSubscriptionId) setSourceSubscriptionId(b.subscription_id);
            setSelectedCategory(b.category_id);
        }
    };

    // Groups open live from the settings: keep the dialog on the fresh object.
    const settingsGroup = settingsFor ? groups.find(g => g.id === settingsFor.id) ?? null : null;

    return (
        <Card className="flex flex-col h-full min-h-0 border-indigo-500/20 shadow-sm overflow-hidden">
            <div className="flex items-center justify-between px-3 py-2 border-b bg-indigo-500/5">
                <span className="text-sm font-bold">Groups <span className="text-muted-foreground font-normal text-xs">{groups.length}</span></span>
                <div className="flex items-center gap-0.5">
                    <Button size="icon" variant="ghost" className="h-6 w-6 text-muted-foreground"
                        onClick={() => document.getElementById('bouquet-import-input')?.click()} title="Import a group from a JSON file" aria-label="Import a group">
                        <Upload className="h-3.5 w-3.5" />
                    </Button>
                    <input id="bouquet-import-input" type="file" accept=".json" className="hidden"
                        onChange={(e) => { const file = e.target.files?.[0]; if (file) importBouquet(file); e.target.value = ''; }} />
                    <Button size="icon" variant="ghost" className="h-6 w-6 text-indigo-500" onClick={() => setIsAdding(true)} title="New group" aria-label="New group">
                        <Plus className="h-4 w-4" />
                    </Button>
                    {onCollapse && (
                        <Button size="icon" variant="ghost" className="h-6 w-6 text-muted-foreground" onClick={onCollapse} title="Collapse" aria-label="Collapse the groups">
                            <ChevronLeft className="h-3 w-3" />
                        </Button>
                    )}
                </div>
            </div>
            {isAdding && (
                <div className="p-2 flex gap-1 border-b">
                    <input autoFocus className="flex-1 min-w-0 text-xs p-1 border rounded bg-background" placeholder="Group name…"
                        value={newName} onChange={e => setNewName(e.target.value)}
                        onKeyDown={e => {
                            if (e.key === 'Enter') add();
                            if (e.key === 'Escape') { setIsAdding(false); setNewName(""); }
                        }} />
                    <Button size="sm" className="h-7 px-2" onClick={add}>Add</Button>
                </div>
            )}
            <div className="flex-1 overflow-y-auto scrollbar-thin divide-y">
                <SortableContext items={groups.map(b => `bouquet-${b.id}`)} strategy={verticalListSortingStrategy}>
                    {groups.map(b => (
                        <GroupItem key={b.id} b={b} isSelected={selectedBouquetId === b.id} label={bouquetLabel(b)}
                            problems={problems.get(b.id) ?? { dead: 0, noGuide: 0 }}
                            onSelect={select} onSettings={setSettingsFor} onDelete={setToDelete} />
                    ))}
                </SortableContext>
                {groups.length === 0 && (
                    <p className="p-6 text-center text-xs text-muted-foreground italic">No group yet. Use + to create one.</p>
                )}
            </div>
            {groups.length > 0 && (
                <p className="px-3 py-1.5 text-[10px] text-muted-foreground border-t">Drop channels on a group to move or add them.</p>
            )}

            <GroupSettingsDialog group={settingsGroup} onClose={() => setSettingsFor(null)} />
            <ConfirmDialog
                isOpen={!!toDelete}
                onClose={() => setToDelete(null)}
                onConfirm={() => { if (toDelete) deleteBouquet(toDelete.id); setToDelete(null); }}
                title="Delete group"
                variant="destructive"
                confirmLabel="Delete group"
            >
                <p>Delete <strong>{toDelete ? bouquetLabel(toDelete) : ''}</strong> and its {toDelete?.channels.length ?? 0} channel(s)?</p>
                <p className="text-muted-foreground">The channels stay available in the library. Ctrl+Z brings the group back.</p>
            </ConfirmDialog>
        </Card>
    );
};
