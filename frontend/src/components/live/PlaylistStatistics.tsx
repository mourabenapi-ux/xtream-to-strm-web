import { FC, useEffect } from 'react';
import { useLiveSelection } from '@/contexts/LiveSelectionContext';
import { Hash, Layers, Tv, AlertCircle, AlertTriangle, CheckCircle2, Settings, Loader2, Sparkles } from 'lucide-react';
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { useNavigate } from 'react-router-dom';

/**
 * The bar under the header. Its guide figure is what the player shows —
 * channels with a schedule — and no longer "channels with an id": the old
 * figure read 100 % on a playlist where 22 % of the channels had a guide.
 */
export const PlaylistStatistics: FC<{ onOpenHealth: (tab: 'issues' | 'new') => void }> = ({ onOpenHealth }) => {
    const { stats, playlist, useChannelNumbers, setUseChannelNumbers, health, healthLoading, changes, loadChanges } = useLiveSelection();
    const navigate = useNavigate();

    // The provider report is slower (it reads whole catalogues): fetched once,
    // a little after the screen opens, so it never delays the editor itself.
    useEffect(() => {
        const timer = setTimeout(() => { loadChanges(); }, 2500);
        return () => clearTimeout(timer);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [playlist?.id]);

    const errors = health?.issues.filter(i => i.severity === 'error').length ?? 0;
    const warnings = health?.issues.filter(i => i.severity === 'warning').length ?? 0;
    const pct = health?.stats.schedule_percentage ?? 0;
    const tone = pct >= 90 ? 'text-emerald-500' : pct >= 50 ? 'text-amber-500' : 'text-destructive';

    return (
        <div className="flex items-center gap-2 px-4 py-1.5 bg-card border-b text-xs overflow-x-auto whitespace-nowrap scrollbar-hide">
            <span className="flex items-center gap-1.5 px-2.5 py-1 bg-primary/5 rounded-full border border-primary/10">
                <Hash className="h-3.5 w-3.5 text-primary" /><strong>{stats.totalChannels}</strong> channels
            </span>
            <span className="flex items-center gap-1.5 px-2.5 py-1 bg-indigo-500/5 rounded-full border border-indigo-500/10">
                <Layers className="h-3.5 w-3.5 text-indigo-500" /><strong>{stats.totalGroups}</strong> groups
            </span>
            <span className="flex items-center gap-1.5 px-2.5 py-1 rounded-full border"
                title={health ? `${health.stats.with_schedule} channels have programmes in the linked guides. ${health.stats.with_guide_id} have a guide id.` : 'Checking…'}>
                <Tv className="h-3.5 w-3.5 text-emerald-500" />
                {health ? <><strong className={tone}>{pct}%</strong> with a guide <span className="text-muted-foreground">({health.stats.with_schedule}/{health.stats.served})</span></> : <Loader2 className="h-3 w-3 animate-spin" />}
            </span>

            <button type="button" onClick={() => onOpenHealth('issues')}
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full border font-medium hover:bg-muted
                    ${errors ? 'border-destructive/40 text-destructive bg-destructive/5' : warnings ? 'border-amber-500/40 text-amber-600 bg-amber-500/5' : 'border-emerald-500/30 text-emerald-600'}`}
                title="Problems the player would see, with one-click fixes">
                {healthLoading && !health ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    : errors ? <AlertCircle className="h-3.5 w-3.5" /> : warnings ? <AlertTriangle className="h-3.5 w-3.5" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
                {health ? (errors + warnings ? `${errors + warnings} problem${errors + warnings > 1 ? 's' : ''}` : 'Healthy') : 'Health'}
            </button>
            {changes && changes.new_count > 0 && (
                <button type="button" onClick={() => onOpenHealth('new')}
                    className="flex items-center gap-1.5 px-2.5 py-1 rounded-full border border-primary/40 text-primary bg-primary/5 font-medium hover:bg-primary/10"
                    title="Channels the providers added since your last review, in categories this playlist uses">
                    <Sparkles className="h-3.5 w-3.5" /> {changes.new_count} new at the providers
                </button>
            )}

            <label className="flex items-center gap-2 px-2.5 py-1 rounded-full border cursor-pointer"
                title="Publish each channel's number in the M3U (tvg-chno) so the player shows this numbering instead of its own">
                <Switch checked={useChannelNumbers} onCheckedChange={setUseChannelNumbers} />
                <span className="text-muted-foreground">Publish channel numbers</span>
            </label>

            <Button variant="ghost" size="sm" className="h-7 px-2 text-primary hover:bg-primary/10 ml-auto"
                onClick={() => navigate(`/live-epg?playlist_id=${playlist?.id}`)} title="Choose the guide sources and map channels to them">
                <Settings className="h-3.5 w-3.5 mr-1" /> Guide sources &amp; mapping
            </Button>
        </div>
    );
};
