import { useState, useMemo, FC, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Check, Loader2, Radio, ArrowRight, ListFilter, ChevronLeft } from 'lucide-react';
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
        selectedCategory,
        setSelectedCategory,
        includedCategoryIds,
        setStreams,
    } = useLiveSelection();

    const [categorySearch, setCategorySearch] = useState("");

    const filteredCategories = useMemo(() => {
        if (!categorySearch) return categories;
        return categories.filter(c => c.category_name.toLowerCase().includes(categorySearch.toLowerCase()));
    }, [categories, categorySearch]);

    const handleSubscriptionChange = (id: number) => {
        setSourceSubscriptionId(id);
        fetchCategories(id);
        setSelectedCategory(null);
        setStreams([]);
    };

    return (
        <Card className="flex flex-col min-h-0 border-primary/10 shadow-sm h-full">
            <CardHeader className="py-2.5 px-3 border-b bg-primary/5">
                <CardTitle className="text-sm font-bold flex items-center justify-between">
                    <div className="flex items-center gap-2">
                        <ListFilter className="h-4 w-4 text-primary" /> Source Explorer
                    </div>
                    {onCollapse && (
                        <Button
                            size="icon"
                            variant="ghost"
                            className="h-6 w-6 text-muted-foreground hover:text-foreground"
                            onClick={onCollapse}
                            title="Collapse Source Explorer"
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
                    >
                        {allSubscriptions.map(sub => (
                            <option key={sub.id} value={sub.id}>{sub.name}</option>
                        ))}
                    </select>

                    <input
                        type="text"
                        placeholder="Filter sources..."
                        className="w-full p-1.5 text-xs border rounded bg-background"
                        value={categorySearch}
                        onChange={(e) => setCategorySearch(e.target.value)}
                    />
                </div>
            </CardHeader>
            <CardContent className="flex-1 overflow-y-auto p-0 scrollbar-thin">
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
            </CardContent>
        </Card>
    );
};

// ---------- COMPONENT 2: Channel Library (Streams) ----------

interface ChannelLibraryProps {
    onCollapse?: () => void;
    compactMode?: boolean;
}

export const ChannelLibrary: FC<ChannelLibraryProps> = ({ onCollapse, compactMode }) => {
    const {
        sourceSubscriptionId,
        categories,
        selectedCategory,
        streams,
        loadingStreams,
        excludedStreamIds,
        addStreamToBouquet,
        bulkAddStreamsToBouquet,
        fetchStreams,
        streamsPage,
        totalStreamsPages,
        totalStreams
    } = useLiveSelection();

    const [streamSearch, setStreamSearch] = useState("");
    const [selectedLibraryStreams, setSelectedLibraryStreams] = useState<Set<number>>(new Set());

    // This filter only sees the pages already pulled in by the infinite
    // scroll, so the UI has to say so rather than imply a category-wide search.
    const filteredStreams = useMemo(() => {
        if (!streamSearch) return streams;
        return streams.filter(s => s.name.toLowerCase().includes(streamSearch.toLowerCase()));
    }, [streams, streamSearch]);

    const hasMorePages = streamsPage < totalStreamsPages;
    const isPartialView = hasMorePages && streams.length > 0;

    const toggleStreamSelection = (id: number) => {
        const newSet = new Set(selectedLibraryStreams);
        if (newSet.has(id)) newSet.delete(id);
        else newSet.add(id);
        setSelectedLibraryStreams(newSet);
    };

    // Infinite Scroll logic for react-window v2
    const handleRowsRendered = ({ stopIndex }: { stopIndex: number }) => {
        if (stopIndex >= filteredStreams.length - 15 && !loadingStreams && streamsPage < totalStreamsPages && sourceSubscriptionId && selectedCategory) {
            fetchStreams(sourceSubscriptionId, selectedCategory, streamsPage + 1);
        }
    };

    // Reset selection when category changes
    useEffect(() => {
        setSelectedLibraryStreams(new Set());
    }, [selectedCategory]);

    // Virtual Row Component
    const Row = ({ index, style, data }: { index: number, style: React.CSSProperties, data: any[] }) => {
        const s = data[index];
        if (!s) return null;

        const isExcluded = excludedStreamIds.has(`${sourceSubscriptionId}:${s.stream_id}`);
        const isSelected = selectedLibraryStreams.has(s.stream_id);

        return (
            <div style={style} className={`px-2 flex items-center gap-2 group hover:bg-muted border-b border-muted/30 ${isSelected ? 'bg-primary/5' : ''} ${compactMode ? 'py-0 h-8' : 'py-1'}`}>
                <input
                    type="checkbox"
                    className={`${compactMode ? 'h-2.5 w-2.5' : 'h-3 w-3'} rounded`}
                    checked={isSelected}
                    onChange={() => toggleStreamSelection(s.stream_id)}
                    onClick={(e) => e.stopPropagation()}
                />
                <div className={`${compactMode ? 'w-6 h-6' : 'w-8 h-8'} rounded bg-muted flex-shrink-0 overflow-hidden flex items-center justify-center border`} onClick={() => toggleStreamSelection(s.stream_id)}>
                    {s.stream_icon ? <img src={s.stream_icon} className="w-full h-full object-contain" alt="" /> : <Radio className={`${compactMode ? 'h-3 w-3' : 'h-4 w-4'} text-muted-foreground`} />}
                </div>
                <span
                    className={`flex-1 truncate cursor-pointer ${compactMode ? 'text-[11px]' : 'text-xs'} ${isExcluded ? 'text-muted-foreground line-through' : ''}`}
                    onClick={() => toggleStreamSelection(s.stream_id)}
                >
                    {s.name}
                </span>
                <Button
                    size="sm"
                    variant="ghost"
                    className={`${compactMode ? 'h-6 w-6' : 'h-7 w-7'} opacity-0 group-hover:opacity-100`}
                    onClick={() => addStreamToBouquet(s)}
                    title="Add to virtual group"
                >
                    <ArrowRight className={`${compactMode ? 'h-3 w-3' : 'h-4 w-4'} text-primary`} />
                </Button>
            </div>
        );
    };

    return (
        <Card className="flex flex-col min-h-0 border-primary/10 shadow-sm h-full">
            <CardHeader className="py-2.5 px-3 border-b bg-primary/5">
                <div className="flex justify-between items-center mb-1">
                    <div className="flex items-center gap-2">
                        <input
                            type="checkbox"
                            className="h-3 w-3 rounded"
                            checked={filteredStreams.length > 0 && filteredStreams.every(s => selectedLibraryStreams.has(s.stream_id))}
                            onChange={(e) => {
                                const newSet = new Set(selectedLibraryStreams);
                                filteredStreams.forEach(s => {
                                    if (e.target.checked) newSet.add(s.stream_id);
                                    else newSet.delete(s.stream_id);
                                });
                                setSelectedLibraryStreams(newSet);
                            }}
                        />
                        <CardTitle className="text-sm font-bold truncate">
                            {selectedCategory ? categories.find(c => c.category_id === selectedCategory)?.category_name : 'Library Channels'}
                        </CardTitle>
                    </div>
                    <div className="flex gap-1">
                        {onCollapse && (
                            <Button
                                size="icon"
                                variant="ghost"
                                className="h-6 w-6 text-muted-foreground hover:text-foreground"
                                onClick={onCollapse}
                                title="Collapse Library"
                            >
                                <ChevronLeft className="h-3 w-3" />
                            </Button>
                        )}
                        <Button
                            size="sm"
                            variant="outline"
                            className="h-6 text-[10px] px-2"
                            disabled={selectedLibraryStreams.size === 0}
                            onClick={() => {
                                const toAdd = streams.filter(s => selectedLibraryStreams.has(s.stream_id));
                                bulkAddStreamsToBouquet(toAdd);
                                setSelectedLibraryStreams(new Set());
                            }}
                        >
                            Add ({selectedLibraryStreams.size})
                        </Button>
                        <Button
                            size="sm"
                            variant="outline"
                            className="h-6 text-[10px] px-2"
                            disabled={filteredStreams.length === 0}
                            onClick={() => bulkAddStreamsToBouquet(filteredStreams)}
                            title={isPartialView
                                ? `Adds the ${filteredStreams.length} channel(s) currently loaded. Scroll to load the rest of the category first.`
                                : `Adds all ${filteredStreams.length} channel(s)`}
                        >
                            Add {filteredStreams.length}
                        </Button>
                    </div>
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
                        Scroll the list to load more, or use the header search for the whole subscription.
                    </p>
                )}
            </CardHeader>
            <CardContent className="flex-1 overflow-hidden p-0 relative">
                {loadingStreams && streamsPage === 1 ? (
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
                                rowProps={{ data: filteredStreams } as any}
                                rowComponent={Row}
                                onRowsRendered={handleRowsRendered}
                            />
                        )}
                        />

                        {/* Loading overlay for next pages */}
                        {loadingStreams && streamsPage > 1 && (
                            <div className="absolute bottom-4 left-1/2 -translate-x-1/2 bg-background/90 backdrop-blur-md border border-primary/20 rounded-full px-4 py-1.5 flex items-center gap-2 shadow-lg z-10 transition-all animate-in fade-in slide-in-from-bottom-2">
                                <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
                                <span className="text-[10px] text-primary font-semibold uppercase tracking-wider">Chargement...</span>
                            </div>
                        )}
                    </div>
                )}
            </CardContent>
        </Card>
    );
};

// Keep the default export for backward compatibility
export const StreamLibrary = SourceExplorer;
