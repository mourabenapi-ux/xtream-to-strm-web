import { FC } from 'react';
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Plus, SearchX, Loader2 } from 'lucide-react';
import { useLiveSelection } from '@/contexts/LiveSelectionContext';

interface SearchResultsModalProps {
    isOpen: boolean;
    onClose: () => void;
    results: any[];
    loading: boolean;
    query: string;
}

const SearchResultsModal: FC<SearchResultsModalProps> = ({ isOpen, onClose, results, loading, query }) => {
    const { addStreamToBouquet } = useLiveSelection();

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
        // We don't close the modal so user can add multiple
    };

    return (
        <Dialog isOpen={isOpen} onClose={onClose} title={`Search Results: "${query}"`}>
            <div className="flex flex-col gap-4 max-h-[70vh]">
                <div className="overflow-y-auto pr-2 scrollbar-thin">
                    {loading ? (
                        <div className="flex flex-col items-center justify-center py-12 gap-3 text-muted-foreground">
                            <Loader2 className="h-8 w-8 animate-spin text-primary" />
                            <p className="text-sm font-medium">Searching through all subscription streams...</p>
                        </div>
                    ) : results.length === 0 ? (
                        <div className="flex flex-col items-center justify-center py-12 gap-2 text-muted-foreground">
                            <SearchX className="h-10 w-10 opacity-20" />
                            <p className="text-sm">No streams found matching "{query}"</p>
                        </div>
                    ) : (
                        <div className="flex flex-col gap-6">
                            {results.map((group) => (
                                <div key={group.category_id} className="space-y-2">
                                    <h4 className="text-[11px] font-bold uppercase tracking-wider text-primary bg-primary/5 px-2 py-1 rounded border border-primary/10">
                                        {group.category_name}
                                    </h4>
                                    <div className="grid grid-cols-1 gap-1">
                                        {group.streams.map((s: any) => (
                                            <div key={s.stream_id} className="flex items-center justify-between p-2 rounded hover:bg-muted/50 border border-transparent hover:border-muted-foreground/10 transition-all group">
                                                <div className="flex items-center gap-2 min-w-0">
                                                    {s.stream_icon && (
                                                        <img src={s.stream_icon} alt="" className="h-6 w-6 rounded object-contain bg-black/20" />
                                                    )}
                                                    <div className="flex flex-col min-w-0">
                                                        <span className="text-xs font-medium truncate">{s.name}</span>
                                                        <span className="text-[9px] text-muted-foreground">ID: {s.stream_id}</span>
                                                    </div>
                                                </div>
                                                <Button
                                                    size="sm"
                                                    variant="ghost"
                                                    className="h-7 w-7 p-0 opacity-0 group-hover:opacity-100 hover:bg-primary hover:text-primary-foreground transition-all"
                                                    onClick={() => handleAdd(s)}
                                                    title="Add to bouquet"
                                                >
                                                    <Plus className="h-4 w-4" />
                                                </Button>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </div>

                <div className="flex justify-end pt-2 border-t mt-2">
                    <Button variant="outline" size="sm" onClick={onClose} className="h-8 text-xs">
                        Done
                    </Button>
                </div>
            </div>
        </Dialog>
    );
};

export default SearchResultsModal;
