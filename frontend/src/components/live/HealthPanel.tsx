import { FC, useEffect, useMemo, useState } from 'react';
import { Dialog } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { AlertTriangle, AlertCircle, Info, Loader2, CheckCircle2, Wand2, Eye, Sparkles } from 'lucide-react';
import { useToast } from '@/contexts/ToastContext';
import { useLiveSelection, HealthIssue, streamKey, BasketItem, ServerTool } from '@/contexts/LiveSelectionContext';
import { MissingChannels } from './MissingChannels';

const ICON = {
    error: <AlertCircle className="h-4 w-4 text-destructive flex-shrink-0" />,
    warning: <AlertTriangle className="h-4 w-4 text-amber-500 flex-shrink-0" />,
    info: <Info className="h-4 w-4 text-sky-500 flex-shrink-0" />,
};

const FIX_LABEL: Record<string, string> = {
    repair_dead: 'Repair automatically',
    dedupe: 'Remove the copies',
    fix_numbering: 'Fix the numbering',
    auto_match: 'Match guides automatically',
};

/**
 * Everything wrong with the playlist as the player receives it, each with
 * its one-click fix, and what the providers added or dropped since the last
 * review. Every fix is undoable with Ctrl+Z.
 */
export const HealthPanel: FC<{ isOpen: boolean; onClose: () => void; initialTab?: 'issues' | 'new' | 'missing' }> = ({ isOpen, onClose, initialTab = 'issues' }) => {
    const toast = useToast();
    const {
        health, healthLoading, refreshHealth, runTool, setFocus, setGuideMode, useChannelNumbers,
        changes, changesLoading, loadChanges, markReviewed, playlist, bouquetLabel, addStreams, setInBasket,
    } = useLiveSelection();
    const [tab, setTab] = useState<'issues' | 'new' | 'missing'>(initialTab);
    const [busy, setBusy] = useState<string | null>(null);
    const [picked, setPicked] = useState<Set<string>>(new Set());
    const [target, setTarget] = useState<number | ''>('');

    useEffect(() => { if (isOpen) setTab(initialTab); }, [isOpen, initialTab]);
    useEffect(() => {
        if (isOpen && tab === 'new' && !changes && !changesLoading) loadChanges();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isOpen, tab]);

    const issues = health?.issues ?? [];
    const counts = useMemo(() => ({
        error: issues.filter(i => i.severity === 'error').length,
        warning: issues.filter(i => i.severity === 'warning').length,
    }), [issues]);

    const run = async (key: string, tool: ServerTool, describe: (r: any) => string) => {
        setBusy(key);
        const result = await runTool(tool);
        setBusy(null);
        if (result) toast.success('Done', `${describe(result)} Ctrl+Z undoes it.`);
    };

    const fix = (issue: HealthIssue) => {
        switch (issue.fix) {
            case 'repair_dead':
                return run(issue.type, 'repair_dead', r =>
                    `${r.repaired.length} channel(s) repaired${r.unresolved.length ? `, ${r.unresolved.length} with no replacement found (use Repair on each)` : ''}.`);
            case 'dedupe':
                return run(issue.type, 'dedupe', r => `${r.removed} copy(ies) removed.`);
            case 'fix_numbering':
                return run(issue.type, 'fix_numbering', r => `${r.changed} channel number(s) changed, every group now has a range.`);
            case 'auto_match':
                return run(issue.type, 'auto_match', r => `${r.matched_count ?? 0} channel(s) matched to a guide id.${r.message ? ` ${r.message}` : ""}`);
        }
    };

    // Every hidden channel, across the groups, in one list.
    const showHidden = () => {
        const ids = (playlist?.bouquets ?? []).flatMap(b => b.channels.filter(c => c.is_excluded).map(c => c.id));
        setFocus({ label: `${ids.length} hidden channel(s)`, ids });
        onClose();
    };

    const show = (issue: HealthIssue) => {
        if (!issue.channel_ids?.length) return;
        setFocus({ label: issue.title, ids: issue.channel_ids });
        onClose();
    };

    const newItems = changes?.new ?? [];
    const byCategory = useMemo(() => {
        const map = new Map<string, typeof newItems>();
        newItems.forEach(item => {
            const key = `${item.subscription_name} › ${item.category_name || item.category_id}`;
            if (!map.has(key)) map.set(key, []);
            map.get(key)!.push(item);
        });
        return [...map.entries()];
    }, [newItems]);
    const asBasket = (keys: Set<string>): BasketItem[] => newItems
        .filter(i => keys.has(streamKey(i.subscription_id, i.stream_id)))
        .map(i => ({
            key: streamKey(i.subscription_id, i.stream_id), subscription_id: i.subscription_id,
            stream: { stream_id: i.stream_id, name: i.name, stream_icon: i.stream_icon, epg_channel_id: i.epg_channel_id, category_id: i.category_id },
        }));

    return (
        <Dialog isOpen={isOpen} onClose={onClose} title="Playlist health" size="xl">
            <div className="space-y-3">
                <div className="flex items-center gap-1 border-b">
                    {(['issues', 'new', 'missing'] as const).map(t => (
                        <button key={t} type="button" onClick={() => setTab(t)}
                            className={`px-3 py-1.5 text-sm border-b-2 -mb-px ${tab === t ? 'border-primary font-semibold' : 'border-transparent text-muted-foreground'}`}>
                            {t === 'issues'
                                ? <>Problems {counts.error + counts.warning > 0 && <span className="ml-1 text-xs text-destructive">{counts.error + counts.warning}</span>}</>
                                : t === 'new'
                                    ? <>New at the providers {changes && changes.new_count > 0 && <span className="ml-1 text-xs text-primary">{changes.new_count}</span>}</>
                                    : <>Missing reference channels</>}
                        </button>
                    ))}
                    <span className="ml-auto text-[11px] text-muted-foreground pb-1">
                        {health && `${health.stats.served} served · ${health.stats.with_schedule} with a schedule · ${health.stats.dead} dead · `}
                        {health && (health.stats.excluded > 0 ? (
                            <button type="button" className="underline hover:text-foreground" onClick={showHidden}>{health.stats.excluded} hidden</button>
                        ) : '0 hidden')}
                    </span>
                </div>

                {tab === 'issues' && (
                    <div className="space-y-2">
                        {useChannelNumbers && (
                            <div className="flex flex-wrap items-center gap-2 p-2 rounded border bg-muted/30 text-xs">
                                <Wand2 className="h-4 w-4 text-primary" />
                                <span className="flex-1 min-w-[12rem]">Give recognised channels their official number (TF1 1, France 2 2…), then settle the rest.</span>
                                <Button size="sm" variant="outline" disabled={!!busy}
                                    onClick={() => run('reference', 'reference_numbering', r =>
                                        r.profile ? `Profile "${r.profile}": ${r.matched} recognised, ${r.changed} number(s) changed.` : 'No reference profile recognised these channels.')}>
                                    {busy === 'reference' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Number from the reference'}
                                </Button>
                            </div>
                        )}
                        {!health && healthLoading && <div className="py-10 flex justify-center"><Loader2 className="h-6 w-6 animate-spin text-primary" /></div>}
                        {health && issues.length === 0 && (
                            <div className="py-8 flex flex-col items-center gap-2 text-sm text-muted-foreground">
                                <CheckCircle2 className="h-8 w-8 text-emerald-500" /> Nothing to fix.
                            </div>
                        )}
                        {issues.map((issue, i) => (
                            <div key={`${issue.type}-${i}`} className="flex items-start gap-2 p-2.5 rounded border">
                                {ICON[issue.severity]}
                                <div className="flex-1 min-w-0">
                                    <div className="text-sm font-medium">{issue.title}</div>
                                    {issue.detail && <div className="text-xs text-muted-foreground mt-0.5 break-words">{issue.detail}</div>}
                                </div>
                                <div className="flex flex-col sm:flex-row gap-1 flex-shrink-0">
                                    {!!issue.channel_ids?.length && (
                                        <Button size="sm" variant="ghost" className="h-7 text-xs gap-1" onClick={() => show(issue)}>
                                            <Eye className="h-3.5 w-3.5" /> Show
                                        </Button>
                                    )}
                                    {issue.type === 'shared_epg' && (
                                        <Button size="sm" variant="outline" className="h-7 text-xs"
                                            onClick={async () => { await setGuideMode(issue.channel_ids ?? [], 'detach'); toast.success('Guide detached', 'Those channels publish no guide id any more. Ctrl+Z undoes it.'); }}>
                                            Detach their guide
                                        </Button>
                                    )}
                                    {issue.fix && FIX_LABEL[issue.fix] && (
                                        <Button size="sm" className="h-7 text-xs" disabled={!!busy} onClick={() => fix(issue)}>
                                            {busy === issue.type ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : FIX_LABEL[issue.fix]}
                                        </Button>
                                    )}
                                </div>
                            </div>
                        ))}
                        <div className="flex justify-end">
                            <Button size="sm" variant="ghost" className="text-xs" onClick={() => refreshHealth()} disabled={healthLoading}>
                                {healthLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : null} Check again
                            </Button>
                        </div>
                    </div>
                )}

                {tab === 'missing' && <MissingChannels />}

                {tab === 'new' && (
                    <div className="space-y-3">
                        {changesLoading && !changes && <div className="py-10 flex justify-center"><Loader2 className="h-6 w-6 animate-spin text-primary" /></div>}
                        {changes && (
                            <>
                                <p className="text-xs text-muted-foreground">
                                    Channels the providers added since {changes.since ? new Date(changes.since).toLocaleString() : 'the playlist was created'},
                                    in the categories this playlist already uses. The first check records the catalogue: from then on, only real additions appear.
                                </p>
                                {changes.lost_count > 0 && (
                                    <div className="p-2 rounded border border-destructive/30 bg-destructive/5 text-xs">
                                        <strong>{changes.lost_count}</strong> channel(s) of the playlist are no longer served: {changes.lost.slice(0, 8).map(l => l.name).join(', ')}{changes.lost_count > 8 ? '…' : ''}. See Problems › Repair.
                                    </div>
                                )}
                                {newItems.length === 0 ? (
                                    <div className="py-6 flex flex-col items-center gap-2 text-sm text-muted-foreground">
                                        <Sparkles className="h-6 w-6 opacity-40" /> No new channel.
                                    </div>
                                ) : (
                                    <>
                                        <div className="flex flex-wrap items-center gap-2 text-xs">
                                            <span>{picked.size} ticked</span>
                                            <select className="border rounded p-1 bg-background" value={target} onChange={e => setTarget(e.target.value ? Number(e.target.value) : '')}>
                                                <option value="">Add to…</option>
                                                {playlist?.bouquets.map(b => <option key={b.id} value={b.id}>{bouquetLabel(b)}</option>)}
                                            </select>
                                            <Button size="sm" className="h-7 text-xs" disabled={!picked.size || !target}
                                                onClick={async () => { await addStreams(asBasket(picked), Number(target)); setPicked(new Set()); loadChanges(); }}>
                                                Add
                                            </Button>
                                            <Button size="sm" variant="outline" className="h-7 text-xs" disabled={!picked.size}
                                                onClick={() => { setInBasket(asBasket(picked), true); toast.info('In the basket', 'Drop them on a group from the library.'); }}>
                                                Put in the basket
                                            </Button>
                                        </div>
                                        <div className="max-h-[45vh] overflow-y-auto border rounded divide-y">
                                            {byCategory.map(([category, list]) => (
                                                <div key={category}>
                                                    <label className="flex items-center gap-2 px-2 py-1 bg-muted/40 text-xs font-semibold sticky top-0">
                                                        <input type="checkbox"
                                                            checked={list.every(i => picked.has(streamKey(i.subscription_id, i.stream_id)))}
                                                            onChange={e => setPicked(prev => {
                                                                const next = new Set(prev);
                                                                list.forEach(i => e.target.checked ? next.add(streamKey(i.subscription_id, i.stream_id)) : next.delete(streamKey(i.subscription_id, i.stream_id)));
                                                                return next;
                                                            })} />
                                                        {category} <span className="text-muted-foreground font-normal">{list.length}</span>
                                                    </label>
                                                    {list.map(i => {
                                                        const key = streamKey(i.subscription_id, i.stream_id);
                                                        return (
                                                            <label key={key} className="flex items-center gap-2 px-4 py-1 text-xs hover:bg-muted/40 cursor-pointer">
                                                                <input type="checkbox" checked={picked.has(key)} onChange={() => setPicked(prev => {
                                                                    const next = new Set(prev);
                                                                    if (next.has(key)) next.delete(key); else next.add(key);
                                                                    return next;
                                                                })} />
                                                                <span className="truncate">{i.name}</span>
                                                            </label>
                                                        );
                                                    })}
                                                </div>
                                            ))}
                                        </div>
                                    </>
                                )}
                                <div className="flex justify-between items-center pt-1">
                                    <Button size="sm" variant="ghost" className="text-xs" onClick={() => loadChanges()} disabled={changesLoading}>
                                        {changesLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : null} Check again
                                    </Button>
                                    <Button size="sm" variant="outline" className="text-xs" onClick={markReviewed}>Mark all as reviewed</Button>
                                </div>
                            </>
                        )}
                    </div>
                )}
            </div>
        </Dialog>
    );
};
