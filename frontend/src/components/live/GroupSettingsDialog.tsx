import { FC, useEffect, useMemo, useState } from 'react';
import { Dialog } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Loader2 } from 'lucide-react';
import api from '@/lib/api';
import { useToast } from '@/contexts/ToastContext';
import { useLiveSelection, parseRule, PlaylistBouquet, GroupRule, Category } from '@/contexts/LiveSelectionContext';

const words = (text: string) => text.split(',').map(w => w.trim()).filter(Boolean);

/**
 * Name, channel-number range and rule of one group.
 *
 * The range is what keeps a group from spilling into the next one. The rule
 * turns the group into one that follows the provider: every hour the matching
 * channels it does not hold yet are added (a removed one is remembered as
 * unwanted and never comes back).
 */
export const GroupSettingsDialog: FC<{ group: PlaylistBouquet | null; onClose: () => void }> = ({ group, onClose }) => {
    const toast = useToast();
    const { playlist, allSubscriptions, updateGroupSettings, runTool, bouquetLabel, useChannelNumbers } = useLiveSelection();

    const [name, setName] = useState('');
    const [start, setStart] = useState('');
    const [end, setEnd] = useState('');
    const [ruleOn, setRuleOn] = useState(false);
    const [subId, setSubId] = useState<number | 0>(0);
    const [categoryIds, setCategoryIds] = useState<Set<string>>(new Set());
    const [include, setInclude] = useState('');
    const [exclude, setExclude] = useState('');
    const [categories, setCategories] = useState<Category[]>([]);
    const [catFilter, setCatFilter] = useState('');
    const [preview, setPreview] = useState<{ total: number; sample: { name: string }[] } | null>(null);
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        if (!group) return;
        const rule = parseRule(group.rule);
        setName(group.custom_name ?? '');
        setStart(group.number_start != null ? String(group.number_start) : '');
        setEnd(group.number_end != null ? String(group.number_end) : '');
        setRuleOn(!!rule);
        setSubId(rule?.subscription_ids?.[0] ?? (allSubscriptions[0]?.id ?? 0));
        setCategoryIds(new Set(rule?.category_ids ?? []));
        setInclude((rule?.include ?? []).join(', '));
        setExclude((rule?.exclude ?? []).join(', '));
        setPreview(null);
        setCatFilter('');
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [group?.id]);

    useEffect(() => {
        if (!ruleOn || !subId) { setCategories([]); return; }
        api.get<Category[]>(`/live/categories?subscription_id=${subId}`)
            .then(r => setCategories(r.data))
            .catch(() => setCategories([]));
    }, [ruleOn, subId]);

    const rule: GroupRule = {
        subscription_ids: subId ? [subId] : [],
        category_ids: subId ? [...categoryIds] : [],
        include: words(include),
        exclude: words(exclude),
    };
    const ruleUsable = rule.category_ids.length > 0 || rule.include.length > 0;

    const shownCategories = useMemo(() => {
        const needle = catFilter.trim().toLowerCase();
        const list = needle ? categories.filter(c => c.category_name.toLowerCase().includes(needle)) : categories;
        // Ticked ones first, so they stay visible in a 900-entry list.
        return [...list].sort((a, b) => Number(categoryIds.has(b.category_id)) - Number(categoryIds.has(a.category_id))).slice(0, 300);
    }, [categories, catFilter, categoryIds]);

    // The range other groups already own, to suggest a free one.
    const suggestion = useMemo(() => {
        if (!group) return null;
        const numbers = group.channels.map(c => c.order).filter(n => n > 0);
        if (!numbers.length) return null;
        return { start: Math.min(...numbers), end: Math.max(...numbers) };
    }, [group]);

    if (!group) return null;

    const runPreview = async () => {
        if (!playlist || !ruleUsable) return;
        setBusy(true);
        try {
            const res = await api.post(`/live/playlists/${playlist.id}/rules/preview`, rule);
            setPreview(res.data);
        } catch (error) {
            toast.apiError('Preview failed', error);
        } finally {
            setBusy(false);
        }
    };

    const save = async () => {
        const s = start.trim() ? Number(start) : null;
        const e = end.trim() ? Number(end) : null;
        if ((s !== null && !Number.isInteger(s)) || (e !== null && !Number.isInteger(e))) {
            toast.error('Invalid range', 'Use whole numbers.');
            return;
        }
        if (ruleOn && !ruleUsable) {
            toast.error('The rule is too broad', 'Tick at least one category or type at least one keyword.');
            return;
        }
        const hadRule = !!parseRule(group.rule);
        setBusy(true);
        const ok = await updateGroupSettings(group.id, {
            custom_name: name.trim() || undefined,
            number_start: s,
            number_end: e,
            rule: ruleOn ? rule : null,
        });
        setBusy(false);
        if (!ok) return;
        toast.success('Group saved', bouquetLabel({ ...group, custom_name: name.trim() || group.custom_name }));
        onClose();
        if (ruleOn && !hadRule) {
            const res = await runTool('refresh_rules');
            const added = res?.groups?.find((g: any) => g.id === group.id)?.added ?? 0;
            toast.success('Rule applied', `${added} matching channel(s) added. New ones will join every hour.`);
        }
    };

    return (
        <Dialog isOpen={!!group} onClose={onClose} title={`Group settings — ${bouquetLabel(group)}`} size="lg">
            <div className="space-y-5 text-sm">
                <div className="space-y-1">
                    <Label htmlFor="group-name">Name</Label>
                    <Input id="group-name" value={name} onChange={e => setName(e.target.value)} />
                </div>

                <div className="space-y-1">
                    <Label>Channel numbers this group owns</Label>
                    <div className="flex items-center gap-2">
                        <Input className="w-28" inputMode="numeric" placeholder="from" value={start} onChange={e => setStart(e.target.value)} />
                        <span>–</span>
                        <Input className="w-28" inputMode="numeric" placeholder="to" value={end} onChange={e => setEnd(e.target.value)} />
                        {suggestion && (
                            <Button size="sm" variant="ghost" className="text-xs"
                                onClick={() => { setStart(String(suggestion.start)); setEnd(String(suggestion.end)); }}>
                                Use current ({suggestion.start}–{suggestion.end})
                            </Button>
                        )}
                    </div>
                    <p className="text-xs text-muted-foreground">
                        {useChannelNumbers
                            ? 'New channels take the next free number inside this range, so the group never spills into the next one. Leave empty for no limit.'
                            : 'Only used when the playlist publishes channel numbers (switch in the bar above).'}
                    </p>
                </div>

                <div className="space-y-3 border rounded-md p-3">
                    <div className="flex items-center justify-between gap-3">
                        <div>
                            <Label>Keep this group topped up automatically</Label>
                            <p className="text-xs text-muted-foreground">
                                Every hour, the provider's channels matching the rule are added. A channel you remove is hidden and never comes back.
                            </p>
                        </div>
                        <Switch checked={ruleOn} onCheckedChange={setRuleOn} />
                    </div>

                    {ruleOn && (
                        <>
                            <div className="grid gap-3 md:grid-cols-2">
                                <div className="space-y-1">
                                    <Label>Provider</Label>
                                    <select className="w-full text-sm p-2 border rounded bg-background" value={subId}
                                        onChange={e => { setSubId(Number(e.target.value)); setCategoryIds(new Set()); setPreview(null); }}>
                                        <option value={0}>Any provider (keywords only)</option>
                                        {allSubscriptions.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                                    </select>
                                </div>
                                <div className="space-y-1">
                                    <Label>Name contains (any of, comma-separated)</Label>
                                    <Input placeholder="bein sport, rmc sport" value={include} onChange={e => { setInclude(e.target.value); setPreview(null); }} />
                                </div>
                                <div className="space-y-1 md:col-start-2">
                                    <Label>But not (comma-separated)</Label>
                                    <Input placeholder="4k, +1, radio" value={exclude} onChange={e => { setExclude(e.target.value); setPreview(null); }} />
                                </div>
                            </div>
                            {subId > 0 && (
                                <div className="space-y-1">
                                    <Label>In these categories {categoryIds.size > 0 && <span className="text-muted-foreground font-normal">({categoryIds.size} ticked)</span>}</Label>
                                    <Input placeholder={`Filter ${categories.length} categories…`} value={catFilter} onChange={e => setCatFilter(e.target.value)} />
                                    <div className="max-h-40 overflow-y-auto border rounded grid grid-cols-1 md:grid-cols-2 gap-x-2 p-1">
                                        {shownCategories.map(c => (
                                            <label key={c.category_id} className="flex items-center gap-2 text-xs px-1 py-0.5 rounded hover:bg-muted cursor-pointer">
                                                <input type="checkbox" checked={categoryIds.has(c.category_id)}
                                                    onChange={() => {
                                                        setCategoryIds(prev => {
                                                            const next = new Set(prev);
                                                            if (next.has(c.category_id)) next.delete(c.category_id); else next.add(c.category_id);
                                                            return next;
                                                        });
                                                        setPreview(null);
                                                    }} />
                                                <span className="truncate" title={c.category_name}>{c.category_name}</span>
                                            </label>
                                        ))}
                                    </div>
                                </div>
                            )}
                            <div className="flex items-center gap-2">
                                <Button size="sm" variant="outline" onClick={runPreview} disabled={!ruleUsable || busy}>
                                    {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Preview matches'}
                                </Button>
                                {preview && (
                                    <span className="text-xs text-muted-foreground truncate">
                                        <strong className="text-foreground">{preview.total}</strong> match
                                        {preview.sample.length > 0 && <> — {preview.sample.slice(0, 6).map(s => s.name).join(', ')}{preview.total > 6 ? '…' : ''}</>}
                                    </span>
                                )}
                            </div>
                        </>
                    )}
                </div>

                <div className="flex justify-end gap-2 pt-2 border-t">
                    <Button variant="ghost" onClick={onClose}>Cancel</Button>
                    <Button onClick={save} disabled={busy}>Save</Button>
                </div>
            </div>
        </Dialog>
    );
};
