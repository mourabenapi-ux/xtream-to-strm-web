import { useState, useMemo, FC, useEffect, useCallback, CSSProperties } from 'react';
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Check, Loader2, Radio, ArrowRight, ChevronLeft, ChevronDown, ChevronRight, ShoppingBasket, X, GripVertical } from 'lucide-react';
// @ts-ignore
import { List } from 'react-window';
// @ts-ignore
import { AutoSizer } from 'react-virtualized-auto-sizer';
import { useDraggable } from '@dnd-kit/core';
import { useLiveSelection, streamKey, BasketItem, Stream, Category } from '@/contexts/LiveSelectionContext';

/** "AR| BEIN SPORTS" -> "AR". Providers with 900 categories prefix them by region or quality. */
const prefixOf = (name: string) => {
    const found = /^\s*([^|:]{1,8}?)\s*[|:]/.exec(name);
    return found ? found[1].trim().toUpperCase() : null;
};

// ---------------------------------------------------------------- categories

const CategoryList: FC<{ height?: string }> = () => {
    const {
        allSubscriptions, sourceSubscriptionId, setSourceSubscriptionId, fetchCategories,
        categories, loadingCategories, selectedCategory, setSelectedCategory, health,
    } = useLiveSelection();
    const [filter, setFilter] = useState("");
    const [open, setOpen] = useState<Set<string>>(new Set());

    // How many of this playlist's channels come from each category.
    const used = useMemo(() => {
        const counts = new Map<string, number>();
        Object.values(health?.channels ?? {}).forEach(e => {
            if (e.served && e.subscription_id === sourceSubscriptionId && e.category_id) {
                counts.set(e.category_id, (counts.get(e.category_id) ?? 0) + 1);
            }
        });
        return counts;
    }, [health, sourceSubscriptionId]);

    const filtered = useMemo(() => {
        const needle = filter.trim().toLowerCase();
        return needle ? categories.filter(c => c.category_name.toLowerCase().includes(needle)) : categories;
    }, [categories, filter]);

    // Group by prefix when the list is long enough to need it.
    const sections = useMemo(() => {
        const byPrefix = new Map<string, Category[]>();
        filtered.forEach(c => {
            const prefix = prefixOf(c.category_name) ?? 'Other';
            if (!byPrefix.has(prefix)) byPrefix.set(prefix, []);
            byPrefix.get(prefix)!.push(c);
        });
        const grouped = categories.length > 40 && byPrefix.size > 1;
        return { grouped, entries: [...byPrefix.entries()].sort((a, b) => b[1].length - a[1].length) };
    }, [filtered, categories.length]);

    const changeProvider = (id: number) => {
        setSelectedCategory(null);
        setSourceSubscriptionId(id);
        setFilter("");
        fetchCategories(id);
    };

    const toggle = (prefix: string) => setOpen(prev => {
        const next = new Set(prev);
        if (next.has(prefix)) next.delete(prefix); else next.add(prefix);
        return next;
    });

    const row = (cat: Category) => {
        const count = used.get(cat.category_id);
        const isSelected = selectedCategory === cat.category_id;
        return (
            <button
                key={cat.category_id}
                type="button"
                className={`w-full text-left px-2 py-1.5 text-xs hover:bg-muted flex items-center justify-between gap-2 ${isSelected ? 'bg-primary/10 font-semibold text-primary' : ''}`}
                onClick={() => setSelectedCategory(cat.category_id)}
                title={cat.category_name}
            >
                <span className="truncate flex-1">{cat.category_name}</span>
                {cat.count !== undefined && (
                    <span className="flex-shrink-0 text-[10px] text-muted-foreground" title={`${cat.count} channel(s) in this category`}>{cat.count}</span>
                )}
                {count ? (
                    <span className="flex-shrink-0 text-[10px] px-1.5 rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                        title={`${count} channel(s) of this playlist come from here`}>
                        {count}
                    </span>
                ) : null}
            </button>
        );
    };

    return (
        <div className="flex flex-col min-h-0 h-full">
            <div className="p-2 space-y-1.5 border-b">
                <select
                    className="w-full text-xs p-1.5 border rounded bg-background"
                    value={sourceSubscriptionId || ''}
                    onChange={(e) => changeProvider(Number(e.target.value))}
                    aria-label="Provider to browse"
                >
                    {allSubscriptions.map(sub => <option key={sub.id} value={sub.id}>{sub.name}</option>)}
                </select>
                <input
                    type="text"
                    placeholder={`Filter ${categories.length} categories…`}
                    className="w-full p-1.5 text-xs border rounded bg-background"
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                />
            </div>
            <div className="flex-1 overflow-y-auto scrollbar-thin">
                {loadingCategories ? (
                    <div className="p-6 flex justify-center"><Loader2 className="h-5 w-5 animate-spin text-primary/40" /></div>
                ) : filtered.length === 0 ? (
                    <p className="p-4 text-center text-xs text-muted-foreground italic">
                        {categories.length === 0 ? 'No categories for this provider.' : 'No category matches the filter.'}
                    </p>
                ) : !sections.grouped ? (
                    <div className="divide-y">{filtered.map(row)}</div>
                ) : (
                    sections.entries.map(([prefix, list]) => {
                        const usedHere = list.reduce((n, c) => n + (used.get(c.category_id) ?? 0), 0);
                        const channelsHere = list.reduce((n, c) => n + (c.count ?? 0), 0);
                        const expanded = !!filter.trim() || open.has(prefix);
                        return (
                            <div key={prefix} className="border-b">
                                <button type="button" onClick={() => toggle(prefix)}
                                    className="w-full flex items-center gap-1.5 px-2 py-1.5 text-xs font-semibold hover:bg-muted bg-muted/30">
                                    {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                                    <span className="flex-1 text-left">{prefix}</span>
                                    {usedHere > 0 && <span className="text-[10px] text-emerald-600 dark:text-emerald-400">{usedHere} used</span>}
                                    <span className="text-[10px] text-muted-foreground font-normal" title={`${list.length} categories, ${channelsHere} channels`}>
                                        {list.length} · {channelsHere}
                                    </span>
                                </button>
                                {expanded && <div className="divide-y">{list.map(row)}</div>}
                            </div>
                        );
                    })
                )}
            </div>
        </div>
    );
};

// ---------------------------------------------------------------- channels

interface RowData {
    items: Stream[];
    basket: Map<string, BasketItem>;
    toggle: (item: BasketItem) => void;
    add: (item: BasketItem) => void;
    membership: Map<string, string>;
    subscriptionId: number;
    compact: boolean;
}

const itemOf = (stream: Stream, subscriptionId: number): BasketItem => ({
    key: streamKey(subscriptionId, stream.stream_id), subscription_id: subscriptionId, stream,
});

// Kept outside the component: react-window remounts every row whenever the
// row component's identity changes.
const StreamRow = ({ index, style, items, basket, toggle, add, membership, subscriptionId, compact }:
    { index: number; style: CSSProperties } & RowData) => {
    const s = items[index];
    const item = s ? itemOf(s, subscriptionId) : null;
    const inBasket = !!item && basket.has(item.key);
    // Dragging a ticked row carries the whole basket; an unticked one, itself.
    const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
        id: `lib|${item?.key ?? index}`,
        data: { items: item ? (inBasket && basket.size > 1 ? [...basket.values()] : [item]) : [] },
        disabled: !item,
    });
    if (!s || !item) return null;
    const inGroup = membership.get(item.key);

    return (
        <div
            ref={setNodeRef}
            style={style}
            className={`px-1.5 flex items-center gap-1.5 group hover:bg-muted border-b border-muted/30 ${inBasket ? 'bg-primary/5' : ''} ${isDragging ? 'opacity-40' : ''}`}
            onDoubleClick={() => add(item)}
        >
            <span {...attributes} {...listeners} className="cursor-grab text-muted-foreground/50 hover:text-primary" title="Drag onto a group">
                <GripVertical className="h-3.5 w-3.5" />
            </span>
            <input
                type="checkbox"
                className="h-3 w-3 rounded"
                checked={inBasket}
                onChange={() => toggle(item)}
                aria-label={`Pick ${s.name}`}
            />
            <div className={`${compact ? 'w-5 h-5' : 'w-7 h-7'} rounded bg-muted flex-shrink-0 overflow-hidden flex items-center justify-center border`}>
                {s.stream_icon ? <img src={s.stream_icon} className="w-full h-full object-contain" alt="" loading="lazy" /> : <Radio className="h-3 w-3 text-muted-foreground" />}
            </div>
            <span className="flex-1 min-w-0 cursor-pointer text-xs" onClick={() => toggle(item)} title={s.name}>
                <span className="block truncate">{s.name}</span>
                {inGroup && !compact && (
                    <span className="block truncate text-[10px] text-emerald-600 dark:text-emerald-400">in {inGroup}</span>
                )}
            </span>
            {inGroup && <Check className="h-3.5 w-3.5 flex-shrink-0 text-emerald-500" aria-label={`Already in ${inGroup}`} />}
            <Button
                size="sm"
                variant="ghost"
                className="h-6 w-6 p-0 flex-shrink-0 opacity-60 group-hover:opacity-100 [@media(hover:none)]:opacity-100"
                onClick={() => add(item)}
                title="Add to the destination group (or double-click the row)"
                aria-label={`Add ${s.name}`}
            >
                <ArrowRight className="h-3.5 w-3.5 text-primary" />
            </Button>
        </div>
    );
};

const ChannelList: FC = () => {
    const {
        playlist, selectedBouquetId, setSelectedBouquetId, bouquetLabel, membership,
        sourceSubscriptionId, categories, selectedCategory, streams, loadingStreams,
        addStreams, fetchStreams, streamsPage, totalStreamsPages, totalStreams,
        basket, toggleBasket, setInBasket, clearBasket, compactMode,
    } = useLiveSelection();

    const [search, setSearch] = useState("");
    const subscriptionId = sourceSubscriptionId ?? 0;

    const filtered = useMemo(() => {
        if (!search) return streams;
        const needle = search.toLowerCase();
        return streams.filter(s => s.name.toLowerCase().includes(needle));
    }, [streams, search]);

    const hasMorePages = streamsPage < totalStreamsPages;
    const isPartialView = hasMorePages && streams.length > 0;

    const handleRowsRendered = ({ stopIndex }: { stopIndex: number }) => {
        if (stopIndex >= filtered.length - 15 && !loadingStreams && hasMorePages && sourceSubscriptionId && selectedCategory) {
            fetchStreams(sourceSubscriptionId, selectedCategory, streamsPage + 1);
        }
    };

    useEffect(() => { setSearch(""); }, [selectedCategory, sourceSubscriptionId]);

    const addOne = useCallback((item: BasketItem) => { addStreams([item]); }, [addStreams]);

    const rowProps = useMemo<RowData>(() => ({
        items: filtered, basket, toggle: toggleBasket, add: addOne, membership, subscriptionId,
        compact: !!compactMode,
    }), [filtered, basket, toggleBasket, addOne, membership, subscriptionId, compactMode]);

    const shownItems = filtered.map(s => itemOf(s, subscriptionId));
    const allShownPicked = shownItems.length > 0 && shownItems.every(i => basket.has(i.key));
    const categoryName = selectedCategory ? categories.find(c => c.category_id === selectedCategory)?.category_name : null;
    const groups = playlist?.bouquets ?? [];

    return (
        <div className="flex flex-col min-h-0 h-full">
            <div className="p-2 space-y-1.5 border-b bg-primary/5">
                {/* The destination is chosen here, next to what is being added:
                    the old flow made you pick it in the next column first. */}
                <label className="flex items-center gap-1.5 text-[11px]">
                    <span className="text-muted-foreground flex-shrink-0">Add to</span>
                    <select
                        className="flex-1 min-w-0 text-xs p-1 border rounded bg-background font-medium"
                        value={selectedBouquetId ?? ''}
                        onChange={e => setSelectedBouquetId(e.target.value ? Number(e.target.value) : null)}
                        aria-label="Destination group"
                    >
                        <option value="">— choose a group —</option>
                        {groups.map(b => <option key={b.id} value={b.id}>{bouquetLabel(b)}</option>)}
                    </select>
                </label>
                {basket.size > 0 && (
                    <div className="flex items-center gap-1 rounded border border-primary/30 bg-primary/10 px-1.5 py-1">
                        <ShoppingBasket className="h-3.5 w-3.5 text-primary flex-shrink-0" />
                        <span className="text-[11px] font-semibold flex-1">{basket.size} picked</span>
                        <Button size="sm" className="h-6 px-2 text-[11px]" disabled={!selectedBouquetId}
                            onClick={async () => { await addStreams([...basket.values()]); clearBasket(); }}>
                            Add
                        </Button>
                        <Button size="sm" variant="ghost" className="h-6 w-6 p-0" onClick={clearBasket} title="Empty the basket" aria-label="Empty the basket">
                            <X className="h-3.5 w-3.5" />
                        </Button>
                    </div>
                )}
                <div className="flex items-center gap-1.5">
                    <input
                        type="checkbox"
                        className="h-3 w-3 rounded"
                        aria-label="Pick every channel shown"
                        disabled={shownItems.length === 0}
                        checked={allShownPicked}
                        onChange={(e) => setInBasket(shownItems, e.target.checked)}
                    />
                    <input
                        type="text"
                        placeholder={categoryName ? (isPartialView ? 'Search loaded channels…' : `Search ${categoryName}…`) : 'Pick a category'}
                        className="flex-1 min-w-0 p-1.5 text-xs border rounded bg-background"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        disabled={!selectedCategory}
                    />
                </div>
                {isPartialView && (
                    <p className="text-[10px] text-amber-600 dark:text-amber-400 leading-tight">
                        {streams.length} of {totalStreams} loaded. Scroll to load the rest, or use Ctrl+K to search every provider.
                    </p>
                )}
            </div>
            <div className="flex-1 overflow-hidden relative">
                {!selectedCategory ? (
                    <p className="p-6 text-center text-xs text-muted-foreground italic">
                        Pick a category above, or press <kbd className="px-1 border rounded">Ctrl</kbd>+<kbd className="px-1 border rounded">K</kbd> to search every provider.
                    </p>
                ) : loadingStreams && streamsPage === 1 ? (
                    <div className="p-4 flex justify-center h-full items-center">
                        <Loader2 className="h-6 w-6 animate-spin text-primary/40" />
                    </div>
                ) : (
                    <div className="h-full w-full">
                        {/* @ts-ignore */}
                        <AutoSizer renderProp={({ height, width }: any) => (
                            /* @ts-ignore */
                            <List
                                style={{ height, width }}
                                rowCount={filtered.length}
                                rowHeight={compactMode ? 30 : 40}
                                rowProps={rowProps as any}
                                rowComponent={StreamRow as any}
                                onRowsRendered={handleRowsRendered}
                            />
                        )} />
                        {loadingStreams && streamsPage > 1 && (
                            <div className="absolute bottom-3 left-1/2 -translate-x-1/2 bg-background/90 border rounded-full px-3 py-1 flex items-center gap-2 shadow z-10">
                                <Loader2 className="h-3 w-3 animate-spin text-primary" />
                                <span className="text-[10px] text-primary font-semibold">Loading…</span>
                            </div>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
};

// ---------------------------------------------------------------- panel

/**
 * The library: one column instead of two. Categories on top, their channels
 * below, a basket that survives switching category or provider, and the
 * destination group chosen right where channels are added.
 */
export const LibraryPanel: FC<{ onCollapse?: () => void }> = ({ onCollapse }) => {
    const { selectedCategory, categories } = useLiveSelection();
    const [categoriesOpen, setCategoriesOpen] = useState(true);
    const categoryName = selectedCategory ? categories.find(c => c.category_id === selectedCategory)?.category_name : null;

    // Picking a category folds the list away so the channels get the room.
    useEffect(() => { if (selectedCategory) setCategoriesOpen(false); }, [selectedCategory]);

    return (
        <Card className="flex flex-col min-h-0 h-full border-primary/10 shadow-sm overflow-hidden">
            <div className="flex items-center justify-between px-3 py-2 border-b bg-primary/5">
                <span className="text-sm font-bold">Library</span>
                {onCollapse && (
                    <Button size="icon" variant="ghost" className="h-6 w-6 text-muted-foreground" onClick={onCollapse} title="Hide the library" aria-label="Hide the library">
                        <ChevronLeft className="h-3 w-3" />
                    </Button>
                )}
            </div>
            <button type="button" onClick={() => setCategoriesOpen(o => !o)}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs border-b hover:bg-muted text-left">
                {categoriesOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                <span className="font-semibold">Category</span>
                <span className="truncate text-muted-foreground">{categoryName ?? 'none selected'}</span>
            </button>
            {categoriesOpen && (
                <div className="h-[45%] min-h-[10rem] border-b flex flex-col">
                    <CategoryList />
                </div>
            )}
            <div className="flex-1 min-h-0">
                <ChannelList />
            </div>
        </Card>
    );
};
