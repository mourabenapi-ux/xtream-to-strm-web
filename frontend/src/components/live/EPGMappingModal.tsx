import { useState, useEffect, FC } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Search, Loader2, X, Tv } from 'lucide-react';
import api from '@/lib/api';
import { useLiveSelection } from '@/contexts/LiveSelectionContext';

export const EPGMappingModal: FC = () => {
    const {
        mappingId,
        setMappingId,
        selectEPG,
        epgSources
    } = useLiveSelection();

    const [epgSearch, setEpgSearch] = useState("");
    const [epgResults, setEpgResults] = useState<any[]>([]);
    const [loading, setLoading] = useState(false);

    useEffect(() => {
        const delayDebounceFn = setTimeout(() => {
            if (epgSearch && epgSources.length > 0) {
                searchEPG(epgSearch);
            } else {
                setEpgResults([]);
            }
        }, 300);

        return () => clearTimeout(delayDebounceFn);
    }, [epgSearch, epgSources]);

    const searchEPG = async (query: string) => {
        setLoading(true);
        try {
            const res = await api.get(`/live/epg/search?q=${encodeURIComponent(query)}`);
            setEpgResults(res.data);
        } catch (error) {
            console.error("EPG search failed", error);
        } finally {
            setLoading(false);
        }
    };

    if (!mappingId) return null;

    return (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
            <Card className="w-full max-w-2xl max-h-[80vh] flex flex-col shadow-2xl">
                <CardHeader className="border-b bg-muted/30">
                    <div className="flex justify-between items-center">
                        <CardTitle className="text-lg flex items-center gap-2">
                            <Tv className="h-5 w-5 text-primary" /> Map EPG Channel
                        </CardTitle>
                        <Button variant="ghost" size="icon" onClick={() => setMappingId(null)}>
                            <X className="h-5 w-5" />
                        </Button>
                    </div>
                    <div className="mt-4 relative">
                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                        <input
                            autoFocus
                            type="text"
                            placeholder="Search EPG by channel name or ID..."
                            className="w-full pl-9 p-2.5 bg-background border rounded-lg shadow-sm"
                            value={epgSearch}
                            onChange={(e) => setEpgSearch(e.target.value)}
                        />
                    </div>
                </CardHeader>
                <CardContent className="flex-1 overflow-y-auto p-0">
                    {loading ? (
                        <div className="p-12 flex flex-col items-center gap-3">
                            <Loader2 className="h-8 w-8 animate-spin text-primary" />
                            <p className="text-sm text-muted-foreground">Searching EPG database...</p>
                        </div>
                    ) : epgResults.length > 0 ? (
                        <div className="divide-y">
                            {epgResults.map((result: any) => (
                                <div
                                    key={result.epg_id}
                                    className="p-4 hover:bg-muted/50 cursor-pointer flex items-center justify-between group transition-colors"
                                    onClick={() => selectEPG(result.epg_id)}
                                >
                                    <div className="flex flex-col gap-0.5">
                                        <span className="font-semibold text-sm group-hover:text-primary transition-colors">
                                            {result.name}
                                        </span>
                                        <span className="text-xs text-muted-foreground font-mono">
                                            {result.epg_id}
                                        </span>
                                    </div>
                                    <Button size="sm" variant="outline" className="opacity-0 group-hover:opacity-100 transition-opacity">
                                        Select
                                    </Button>
                                </div>
                            ))}
                        </div>
                    ) : epgSearch ? (
                        <div className="p-12 text-center text-muted-foreground italic">
                            No EPG channels found matching "{epgSearch}"
                        </div>
                    ) : (
                        <div className="p-12 text-center text-muted-foreground italic">
                            Type to start searching EPG channels
                        </div>
                    )}
                </CardContent>
            </Card>
        </div>
    );
};
