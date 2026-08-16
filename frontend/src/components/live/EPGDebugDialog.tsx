import { FC, useEffect, useState } from 'react';
import { Dialog } from "@/components/ui/dialog";
import { Loader2, Tv, AlertCircle } from 'lucide-react';
import { useLiveSelection, EPGMatchDebugResponse } from '@/contexts/LiveSelectionContext';

interface EPGDebugDialogProps {
    channelId: number | null;
    onClose: () => void;
}

export const EPGDebugDialog: FC<EPGDebugDialogProps> = ({ channelId, onClose }) => {
    const { getEPGDebugInfo } = useLiveSelection();
    const [debugData, setDebugData] = useState<EPGMatchDebugResponse | null>(null);
    const [loading, setLoading] = useState(false);

    useEffect(() => {
        if (channelId) {
            setLoading(true);
            getEPGDebugInfo(channelId)
                .then(data => setDebugData(data))
                .finally(() => setLoading(false));
        } else {
            setDebugData(null);
        }
    }, [channelId, getEPGDebugInfo]);

    if (!channelId) return null;

    return (
        <Dialog
            isOpen={!!channelId}
            onClose={onClose}
            title={`EPG Matching Debug`}
        >
            <div className="flex flex-col gap-4 min-w-[500px]">
                {loading ? (
                    <div className="flex flex-col items-center justify-center py-12 gap-3 text-muted-foreground">
                        <Loader2 className="h-8 w-8 animate-spin text-primary" />
                        <p>Analyzing EPG candidates...</p>
                    </div>
                ) : debugData && debugData.candidates.length > 0 ? (
                    <div className="space-y-4">
                        <div className="bg-primary/5 p-3 rounded border border-primary/10 mb-4">
                            <p className="text-sm font-bold flex items-center gap-2">
                                <Tv className="h-4 w-4 text-primary" />
                                Target Name: <span className="text-primary font-mono">{debugData.target_name}</span>
                            </p>
                        </div>

                        <p className="text-xs text-muted-foreground">
                            Candidates found across active EPG sources.
                            The <span className="font-bold text-foreground">Composite Score</span> determines the final match (min 75.0).
                        </p>

                        <div className="border rounded overflow-hidden">
                            <table className="w-full text-[11px]">
                                <thead className="bg-muted text-muted-foreground">
                                    <tr className="text-left border-b">
                                        <th className="p-2 font-medium">Candidate</th>
                                        <th className="p-2 font-medium">Source</th>
                                        <th className="p-2 font-medium text-center">Fuzzy</th>
                                        <th className="p-2 font-medium text-center">Pri.</th>
                                        <th className="p-2 font-medium text-right font-bold text-foreground">Score</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y">
                                    {debugData.candidates.map((c, idx) => (
                                        <tr key={`${c.epg_id}-${idx}`} className="hover:bg-muted/30 transition-colors">
                                            <td className="p-2">
                                                <div className="font-bold">{c.display_name}</div>
                                                <div className="text-[9px] text-muted-foreground font-mono">{c.epg_id}</div>
                                            </td>
                                            <td className="p-2 text-muted-foreground italic text-[10px]">{c.source_name}</td>
                                            <td className="p-2 text-center">
                                                <span className={`px-1 py-0.5 rounded text-[9px] ${c.fuzzy_score >= 90 ? 'bg-green-100 text-green-700' :
                                                        c.fuzzy_score >= 75 ? 'bg-amber-100 text-amber-700' : 'bg-muted text-muted-foreground'
                                                    }`}>
                                                    {c.fuzzy_score}
                                                </span>
                                            </td>
                                            <td className="p-2 text-center text-muted-foreground">{c.priority}</td>
                                            <td className="p-2 text-right">
                                                <span className={`font-bold px-1.5 py-0.5 rounded text-[10px] ${c.composite_score >= 75 ? 'bg-primary/10 text-primary ring-1 ring-primary/20' :
                                                        'bg-muted text-muted-foreground'
                                                    }`}>
                                                    {c.composite_score.toFixed(1)}
                                                </span>
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                        <div className="text-[9px] text-muted-foreground border-t pt-2 flex justify-between uppercase tracking-wider font-bold">
                            <span>Composite = (Fuzzy * 0.7) + (PriorityNorm * 30)</span>
                            <span>Threshold: 75.0</span>
                        </div>
                    </div>
                ) : (
                    <div className="flex flex-col items-center justify-center py-12 gap-3 text-muted-foreground">
                        <AlertCircle className="h-10 w-10 text-destructive/50" />
                        <p className="text-center text-sm">
                            No candidates found for "<span className="font-mono text-foreground font-bold">{debugData?.target_name}</span>".<br />
                            Check if your EPG sources are active and correctly linked.
                        </p>
                    </div>
                )}
            </div>
        </Dialog>
    );
};
