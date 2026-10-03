import { FC, useState, useMemo, useEffect, useRef, CSSProperties, memo } from 'react';
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
    Pencil, X, GripVertical, Trash2, Info, Tv, EyeOff, Eye, Radio, Wrench, Unlink, Sparkles,
    PlayCircle, Layers, Rows3, Columns3, Type, MoreVertical,
} from 'lucide-react';
import { Checkbox } from "@/components/ui/checkbox";
import { useLiveSelection, editKey, parseRule, PlaylistChannel, PlaylistBouquet, Effective } from '@/contexts/LiveSelectionContext';
import { SortableContext, verticalListSortingStrategy, rectSortingStrategy, useSortable } from '@dnd-kit/sortable';
import { useDroppable } from '@dnd-kit/core';
import { CSS } from '@dnd-kit/utilities';
// @ts-ignore
import { List } from 'react-window';
// @ts-ignore
import { AutoSizer } from 'react-virtualized-auto-sizer';
import { EPGDebugDialog } from './EPGDebugDialog';
import { ReplacementDialog } from './ReplacementDialog';
import { ProbeDialog } from './ProbeDialog';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';

type View = 'all' | 'shown' | 'hidden';
type Layout = 'list' | 'columns';

const MAX_PROBES = 20;

/** The guide as the player will show it — not merely "an id is filled in". */
const GuideChip: FC<{ e?: Effective; stored: string | null }> = ({ e, stored }) => {
    if (stored === '-' || e?.guide === 'detached') {
        return <span className="text-[9px] px-1 rounded border border-muted-foreground/20 text-muted-foreground flex-shrink-0" title="Guide detached on purpose: no tvg-id is published">no guide</span>;
    }
    if (!e) return <span className="text-[9px] px-1 rounded border text-muted-foreground/60 flex-shrink-0">…</span>;
    const styles: Record<string, [string, string, string]> = {
        live: ['bg-emerald-500/10 text-emerald-600 border-emerald-500/20', 'EPG', 'Schedule available'],
        listed: ['bg-amber-500/10 text-amber-600 border-amber-500/20', 'EPG ∅', 'The guide names this channel but has no programme for it'],
        unknown: ['bg-amber-500/10 text-amber-600 border-amber-500/20', 'EPG ?', 'No linked guide source knows this id'],
        none: ['bg-muted text-muted-foreground border-muted-foreground/20', 'No EPG', 'No guide id'],
    };
    const [cls, label, hint] = styles[e.guide ?? 'none'] ?? styles.none;
    const origin = e.epg_source === 'provider' ? ' (inherited from the provider)' : '';
    return (
        <span className={`text-[9px] px-1 py-px rounded font-bold border flex-shrink-0 ${cls}`}
            title={`${hint}${e.epg_id ? ` — ${e.epg_id}${origin}` : ''}`}>
            {label}
        </span>
    );
};

interface RowActions {
    toggle: (id: number) => void;
    jump: (id: number, value: number) => void;
    startEditing: (id: string, value: string) => void;
    setEditValue: (v: string) => void;
    saveEdit: () => void;
    cancelEditing: () => void;
    map: (id: number) => void;
    debug: (id: number) => void;
    remove: (id: number) => void;
    restore: (id: number) => void;
    repair: (id: number) => void;
    variants: (id: number) => void;
    probe: (id: number) => void;
}

interface RowProps {
    items: PlaylistChannel[];
    columns: number;
    /** A phone-width single column: the actions go behind one button. */
    narrow: boolean;
    groupNames: Map<number, string> | null;
    selected: Set<number>;
    highlightId: number | null;
    compact: boolean;
    numbered: boolean;
    rank: Map<number, number>;
    sortable: boolean;
    editingId: string | null;
    editValue: string;
    ruleGroupIds: Set<number>;
    actions: RowActions;
    labelOf: (c: PlaylistChannel) => string;
    editableOf: (c: PlaylistChannel) => string;
    effectiveOf: (id: number) => Effective | undefined;
    groupOf: (id: number) => number | undefined;
}

const ChannelCell = memo(({ ch, p, tile }: { ch: PlaylistChannel; p: RowProps; tile: boolean }) => {
    const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
        useSortable({ id: `channel-${ch.id}`, disabled: !p.sortable });
    const e = p.effectiveOf(ch.id);
    const label = p.labelOf(ch);
    const isEditing = p.editingId === editKey('c', ch.id);
    const badge = p.numbered ? ch.order : (p.rank.get(ch.id) ?? 0);
    const dead = e && !e.served && !ch.is_excluded;
    const groupId = p.groupOf(ch.id);
    const inRuleGroup = groupId !== undefined && p.ruleGroupIds.has(groupId);
    const a = p.actions;
    const icon = 'h-3.5 w-3.5';
    const [actionsOpen, setActionsOpen] = useState(false);
    const folded = !tile && p.narrow;

    // In columns the actions float over the name on hover: a 300 px cell has
    // no room for seven buttons beside a readable name.
    // On a phone-width row the same goes for a single column: seven buttons
    // left a name of three letters. They open from one button instead, and
    // close once one of them is used.
    const actions = (
        <div className={tile
            ? 'absolute right-1 top-1/2 -translate-y-1/2 hidden group-hover:flex group-focus-within:flex [@media(hover:none)]:flex items-center bg-background/95 border rounded shadow-sm z-10'
            : folded
                ? `absolute right-9 top-1/2 -translate-y-1/2 ${actionsOpen ? 'flex' : 'hidden'} items-center bg-background border rounded shadow-md z-10`
                : 'flex items-center opacity-40 group-hover:opacity-100 focus-within:opacity-100 [@media(hover:none)]:opacity-100'}
            onClick={folded ? () => setActionsOpen(false) : undefined}>
            <Button size="icon" variant="ghost" className="h-6 w-6" onClick={() => a.probe(ch.id)} title="Test the stream: does it play, in which quality" aria-label={`Test ${label}`}>
                <PlayCircle className={icon} />
            </Button>
            <Button size="icon" variant="ghost" className="h-6 w-6" onClick={() => a.variants(ch.id)} title="Other feeds of this channel (quality, provider)" aria-label={`Other feeds of ${label}`}>
                <Layers className={icon} />
            </Button>
            <Button size="icon" variant="ghost" className="h-6 w-6" onClick={() => a.map(ch.id)} title="Guide mapping" aria-label={`Guide of ${label}`}>
                <Tv className={icon} />
            </Button>
            {!tile && !p.compact && (
                <Button size="icon" variant="ghost" className="h-6 w-6" onClick={() => a.debug(ch.id)} title="Why this guide match?" aria-label={`Guide match details for ${label}`}>
                    <Info className={icon} />
                </Button>
            )}
            <Button size="icon" variant="ghost" className="h-6 w-6" onClick={() => a.startEditing(editKey('c', ch.id), p.editableOf(ch))} title="Rename" aria-label={`Rename ${label}`}>
                <Pencil className={icon} />
            </Button>
            {ch.is_excluded ? (
                <Button size="icon" variant="ghost" className="h-6 w-6 text-primary" onClick={() => a.restore(ch.id)} title="Show it in the player again" aria-label={`Show ${label}`}>
                    <Eye className={icon} />
                </Button>
            ) : (
                <Button size="icon" variant="ghost" className="h-6 w-6 text-destructive hover:bg-destructive/10" onClick={() => a.remove(ch.id)}
                    title={inRuleGroup ? 'Hide (a rule group remembers it as unwanted)' : 'Remove from the group'} aria-label={`Remove ${label}`}>
                    {inRuleGroup ? <EyeOff className={icon} /> : <X className={icon} />}
                </Button>
            )}
        </div>
    );

    return (
        <div
            ref={setNodeRef}
            style={{ transform: CSS.Transform.toString(transform), transition, height: '100%' }}
            className={`group relative flex items-center gap-1.5 px-1.5 bg-background hover:bg-muted/40 min-w-0
                ${tile ? 'border rounded-md' : 'border-b border-muted/40'}
                ${isDragging ? 'shadow-lg ring-1 ring-primary z-20 opacity-70' : ''}
                ${p.highlightId === ch.id ? 'bg-primary/15 ring-1 ring-inset ring-primary' : ''}
                ${ch.is_excluded ? 'opacity-50' : ''}
                ${dead ? 'bg-destructive/5 border-destructive/30' : ''}`}
        >
            {/* touch-none: on a touch screen the browser otherwise takes the
                gesture as a scroll and the drag never starts. */}
            <span {...attributes} {...listeners}
                className={`text-muted-foreground/50 ${p.sortable ? 'cursor-grab hover:text-primary touch-none' : 'opacity-30'}`}
                title={p.sortable ? 'Drag to reorder, or onto a group to move it' : 'Clear the filter (or open the group) to reorder'}>
                <GripVertical className="h-3.5 w-3.5" />
            </span>
            <Checkbox checked={p.selected.has(ch.id)} onCheckedChange={() => a.toggle(ch.id)}
                className="h-3.5 w-3.5" aria-label={`Select ${label}`} />
            <input
                key={`${ch.id}-${badge}`}
                type="text"
                inputMode="numeric"
                className={`${p.numbered ? 'w-11' : 'w-8'} flex-shrink-0 text-[11px] font-bold text-center bg-muted/50 border border-muted-foreground/20 rounded h-6 focus:outline-none focus:ring-1 focus:ring-primary
                    ${p.numbered && (badge < 1) ? 'text-destructive border-destructive/50' : ''}`}
                defaultValue={badge}
                title={p.numbered
                    ? 'Channel number as the player shows it. Type one and press Enter: a number held in this group pushes the following channels down.'
                    : 'Position in the group. Type another and press Enter.'}
                onKeyDown={ev => {
                    const input = ev.target as HTMLInputElement;
                    if (ev.key === 'Enter') {
                        const val = parseInt(input.value, 10);
                        if (!isNaN(val) && val !== badge) a.jump(ch.id, val);
                        input.blur();
                    }
                    if (ev.key === 'Escape') { input.value = String(badge); input.blur(); }
                }}
                onBlur={ev => { ev.target.value = String(badge); }}
                aria-label={p.numbered ? `Channel number of ${label}` : `Position of ${label}`}
            />
            <div className={`${p.compact ? 'w-5 h-5' : 'w-7 h-7'} rounded bg-muted flex-shrink-0 overflow-hidden flex items-center justify-center border`}>
                {e?.logo ? <img src={e.logo} className="w-full h-full object-contain" alt="" loading="lazy" /> : <Radio className="h-3 w-3 text-muted-foreground" />}
            </div>
            <div className="flex-1 min-w-0">
                {isEditing ? (
                    <input
                        autoFocus
                        className="w-full text-xs h-6 px-1 border rounded bg-background"
                        value={p.editValue}
                        onChange={ev => a.setEditValue(ev.target.value)}
                        onKeyDown={ev => {
                            if (ev.key === 'Enter') a.saveEdit();
                            if (ev.key === 'Escape') a.cancelEditing();
                        }}
                        onBlur={a.saveEdit}
                        aria-label="Channel name"
                    />
                ) : (
                    <>
                        <div className="flex items-center gap-1.5 min-w-0">
                            {/* Double-click to rename: a single click used to start editing by accident. */}
                            <span className="text-xs font-semibold truncate cursor-default"
                                title={`${label} — double-click to rename`}
                                onDoubleClick={() => a.startEditing(editKey('c', ch.id), p.editableOf(ch))}>
                                {label}
                            </span>
                            {p.groupNames && groupId !== undefined && (
                                <span className="text-[10px] text-muted-foreground truncate flex-shrink-0 max-w-[8rem]">· {p.groupNames.get(groupId)}</span>
                            )}
                        </div>
                        {!p.compact && (
                            <div className="text-[10px] text-muted-foreground truncate" title={e?.now ?? undefined}>
                                {dead ? <span className="text-destructive font-medium">Not served by the provider any more</span>
                                    : ch.is_excluded ? (inRuleGroup ? 'Hidden — the rule will not add it back' : 'Hidden from the player')
                                        : e?.now ? <>▶ {e.now}</>
                                            : e?.epg_id ? <span className="font-mono">{e.epg_id}</span> : ' '}
                            </div>
                        )}
                    </>
                )}
            </div>
            {dead ? (
                <Button size="sm" variant="outline" className="h-6 px-2 text-[10px] gap-1 border-destructive/40 text-destructive flex-shrink-0"
                    onClick={() => a.repair(ch.id)} title="Find the same channel under a new id or at another provider">
                    <Wrench className="h-3 w-3" /> Repair
                </Button>
            ) : (
                <GuideChip e={e} stored={ch.epg_channel_id} />
            )}
            {actions}
            {folded && (
                <Button size="icon" variant="ghost" className="h-7 w-7 flex-shrink-0" onClick={() => setActionsOpen(o => !o)}
                    aria-expanded={actionsOpen} aria-label={`Actions for ${label}`} title="Actions">
                    <MoreVertical className={icon} />
                </Button>
            )}
        </div>
    );
});

/** One virtual row: a single channel, or as many cells as there are columns. */
const Row = ({ index, style, ...p }: { index: number; style: CSSProperties } & RowProps) => {
    const cells = p.items.slice(index * p.columns, index * p.columns + p.columns);
    if (cells.length === 0) return null;
    if (p.columns === 1) {
        return <div style={style}><ChannelCell ch={cells[0]} p={p} tile={false} /></div>;
    }
    return (
        <div style={style}>
            <div className="h-full grid gap-1.5 px-1.5 py-[3px]" style={{ gridTemplateColumns: `repeat(${p.columns}, minmax(0, 1fr))` }}>
                {cells.map(ch => <ChannelCell key={ch.id} ch={ch} p={p} tile />)}
            </div>
        </div>
    );
};

export const CompositeList: FC<{ compactMode: boolean; onBulkRename?: () => void }> = ({ compactMode, onBulkRename }) => {
    const {
        playlist, selectedBouquetId, bouquetLabel, channelLabel, channelEditableName,
        editingId, editValue, setEditValue, startEditing, cancelEditing, saveEdit,
        setMappingId, removeStreamFromBouquet, selectedChannelIds, setSelectedChannelIds,
        toggleChannelSelection, bulkDeleteChannels, bulkMoveChannels, jumpToChannelPosition,
        useChannelNumbers, effectiveOf, focus, setFocus, highlightId, excludeChannels, setGuideMode,
    } = useLiveSelection();

    const [filter, setFilter] = useState("");
    const [view, setView] = useState<View>('all');
    const [layout, setLayoutState] = useState<Layout>(() => {
        try { return (localStorage.getItem('live-channel-layout') as Layout) || 'columns'; } catch { return 'columns'; }
    });
    const setLayout = (value: Layout) => {
        setLayoutState(value);
        try { localStorage.setItem('live-channel-layout', value); } catch { /* private mode */ }
    };
    const [moveTarget, setMoveTarget] = useState<string>("");
    const [debugChannelId, setDebugChannelId] = useState<number | null>(null);
    const [repairId, setRepairId] = useState<number | null>(null);
    const [variantsId, setVariantsId] = useState<number | null>(null);
    const [probeIds, setProbeIds] = useState<number[]>([]);
    const [isBulkDeleteOpen, setIsBulkDeleteOpen] = useState(false);
    const listRef = useRef<any>(null);
    const columnsRef = useRef(1);
    const { setNodeRef: setDropRef, isOver } = useDroppable({ id: 'composite-drop' });

    const currentBouquet = useMemo(
        () => playlist?.bouquets.find(b => b.id === selectedBouquetId) ?? null,
        [playlist, selectedBouquetId]);

    const groupIdOf = useMemo(() => {
        const map = new Map<number, number>();
        playlist?.bouquets.forEach(b => b.channels.forEach(c => map.set(c.id, b.id)));
        return map;
    }, [playlist]);

    const ruleGroupIds = useMemo(
        () => new Set((playlist?.bouquets ?? []).filter(b => parseRule(b.rule)).map(b => b.id)),
        [playlist]);

    // Focus mode lists channels from every group (e.g. the ones an issue names).
    const source: PlaylistChannel[] = useMemo(() => {
        if (focus && playlist) {
            const wanted = new Set(focus.ids);
            return playlist.bouquets.flatMap(b => b.channels.filter(c => wanted.has(c.id)));
        }
        return currentBouquet ? [...currentBouquet.channels].sort((a, b) => a.order - b.order) : [];
    }, [focus, playlist, currentBouquet]);

    const hiddenCount = useMemo(() => source.filter(c => c.is_excluded).length, [source]);

    const rank = useMemo(() => {
        const map = new Map<number, number>();
        (currentBouquet?.channels ?? []).forEach((c, i) => map.set(c.id, i + 1));
        return map;
    }, [currentBouquet]);

    const items = useMemo(() => {
        const needle = filter.trim().toLowerCase();
        return source.filter(c =>
            (view === 'all' || (view === 'hidden' ? c.is_excluded : !c.is_excluded))
            && (!needle || channelLabel(c).toLowerCase().includes(needle)
                || String(c.order) === needle
                || (effectiveOf(c.id)?.epg_id ?? '').toLowerCase().includes(needle)));
    }, [source, filter, view, channelLabel, effectiveOf]);

    useEffect(() => { setFilter(""); setView('all'); }, [selectedBouquetId, focus]);

    // Bring a channel found with Ctrl+K into view.
    useEffect(() => {
        if (highlightId === null) return;
        const index = items.findIndex(c => c.id === highlightId);
        if (index >= 0) {
            setTimeout(() => {
                try { listRef.current?.scrollToRow({ index: Math.floor(index / columnsRef.current), align: 'center' }); } catch { /* not mounted yet */ }
            }, 50);
        }
    }, [highlightId, items]);

    const isAllSelected = items.length > 0 && items.every(c => selectedChannelIds.has(c.id));
    const handleSelectAll = (checked: boolean) => {
        const next = new Set(selectedChannelIds);
        items.forEach(c => (checked ? next.add(c.id) : next.delete(c.id)));
        setSelectedChannelIds(next);
    };

    const actions: RowActions = useMemo(() => ({
        toggle: toggleChannelSelection,
        jump: jumpToChannelPosition,
        startEditing, setEditValue, saveEdit, cancelEditing,
        map: (id: number) => setMappingId(String(id)),
        debug: setDebugChannelId,
        remove: removeStreamFromBouquet,
        restore: (id: number) => excludeChannels([id], false),
        repair: setRepairId,
        variants: setVariantsId,
        probe: (id: number) => setProbeIds([id]),
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }), [playlist, useChannelNumbers, editingId]);

    const groupNames = useMemo(() => {
        if (!focus || !playlist) return null;
        return new Map(playlist.bouquets.map(b => [b.id, bouquetLabel(b)]));
    }, [focus, playlist, bouquetLabel]);

    if (!currentBouquet && !focus) {
        return (
            <Card className="flex flex-col min-h-0 h-full border-indigo-500/20 shadow-sm items-center justify-center p-8 text-center text-muted-foreground text-xs italic">
                Select a group to see and order its channels
            </Card>
        );
    }

    const sortable = !focus && !filter.trim() && view === 'all';
    const range = currentBouquet && (currentBouquet.number_start != null || currentBouquet.number_end != null)
        ? `${currentBouquet.number_start ?? '…'}–${currentBouquet.number_end ?? '…'}` : null;
    const rule = currentBouquet ? parseRule(currentBouquet.rule) : null;
    const otherGroups: PlaylistBouquet[] = (playlist?.bouquets ?? []).filter(b => focus || b.id !== selectedBouquetId);
    const selected = [...selectedChannelIds];
    const selectedHidden = selected.filter(id => playlist?.bouquets.some(b => b.channels.some(c => c.id === id && c.is_excluded)));
    const cellMin = compactMode ? 250 : 320;

    return (
        <Card ref={setDropRef}
            className={`flex flex-col min-h-0 h-full border-indigo-500/20 shadow-sm overflow-hidden ${isOver ? 'ring-2 ring-emerald-500' : ''}`}>
            <div className="px-3 py-2 border-b bg-indigo-500/5 space-y-1.5">
                <div className="flex items-center gap-2 min-w-0">
                    <Checkbox checked={isAllSelected} onCheckedChange={handleSelectAll} className="h-3.5 w-3.5" aria-label="Select every channel shown" />
                    {focus ? (
                        <>
                            <Sparkles className="h-3.5 w-3.5 text-amber-500 flex-shrink-0" />
                            <span className="text-sm font-bold truncate" title={focus.label}>{focus.label}</span>
                            <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px] ml-auto" onClick={() => setFocus(null)}>Back to the group</Button>
                        </>
                    ) : (
                        <>
                            <span className="text-sm font-bold truncate" title={bouquetLabel(currentBouquet!)}>{bouquetLabel(currentBouquet!)}</span>
                            {range && <span className="text-[10px] px-1.5 rounded-full bg-muted text-muted-foreground font-mono flex-shrink-0" title="Channel numbers this group owns">{range}</span>}
                            {rule && <span className="text-[10px] px-1.5 rounded-full bg-violet-500/15 text-violet-600 dark:text-violet-300 flex-shrink-0" title="Rule group: matching provider channels are added every hour">Auto</span>}
                            <span className="ml-auto text-[10px] bg-indigo-500/10 text-indigo-500 px-2 py-0.5 rounded-full font-bold flex-shrink-0">
                                {items.length !== source.length ? `${items.length} / ${source.length}` : source.length} channels
                            </span>
                        </>
                    )}
                    <div className="flex items-center border rounded-md flex-shrink-0" role="group" aria-label="Layout">
                        <button type="button" onClick={() => setLayout('list')} title="One column, with details"
                            className={`p-1 rounded-l-md ${layout === 'list' ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'}`}><Rows3 className="h-3.5 w-3.5" /></button>
                        <button type="button" onClick={() => setLayout('columns')} title="As many columns as fit (read left to right)"
                            className={`p-1 rounded-r-md ${layout === 'columns' ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'}`}><Columns3 className="h-3.5 w-3.5" /></button>
                    </div>
                </div>
                <div className="flex items-center gap-1.5">
                    <input
                        type="text"
                        placeholder="Filter by name, number or guide id…"
                        className="flex-1 min-w-0 p-1.5 text-xs border rounded bg-background"
                        value={filter}
                        onChange={(e) => setFilter(e.target.value)}
                    />
                    {(hiddenCount > 0 || view !== 'all') && (
                        <select className="h-7 text-[11px] border rounded bg-background px-1" value={view} onChange={e => setView(e.target.value as View)} aria-label="Which channels">
                            <option value="all">All</option>
                            <option value="shown">Shown only</option>
                            <option value="hidden">Hidden only ({hiddenCount})</option>
                        </select>
                    )}
                </div>
                {selected.length > 0 && (
                    <div className="flex flex-wrap items-center gap-1 bg-indigo-500/10 p-1 rounded border border-indigo-500/20">
                        <span className="text-[11px] font-bold text-indigo-600 px-1">{selected.length} selected</span>
                        <select className="h-6 text-[11px] border rounded bg-background px-1 max-w-[10rem]" value={moveTarget}
                            onChange={e => {
                                const id = Number(e.target.value);
                                if (id) bulkMoveChannels(selected, id);
                                setMoveTarget("");
                            }} aria-label="Move the selection to">
                            <option value="">Move to…</option>
                            {otherGroups.map(b => <option key={b.id} value={b.id}>{bouquetLabel(b)}</option>)}
                        </select>
                        {onBulkRename && (
                            <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px] gap-1" onClick={onBulkRename} title="Rename the selection with rules">
                                <Type className="h-3 w-3" /> Rename
                            </Button>
                        )}
                        <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px] gap-1" onClick={() => setProbeIds(selected.slice(0, MAX_PROBES))}
                            title={`Test the streams one by one (at most ${MAX_PROBES})`}>
                            <PlayCircle className="h-3 w-3" /> Test
                        </Button>
                        {selectedHidden.length > 0 ? (
                            <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px] gap-1" onClick={() => excludeChannels(selectedHidden, false)}>
                                <Eye className="h-3 w-3" /> Show
                            </Button>
                        ) : (
                            <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px] gap-1" onClick={() => excludeChannels(selected, true)} title="Keep them, but do not publish them">
                                <EyeOff className="h-3 w-3" /> Hide
                            </Button>
                        )}
                        <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px] gap-1" onClick={() => setGuideMode(selected, 'detach')} title="Publish no guide id for them">
                            <Unlink className="h-3 w-3" /> No guide
                        </Button>
                        <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px] gap-1 hover:text-destructive" onClick={() => setIsBulkDeleteOpen(true)}>
                            <Trash2 className="h-3 w-3" /> Remove
                        </Button>
                        <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px] ml-auto" onClick={() => setSelectedChannelIds(new Set())}>Clear</Button>
                    </div>
                )}
            </div>

            <div className="flex-1 min-h-0">
                {items.length === 0 ? (
                    <div className="p-8 text-center text-muted-foreground text-xs italic">
                        {filter || view !== 'all' ? 'No channel matches' : 'No channel in this group yet — drag some from the library, or press Ctrl+K'}
                    </div>
                ) : (
                    /* @ts-ignore */
                    <AutoSizer renderProp={({ height, width }: any) => {
                        const columns = layout === 'list' ? 1 : Math.max(1, Math.min(4, Math.floor((width - 8) / cellMin)));
                        columnsRef.current = columns;
                        const rowProps: RowProps = {
                            items, columns, narrow: columns === 1 && width < 480,
                            groupNames, selected: selectedChannelIds, highlightId, compact: compactMode,
                            numbered: useChannelNumbers, rank, sortable, editingId, editValue, ruleGroupIds, actions,
                            labelOf: channelLabel, editableOf: channelEditableName, effectiveOf,
                            groupOf: (id: number) => groupIdOf.get(id),
                        };
                        const rowHeight = (compactMode ? 30 : 40) + (columns > 1 ? 6 : 0);
                        return (
                            <SortableContext items={items.map(c => `channel-${c.id}`)}
                                strategy={columns > 1 ? rectSortingStrategy : verticalListSortingStrategy}>
                                {/* @ts-ignore */}
                                <List
                                    listRef={listRef}
                                    style={{ height, width }}
                                    rowCount={Math.ceil(items.length / columns)}
                                    rowHeight={rowHeight}
                                    rowProps={rowProps as any}
                                    rowComponent={Row as any}
                                    overscanCount={6}
                                />
                            </SortableContext>
                        );
                    }} />
                )}
            </div>

            <ConfirmDialog
                isOpen={isBulkDeleteOpen}
                onClose={() => setIsBulkDeleteOpen(false)}
                onConfirm={() => {
                    bulkDeleteChannels(selected);
                    setIsBulkDeleteOpen(false);
                }}
                title="Remove channels"
                variant="destructive"
                confirmLabel={`Remove ${selected.length} channel(s)`}
            >
                <p>Remove <strong>{selected.length}</strong> channel(s) from the playlist?</p>
                <p className="text-muted-foreground">
                    In a rule group they are hidden instead, so the rule does not add them back. Ctrl+Z restores them.
                </p>
            </ConfirmDialog>

            <EPGDebugDialog channelId={debugChannelId} onClose={() => setDebugChannelId(null)} />
            <ReplacementDialog channelId={repairId} onClose={() => setRepairId(null)} mode="repair" />
            <ReplacementDialog channelId={variantsId} onClose={() => setVariantsId(null)} mode="variants" />
            <ProbeDialog channelIds={probeIds} onClose={() => setProbeIds([])} />
        </Card>
    );
};
