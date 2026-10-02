import { FC, useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Loader2, CheckCircle2 } from 'lucide-react';
import api from '@/lib/api';
import { useToast } from '@/contexts/ToastContext';
import { useLiveSelection, ExactChannel } from '@/contexts/LiveSelectionContext';

interface Candidate {
    subscription_id: number; subscription_name: string; stream_id: string;
    name: string; quality: string; stream_icon?: string;
}
interface Missing {
    number: number; name: string; group: string; tvg_id: string; has_guide: boolean;
    candidates: Candidate[]; candidate_count: number;
}
interface Report { profile: string | null; missing: Missing[]; without_source: number }

/**
 * Reference channels this playlist does not carry although a provider does:
 * France 2 missing from a French playlist is found as "FR| FRANCE 2 FHD".
 * Each one is added with its official number, its clean name and its guide id.
 */
export const MissingChannels: FC = () => {
    const toast = useToast();
    const { playlist, bouquetLabel, selectedBouquetId, addExact } = useLiveSelection();
    const [report, setReport] = useState<Report | null>(null);
    const [loading, setLoading] = useState(false);
    const [choice, setChoice] = useState<Record<string, number>>({});
    const [fallback, setFallback] = useState<number | ''>(selectedBouquetId ?? '');
    const [busy, setBusy] = useState(false);

    const load = async () => {
        if (!playlist) return;
        setLoading(true);
        try {
            const res = await api.get<Report>(`/live/playlists/${playlist.id}/reference-missing`);
            setReport(res.data);
            setChoice({});
        } catch (error) {
            toast.apiError('Could not compare with the reference', error);
        } finally {
            setLoading(false);
        }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    useEffect(() => { load(); }, [playlist?.id]);

    const groupByName = useMemo(() => new Map((playlist?.bouquets ?? []).map(b => [b.custom_name ?? '', b.id])), [playlist]);
    const key = (m: Missing) => `${m.number}:${m.name}`;
    const targetOf = (m: Missing) => groupByName.get(m.group) ?? (fallback || null);

    const add = async (items: Missing[]) => {
        setBusy(true);
        const byGroup = new Map<number, ExactChannel[]>();
        let skipped = 0;
        items.forEach(m => {
            const group = targetOf(m);
            const c = m.candidates[choice[key(m)] ?? 0];
            if (!group || !c) { skipped++; return; }
            if (!byGroup.has(group)) byGroup.set(group, []);
            byGroup.get(group)!.push({
                stream_id: c.stream_id, subscription_id: c.subscription_id,
                custom_name: m.name, order: m.number, epg_channel_id: m.tvg_id || null,
            });
        });
        let added = 0;
        for (const [group, rows] of byGroup) added += await addExact(group, rows);
        setBusy(false);
        toast.success(`${added} reference channel(s) added`,
            `${skipped ? `${skipped} skipped: no group of that name, choose one for them. ` : ''}Ctrl+Z undoes it.`);
        load();
    };

    if (loading && !report) return <div className="py-10 flex justify-center"><Loader2 className="h-6 w-6 animate-spin text-primary" /></div>;
    if (!report) return null;
    if (!report.profile) return <p className="py-6 text-center text-sm text-muted-foreground">No reference profile recognises this playlist.</p>;

    const addable = report.missing.filter(m => targetOf(m));

    return (
        <div className="space-y-3 text-sm">
            <p className="text-xs text-muted-foreground">
                Channels of the <strong>{report.profile}</strong> reference that this playlist lacks and a provider carries.
                They are added with their official number, a clean name and their guide id.
                {report.without_source > 0 && ` ${report.without_source} other reference channel(s) are carried by no provider.`}
            </p>
            {report.missing.length === 0 ? (
                <div className="py-6 flex flex-col items-center gap-2 text-muted-foreground">
                    <CheckCircle2 className="h-7 w-7 text-emerald-500" /> Nothing missing.
                </div>
            ) : (
                <>
                    <div className="flex flex-wrap items-center gap-2 text-xs">
                        <span>A channel whose group does not exist here goes to</span>
                        <select className="border rounded p-1 bg-background" value={fallback} onChange={e => setFallback(e.target.value ? Number(e.target.value) : '')}>
                            <option value="">— skip it —</option>
                            {playlist?.bouquets.map(b => <option key={b.id} value={b.id}>{bouquetLabel(b)}</option>)}
                        </select>
                        <Button size="sm" className="h-7 text-xs ml-auto" disabled={busy || addable.length === 0} onClick={() => add(addable)}>
                            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : `Add all ${addable.length}`}
                        </Button>
                    </div>
                    <div className="max-h-[50vh] overflow-y-auto border rounded divide-y">
                        {report.missing.map(m => {
                            const group = targetOf(m);
                            return (
                                <div key={key(m)} className="flex items-center gap-2 px-2 py-1.5">
                                    <span className="w-12 text-right font-mono text-xs text-muted-foreground">{m.number}</span>
                                    <span className="flex-1 min-w-0">
                                        <span className="block truncate font-medium">{m.name}</span>
                                        <span className="block truncate text-[10px] text-muted-foreground">
                                            {m.group}{groupByName.has(m.group) ? '' : ' (no such group here)'}{m.has_guide ? ' · guide' : ' · no guide'}
                                        </span>
                                    </span>
                                    <select className="border rounded p-1 bg-background text-xs max-w-[16rem]" value={choice[key(m)] ?? 0}
                                        onChange={e => setChoice(prev => ({ ...prev, [key(m)]: Number(e.target.value) }))}
                                        title={`${m.candidate_count} feed(s) found`}>
                                        {m.candidates.map((c, i) => <option key={`${c.subscription_id}:${c.stream_id}`} value={i}>{c.subscription_name} · {c.name}</option>)}
                                    </select>
                                    <Button size="sm" variant="outline" className="h-7 text-xs" disabled={busy || !group} onClick={() => add([m])}>Add</Button>
                                </div>
                            );
                        })}
                    </div>
                </>
            )}
        </div>
    );
};
