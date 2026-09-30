import { useState, useMemo, FC, useEffect, useCallback } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Check, Loader2, Radio, ArrowRight, ListFilter, ChevronLeft, CornerDownRight } from 'lucide-react';
// @ts-ignore
import { List } from 'react-window';
// @ts-ignore
import { AutoSizer } from 'react-virtualized-auto-sizer';
import { useLiveSelection } from '@/contexts/LiveSelectionContext';

// ---------- COMPONENT 1: Source Explorer (Categories) ----------

interface SourceExplorerProps {
    onCollapse?: () => void;
    compactMode?: boolean;
}

export const SourceExplorer: FC<SourceExplorerProps> = ({ onCollapse }) => {
    const {
        allSubscriptions,
        sourceSubscriptionId,
        setSourceSubscriptionId,
        fetchCategories,
        categories,
        loadingCategories,
        selectedCategory,
        setSelectedCategory,
        includedCategoryIds,
    } = useLiveSelection();

    const [categorySearch, setCategorySearch] = useState("");

    const filteredCategories = useMemo(() => {
        if (!categorySearch) return categories;
        return categories.filter(c => c.category_name.toLowerCase().includes(categorySearch.toLowerCase()));
    }, [categories, categorySearch]);

    const handleSubscriptionChange = (id: number) => {
        setSelectedCategory(null);
        setSourceSubscriptionId(id);
        setCategorySearch("");
        fetchCategories(id);
    };

    return (
        <Card className="flex flex-col min-h-0 border-primary/10 shadow-sm h-full">
            <CardHeader className="py-2.5 px-3 border-b bg-primary/5">
                <CardTitle className="text-sm font-bold flex items-center justify-between">
                    <div className="flex items-center gap-2">
                        <ListFilter className="h-4 w-4 text-primary" /> 1. Source
                    </div>
                    {onCollapse && (
                        <Button
                            size="icon"
                            variant="ghost"
                            className="h-6 w-6 text-muted-foreground hover:text-foreground"
                            onClick={onCollapse}
                            title="Collapse this panel"
                        >
                            <ChevronLeft className="h-3 w-3" />
                        </Button>
                    )}
                </CardTitle>

                <div className="mt-2 space-y-2">
                    <select
                        className="w-full text-xs p-1.5 border rounded bg-background"
                        value={sourceSubscriptionId || ''}
                        onChange={(e) => handleSubscriptionChange(Number(e.target.value))}
                        aria-label="Provider to browse"
                    >
                        {allSubscriptions.map(sub => (
                            <option key={sub.id} value={sub.id}>{sub.name}</option>
                        ))}
                    </select>

                    <input
                        type="text"
                        placeholder="Filter categories…"
                        className="w-full p-1.5 text-xs border rounded bg-background"
                        value={categorySearch}
                        onChange={(e) => setCategorySearch(e.target.value)}
                    />
                </div>
            </CardHeader>
            <CardContent className="flex-1 overflow-y-auto p-0 scrollbar-thin">
                {loadingCategories ? (
                    <div className="p-6 flex justify-center"><Loader2 className="h-5 w-5 animate-spin text-primary/40" /></div>
                ) : filteredCategories.length === 0 ? (
                    <p className="p-4 text-center text-xs text-muted-foreground italic">
                        {categories.length === 0 ? 'No categories for this provider.' : 'No category matches the filter.'}
                    </p>
                ) : (
                    <div className="divide-y text-sm">
                        {filteredCategories.map(cat => {
                            const isSelected = selectedCategory === cat.category_id;
                            const isIncluded = includedCategoryIds.includes(cat.category_id);
                            return (
                                <div
                                    key={cat.category_id}
                                    className={`p-2 cursor-pointer hover:bg-muted group flex items-center justify-between ${isSelected ? 'bg-primary/10 border-r-2 border-primary' : ''}`}
                                    onClick={() => setSelectedCategory(cat.category_id)}
                                >
                                    <span className={`truncate flex-1 ${isIncluded ? 'font-bold text-primary' : ''}`}>
                                        {cat.category_name}
                                    </span>
                                    {isIncluded && <Check className="h-4 w-4 text-primary" />}
                                </div>
                            );
                        })}
                    </div>
                )}
            </CardContent>
        </Card>
    );
};

// ---------- COMPONENT 2: Channel Library (Streams) ----------

interface ChannelLibraryProps {
    onCollapse?: () => void;
    compactMode?: boolean;
}

interface RowData {
    items: any[];
    selected: Set<string>;
    toggle: (id: string) => void;
    add: (stream: any) => void;
    membership: Map<string, string>;
    excluded: Set<string>;
    subscriptionId: number | null;
    compact: boolean;
}

// Kept outside the component: react-window remounts every row whenever the
// row component's identity changes, which used to happen on each render.
const StreamRow = ({ index, style, items, selected, toggle, add, membership, excluded, subscriptionId, compact }:
    { index: number; style: React.CSSProperties } & RowData) => {
    const s = items[index];
    if (!s) return null;
    const id = String(s.stream_id);
    const key = `${subscriptionId ?? ''}:${id}`;
    const isExcluded = excluded.has(key);
    const inGroup = membership.get(key);
    const isSelected = selected.has(id);

    return (
        <div
            style={style}
            className={`px-2 flex items-center gap-2 group hover:bg-muted border-b border-muted/30 ${isSelected ? 'bg-primary/5' : ''} ${compact ? 'py-0 h-8' : 'py-1'}`}
            onDoubleClick={() => add(s)}
        >
            <input
                type="checkbox"
                className={`${compact ? 'h-2.5 w-2.5' : 'h-3 w-3'} rounded`}
                checked={isSelected}
                onChange={() => toggle(id)}
                aria-label={`Select ${s.name}`}
            />
            <div className={`${compact ? 'w-6 h-6' : 'w-8 h-8'} rounded bg-muted flex-shrink-0 overflow-hidden flex items-center justify-center border`} onClick={() => toggle(id)}>
                {s.stream_icon ? <img src={s.stream_icon} className="w-full h-full object-contain" alt="" loading="lazy" /> : <Radio className={`${compact ? 'h-3 w-3' : 'h-4 w-4'} text-muted-foreground`} />}
            </div>
            <span
                className={`flex-1 min-w-0 cursor-pointer ${compact ? 'text-[11px]' : 'text-xs'} ${isExcluded ? 'text-muted-foreground line-through' : ''}`}
                onClick={() => toggle(id)}
                title={s.name}
            >
                <span className="block truncate">{s.name}</span>
                {inGroup && !compact && (
                    <span className="block truncate text-[10px] text-emerald-600 dark:text-emerald-400">
                        in {inGroup}
                    </span>
                )}
            </span>
            {inGroup && (
                <Check className="h-3.5 w-3.5 flex-shrink-0 text-emerald-500" aria-label={`Already in ${inGroup}`} />
            )}
            <Button
                size="sm"
                variant="ghost"
                className={`${compact ? 'h-6 w-6' : 'h-7 w-7'} flex-shrink-0 opacity-60 group-hover:opacity-100 [@media(hover:none)]:opacity-100`}
                onClick={() => add(s)}
                title="Add to the selected group (or double-click the row)"
                aria-label={`Add ${s.name} to the selected group`}
            >
                <ArrowRight className={`${compact ? 'h-3 w-3' : 'h-4 w-4'} text-primary`} />
            </Button>
        </div>
    );
};

export const ChannelLibrary: FC<ChannelLibraryProps> = ({ onCollapse, compactMode }) => {
    const {
        playlist,
        selectedBouquetId,
        bouquetLabel,
        membership,
        excludedStreamIds,
        sourceSubscriptionId,
        categories,
        selectedCategory,
        streams,
        loadingStreams,
        addStreamToBouquet,
        bulkAddStreamsToBouquet,
        fetchStreams,
        streamsPage,
        totalStreamsPages,
        totalStreams
    } = useLiveSelection();

    const [streamSearch, setStreamSearch] = useState("");
    const [selectedLibraryStreams, setSelectedLibraryStreams] = useState<Set<string>>(new Set());

    const targetGroup = playlist?.bouquets.find(b => b.id === selectedBouquetId) ?? null;

    // This filter only sees the pages already pulled in by the infinite
    // scroll, so the UI has to say so rather than imply a category-wide search.
    const filteredStreams = useMemo(() => {
        if (!streamSearch) return streams;
        return streams.filter(s => s.name.toLowerCase().includes(streamSearch.toLowerCase()));
    }, [streams, streamSearch]);

    const hasMorePages = streamsPage < totalStreamsPages;
    const isPartialView = hasMorePages && streams.length > 0;

    const toggleStreamSelection = useCallback((id: string) => {
        setSelectedLibraryStreams(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    }, []);

    // Infinite Scroll logic for react-window v2
    const handleRowsRendered = ({ stopIndex }: { stopIndex: number }) => {
        if (stopIndex >= filteredStreams.length - 15 && !loadingStreams && streamsPage < totalStreamsPages && sourceSubscriptionId && selectedCategory) {
            fetchStreams(sourceSubscriptionId, selectedCategory, streamsPage + 1);
        }
    };

    // A new category starts from a clean selection and search box.
    useEffect(() => {
        setSelectedLibraryStreams(new Set());
        setStreamSearch("");
    }, [selectedCategory, sourceSubscriptionId]);

    const rowProps = useMemo<RowData>(() => ({
        items: filteredStreams,
        selected: selectedLibraryStreams,
        toggle: toggleStreamSelection,
        add: addStreamToBouquet,
        membership,
        excluded: excludedStreamIds,
        subscriptionId: sourceSubscriptionId,
        compact: !!compactMode,
    }), [filteredStreams, selectedLibraryStreams, toggleStreamSelection, addStreamToBouquet,
        membership, excludedStreamIds, sourceSubscriptionId, compactMode]);

    const categoryName = selectedCategory
        ? categories.find(c => c.category_id === selectedCategory)?.category_name
        : null;

    return (
        <Card className="flex flex-col min-h-0 border-primary/10 shadow-sm h-full">
            <CardHeader className="py-2.5 px-3 border-b bg-primary/5">
                <div className="flex justify-between items-center mb-1">
                    <div className="flex items-center gap-2 min-w-0">
                        <input
                            type="checkbox"
                            className="h-3 w-3 rounded"
                            aria-label="Select every loaded channel"
                            checked={filteredStreams.length > 0 && filteredStreams.every(s => selectedLibraryStreams.has(String(s.stream_id)))}
                            onChange={(e) => {
                                const next = new Set(selectedLibraryStreams);
                                filteredStreams.forEach(s => {
                                    if (e.target.checked) next.add(String(s.stream_id));
                                    else next.delete(String(s.stream_id));
                                });
                                setSelectedLibraryStreams(next);
                            }}
                        />
                        <CardTitle className="text-sm font-bold truncate" title={categoryName ?? undefined}>
                            2. {categoryName ?? 'Channels'}
                        </CardTitle>
                    </div>
                    {onCollapse && (
                        <Button
                            size="icon"
                            variant="ghost"
                            className="h-6 w-6 text-muted-foreground hover:text-foreground"
                            onClick={onCollapse}
                            title="Collapse this panel"
                        >
                            <ChevronLeft className="h-3 w-3" />
                        </Button>
                    )}
                </div>

                <div
                    className={`flex items-center gap-1 text-[11px] rounded px-1.5 py-1 mb-1 border ${targetGroup
                        ? 'bg-indigo-500/10 border-indigo-500/20 text-indigo-600 dark:text-indigo-300'
                        : 'bg-amber-500/10 border-amber-500/30 text-amber-600 dark:text-amber-400'}`}
                >
                    <CornerDownRight className="h-3 w-3 flex-shrink-0" />
                    <span className="truncate">
                        {targetGroup ? <>Adds go to <strong>{bouquetLabel(targetGroup)}</strong></> : 'Select a group to add channels to it'}
                    </span>
                </div>

                <div className="flex gap-1 mb-1">
                    <Button
                        size="sm"
                        variant="outline"
                        className="h-6 text-[10px] px-2 flex-1"
                        disabled={selectedLibraryStreams.size === 0 || !targetGroup}
                        onClick={() => {
                            const toAdd = streams.filter(s => selectedLibraryStreams.has(String(s.stream_id)));
                            bulkAddStreamsToBouquet(toAdd);
                            setSelectedLibraryStreams(new Set());
                        }}
                    >
                        Add selected ({selectedLibraryStreams.size})
                    </Button>
                    <Button
                        size="sm"
                        variant="outline"
                        className="h-6 text-[10px] px-2 flex-1"
                        disabled={filteredStreams.length === 0 || !targetGroup}
                        onClick={() => bulkAddStreamsToBouquet(filteredStreams)}
                        title={isPartialView
                            ? `Adds the ${filteredStreams.length} channel(s) currently loaded. Scroll to load the rest of the category first.`
                            : `Adds all ${filteredStreams.length} channel(s)`}
                    >
                        Add {isPartialView ? 'loaded' : 'all'} ({filteredStreams.length})
                    </Button>
                </div>
                <input
                    type="text"
                    placeholder={isPartialView ? "Search loaded channels…" : "Search channels…"}
                    className="w-full p-1.5 text-xs border rounded bg-background"
                    value={streamSearch}
                    onChange={(e) => setStreamSearch(e.target.value)}
                />
                {isPartialView && (
                    <p className="text-[10px] text-amber-600 dark:text-amber-400 mt-1 leading-tight">
                        {streams.length} of {totalStreams} loaded — searching only covers these.
                        Scroll the list to load more, or use the header search for the whole provider.
                    </p>
                )}
            </CardHeader>
            <CardContent className="flex-1 overflow-hidden p-0 relative">
                {!selectedCategory ? (
                    <p className="p-6 text-center text-xs text-muted-foreground italic">
                        Pick a category on the left to list its channels.
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
                                rowCount={filteredStreams.length}
                                rowHeight={compactMode ? 32 : 44}
                                rowProps={rowProps as any}
                                rowComponent={StreamRow as any}
                                onRowsRendered={handleRowsRendered}
                            />
                        )}
                        />

                        {/* Loading overlay for next pages */}
                        {loadingStreams && streamsPage > 1 && (
                            <div className="absolute bottom-4 left-1/2 -translate-x-1/2 bg-background/90 backdrop-blur-md border border-primary/20 rounded-full px-4 py-1.5 flex items-center gap-2 shadow-lg z-10 transition-all animate-in fade-in slide-in-from-bottom-2">
                                <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
                                <span className="text-[10px] text-primary font-semibold uppercase tracking-wider">Loading…</span>
                            </div>
                        )}
                    </div>
                )}
            </CardContent>
        </Card>
    );
};
