import { FC } from 'react';
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Plus, SearchX, Loader2, Check, CornerDownRight } from 'lucide-react';
import { useLiveSelection } from '@/contexts/LiveSelectionContext';

interface SearchResultsModalProps {
    isOpen: boolean;
    onClose: () => void;
    results: any[];
    loading: boolean;
    query: string;
}

const SearchResultsModal: FC<SearchResultsModalProps> = ({ isOpen, onClose, results, loading, query }) => {
    const {
        addStreamToBouquet, playlist, selectedBouquetId, bouquetLabel,
        membership, sourceSubscriptionId, sourceSubscriptionName,
    } = useLiveSelection();

    const target = playlist?.bouquets.find(b => b.id === selectedBouquetId) ?? null;

    const handleAdd = (stream: any) => {
        addStreamToBouquet({
            stream_id: stream.stream_id,
            name: stream.name,
            stream_icon: stream.stream_icon,
            epg_channel_id: stream.epg_channel_id,
            num: 0,
            stream_type: "live",
            category_id: stream.category_id
        });
        // The dialog stays open so several channels can be added in a row.
    };

    return (
        <Dialog isOpen={isOpen} onClose={onClose} title={`Search results: "${query}"`}>
            <div className="flex flex-col gap-3 max-h-[70vh]">
                <div className={`flex items-center gap-1.5 text-xs rounded px-2 py-1.5 border ${target
                    ? 'bg-indigo-500/10 border-indigo-500/20 text-indigo-600 dark:text-indigo-300'
                    : 'bg-amber-500/10 border-amber-500/30 text-amber-600 dark:text-amber-400'}`}>
                    <CornerDownRight className="h-3.5 w-3.5 flex-shrink-0" />
                    <span>
                        {target
                            ? <>Channels are added to <strong>{bouquetLabel(target)}</strong>. Searching in <strong>{sourceSubscriptionName}</strong>.</>
                            : 'Close this window and select a group first, otherwise nothing can be added.'}
                    </span>
                </div>
                <div className="overflow-y-auto pr-2 scrollbar-thin">
                    {loading ? (
                        <div className="flex flex-col items-center justify-center py-12 gap-3 text-muted-foreground">
                            <Loader2 className="h-8 w-8 animate-spin text-primary" />
                            <p className="text-sm font-medium">Searching every category of {sourceSubscriptionName || 'the provider'}…</p>
                        </div>
                    ) : results.length === 0 ? (
                        <div className="flex flex-col items-center justify-center py-12 gap-2 text-muted-foreground">
                            <SearchX className="h-10 w-10 opacity-20" />
                            <p className="text-sm">No channel found matching "{query}"</p>
                        </div>
                    ) : (
                        <div className="flex flex-col gap-6">
                            {results.map((group) => (
                                <div key={group.category_id} className="space-y-2">
                                    <h4 className="text-[11px] font-bold uppercase tracking-wider text-primary bg-primary/5 px-2 py-1 rounded border border-primary/10">
                                        {group.category_name}
                                    </h4>
                                    <div className="grid grid-cols-1 gap-1">
                                        {group.streams.map((s: any) => {
                                            const inGroup = membership.get(`${sourceSubscriptionId ?? ''}:${s.stream_id}`);
                                            return (
                                                <div key={s.stream_id} className="flex items-center justify-between p-2 rounded hover:bg-muted/50 border border-transparent hover:border-muted-foreground/10 transition-all group">
                                                    <div className="flex items-center gap-2 min-w-0">
                                                        {s.stream_icon && (
                                                            <img src={s.stream_icon} alt="" className="h-6 w-6 rounded object-contain bg-black/20" loading="lazy" />
                                                        )}
                                                        <div className="flex flex-col min-w-0">
                                                            <span className="text-xs font-medium truncate">{s.name}</span>
                                                            {inGroup && (
                                                                <span className="text-[10px] text-emerald-600 dark:text-emerald-400 flex items-center gap-1">
                                                                    <Check className="h-3 w-3" /> already in {inGroup}
                                                                </span>
                                                            )}
                                                        </div>
                                                    </div>
                                                    <Button
                                                        size="sm"
                                                        variant="outline"
                                                        className="h-7 px-2 gap-1 flex-shrink-0 text-xs"
                                                        onClick={() => handleAdd(s)}
                                                        disabled={!target}
                                                        title="Add to the selected group"
                                                    >
                                                        <Plus className="h-3.5 w-3.5" /> Add
                                                    </Button>
                                                </div>
                                            );
                                        })}
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </div>

                <div className="flex justify-end pt-2 border-t">
                    <Button variant="outline" size="sm" onClick={onClose} className="h-8 text-xs">
                        Done
                    </Button>
                </div>
            </div>
        </Dialog>
    );
};

export default SearchResultsModal;
