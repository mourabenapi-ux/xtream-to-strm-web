import { FC } from 'react';
import { useLiveSelection } from '@/contexts/LiveSelectionContext';
import { Hash, Layers, Tv, CheckCircle2, AlertCircle, Settings } from 'lucide-react';
import { Button } from "@/components/ui/button";
import { useNavigate } from 'react-router-dom';

export const PlaylistStatistics: FC = () => {
    const { stats, playlist } = useLiveSelection();
    const navigate = useNavigate();

    return (
        <div className="flex items-center gap-6 px-6 py-2 bg-card border-b text-xs overflow-x-auto whitespace-nowrap scrollbar-hide">
            <div className="flex items-center gap-2 px-3 py-1 bg-primary/5 rounded-full border border-primary/10">
                <Hash className="h-3.5 w-3.5 text-primary" />
                <span className="font-semibold">{stats.totalChannels}</span>
                <span className="text-muted-foreground">Channels</span>
            </div>

            <div className="flex items-center gap-2 px-3 py-1 bg-indigo-500/5 rounded-full border border-indigo-500/10">
                <Layers className="h-3.5 w-3.5 text-indigo-500" />
                <span className="font-semibold">{stats.totalGroups}</span>
                <span className="text-muted-foreground">Groups</span>
            </div>

            <div className="flex items-center gap-2 px-3 py-1 bg-emerald-500/5 rounded-full border border-emerald-500/10">
                <Tv className="h-3.5 w-3.5 text-emerald-500" />
                <span className="font-semibold">{stats.epgMappedCount}</span>
                <span className="text-muted-foreground">Mapped</span>
            </div>

            <div className="flex items-center gap-3 ml-auto">
                <div className="flex items-center gap-2">
                    <span className="text-muted-foreground">EPG Coverage:</span>
                    <span className={`font-bold ${stats.epgPercentage >= 90 ? 'text-emerald-500' : stats.epgPercentage >= 50 ? 'text-amber-500' : 'text-destructive'}`}>
                        {stats.epgPercentage}%
                    </span>
                </div>
                <div className="w-24 h-1.5 bg-muted rounded-full overflow-hidden">
                    <div
                        className={`h-full transition-all duration-500 ${stats.epgPercentage >= 90 ? 'bg-emerald-500' : stats.epgPercentage >= 50 ? 'bg-amber-500' : 'bg-destructive'}`}
                        style={{ width: `${stats.epgPercentage}%` }}
                    />
                </div>
                {stats.epgPercentage === 100 ? (
                    <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                ) : (
                    <AlertCircle className="h-4 w-4 text-amber-500" />
                )}
                <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-primary hover:bg-primary/10 ml-2"
                    onClick={() => navigate(`/live-epg?playlist_id=${playlist?.id}`)}
                >
                    <Settings className="h-3.5 w-3.5 mr-1" />
                    Manage Sources
                </Button>
            </div>
        </div>
    );
};
