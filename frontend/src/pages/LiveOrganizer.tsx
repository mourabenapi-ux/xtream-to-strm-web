import { useEffect, useMemo, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
    Loader2, Wand2, ChevronRight, ChevronDown, AlertTriangle, CheckCircle2,
    Tv, ListOrdered, HelpCircle, Layers,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useToast } from '@/contexts/ToastContext';
import api from '@/lib/api';

interface Subscription { id: number; name: string; kind?: string; }
interface Category { category_id: string; category_name: string; }

interface PlanStream {
    subscription_id: number;
    stream_id: string;
    provider_name: string;
    quality: string;
    category_name?: string;
}

interface PlanChannel {
    number: number;
    name: string;
    group: string;
    tvg_id: string;
    logo: string;
    has_guide: boolean;
    match_method: 'tvg_id' | 'alias' | 'fuzzy' | 'none';
    match_score: number;
    reference_name: string;
    needs_confirmation: boolean;
    stream: PlanStream;
    backups: PlanStream[];
}

interface PlanGroup { name: string; channels: PlanChannel[]; }

interface Plan {
    reference_version: string;
    reference_profile: string;
    source_stream_count: number;
    stats: Record<string, number>;
    groups: PlanGroup[];
    to_confirm: PlanChannel[];
    junk_dropped: string[];
}

interface Profile {
    name: string;
    version: string;
    blocks: string[];
    block_count: number;
    family_count: number;
    channels: number;
    is_default: boolean;
}

/** What each profile is for, in the terms that decide the choice. */
const PROFILE_LABELS: Record<string, { title: string; hint: string }> = {
    detailed: {
        title: 'Detailed — 11 themed blocks',
        hint: 'One bouquet per theme. Everything the reference does not know lands in a single tail bouquet, which on a full French catalogue means about 1 600 channels.',
    },
    compact: {
        title: 'Compact — 8 bouquets',
        hint: 'TNT with the généralistes, Découverte with Jeunesse, +1 feeds in Secours. Family rules place the PPV slots, the African channels and the 24/7 loops in bouquets of their own instead of the tail.',
    },
};

const QUALITY_PRESETS: Record<string, string[]> = {
    'Best available (4K first)': ['4K', 'FHD', 'HD', 'SD', '8K'],
    'Prefer HD (safer bitrate)': ['HD', 'FHD', '4K', 'SD', '8K'],
    'Lightest (SD first)': ['SD', 'HD', 'FHD', '4K', '8K'],
};

/**
 * Proposes an organisation of the live channels, and applies it into a new
 * playlist once validated.
 *
 * The screen is deliberately two-phase: nothing is written until the plan has
 * been seen. The fuzzy matches sit in their own section because they are the
 * only ones that can be wrong in a way that looks right, and they start
 * unchecked — a channel is easier to add afterwards than to notice on the wrong
 * number weeks later.
 */
export default function LiveOrganizer() {
    const toast = useToast();
    const navigate = useNavigate();

    const [subscriptions, setSubscriptions] = useState<Subscription[]>([]);
    const [categories, setCategories] = useState<Record<number, Category[]>>({});
    const [selected, setSelected] = useState<Record<number, Set<string>>>({});
    const [loadingCategories, setLoadingCategories] = useState(false);

    const [profiles, setProfiles] = useState<Profile[]>([]);
    const [profile, setProfile] = useState('compact');
    const [qualityPreset, setQualityPreset] = useState('Best available (4K first)');
    const [keepBackups, setKeepBackups] = useState(true);
    const [separateTimeshift, setSeparateTimeshift] = useState(true);
    const [includeUnmatched, setIncludeUnmatched] = useState(true);

    const [plan, setPlan] = useState<Plan | null>(null);
    const [computing, setComputing] = useState(false);
    const [applying, setApplying] = useState(false);
    const [openGroups, setOpenGroups] = useState<Set<string>>(new Set());
    const [confirmed, setConfirmed] = useState<Set<number>>(new Set());
    const [playlistName, setPlaylistName] = useState('FR — organised');
    const [showApplyDialog, setShowApplyDialog] = useState(false);

    useEffect(() => {
        (async () => {
            try {
                const res = await api.get<Subscription[]>('/subscriptions');
                setSubscriptions(res.data);
            } catch (error) {
                toast.apiError('Could not load subscriptions', error);
            }
            try {
                const res = await api.get<Profile[]>('/organizer/profiles');
                setProfiles(res.data);
                // Only fall back if the profile this screen prefers is gone.
                if (!res.data.some(p => p.name === 'compact') && res.data.length) {
                    setProfile(res.data[0].name);
                }
            } catch (error) {
                toast.apiError('Could not load the reference profiles', error);
            }
        })();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const loadCategories = async (subscriptionId: number) => {
        if (categories[subscriptionId]) return;
        setLoadingCategories(true);
        try {
            const res = await api.get<Category[]>(
                `/live/categories?subscription_id=${subscriptionId}`);
            setCategories(prev => ({ ...prev, [subscriptionId]: res.data }));
        } catch (error) {
            toast.apiError('Could not load categories', error);
        } finally {
            setLoadingCategories(false);
        }
    };

    const toggleCategory = (subscriptionId: number, categoryId: string) => {
        setSelected(prev => {
            const next = { ...prev };
            const set = new Set(next[subscriptionId] ?? []);
            if (set.has(categoryId)) set.delete(categoryId); else set.add(categoryId);
            next[subscriptionId] = set;
            return next;
        });
    };

    /** Selects the categories whose name marks them as French. */
    const selectFrench = (subscriptionId: number) => {
        const list = categories[subscriptionId] ?? [];
        const french = list.filter(c => /^\s*fr\s*[|\-_:]/i.test(c.category_name));
        setSelected(prev => ({
            ...prev,
            [subscriptionId]: new Set(french.map(c => c.category_id)),
        }));
    };

    const selectedCount = useMemo(
        () => Object.values(selected).reduce((total, set) => total + set.size, 0),
        [selected]);

    const computePlan = async () => {
        const scopes = Object.entries(selected)
            .filter(([, set]) => set.size > 0)
            .map(([subscriptionId, set]) => ({
                subscription_id: Number(subscriptionId),
                category_ids: Array.from(set),
            }));
        if (scopes.length === 0) {
            toast.error('Nothing selected', 'Pick at least one category to organise.');
            return;
        }
        setComputing(true);
        setPlan(null);
        try {
            const res = await api.post<Plan>('/organizer/preview', {
                scopes,
                profile,
                options: {
                    quality_preference: QUALITY_PRESETS[qualityPreset],
                    keep_backups: keepBackups,
                    separate_timeshift: separateTimeshift,
                    include_unmatched: includeUnmatched,
                },
            });
            setPlan(res.data);
            setConfirmed(new Set());
            setOpenGroups(new Set(res.data.groups.slice(0, 1).map(g => g.name)));
            toast.success('Proposal ready',
                `${res.data.stats.channels} channels in ${res.data.stats.groups} groups.`);
        } catch (error) {
            toast.apiError('Could not build the proposal', error);
        } finally {
            setComputing(false);
        }
    };

    /** Everything except the fuzzy matches the user has not ticked. */
    const channelsToApply = useMemo(() => {
        if (!plan) return [];
        return plan.groups.flatMap(group => group.channels).filter(
            channel => !channel.needs_confirmation || confirmed.has(channel.number));
    }, [plan, confirmed]);

    const applyPlan = async () => {
        if (!plan) return;
        setApplying(true);
        try {
            const res = await api.post('/organizer/apply', {
                playlist_name: playlistName.trim(),
                description: `Automatic organisation — reference ${plan.reference_version}`,
                group_order: plan.groups.map(g => g.name),
                channels: channelsToApply.map(channel => ({
                    number: channel.number,
                    name: channel.name,
                    group: channel.group,
                    tvg_id: channel.tvg_id,
                    subscription_id: channel.stream.subscription_id,
                    stream_id: channel.stream.stream_id,
                })),
            });
            toast.success('Playlist created',
                `${res.data.channels} channels in ${res.data.groups} groups.`);
            navigate('/live-playlists');
        } catch (error) {
            toast.apiError('Could not create the playlist', error);
        } finally {
            setApplying(false);
            setShowApplyDialog(false);
        }
    };

    const toggleGroup = (name: string) => {
        setOpenGroups(prev => {
            const next = new Set(prev);
            if (next.has(name)) next.delete(name); else next.add(name);
            return next;
        });
    };

    const methodBadge = (channel: PlanChannel) => {
        const styles: Record<string, string> = {
            tvg_id: 'bg-green-500/15 text-green-600',
            alias: 'bg-blue-500/15 text-blue-600',
            fuzzy: 'bg-amber-500/15 text-amber-600',
            none: 'bg-muted text-muted-foreground',
        };
        const labels: Record<string, string> = {
            tvg_id: 'guide id', alias: 'name', fuzzy: `fuzzy ${channel.match_score}`,
            none: 'unmatched',
        };
        return (
            <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${styles[channel.match_method]}`}>
                {labels[channel.match_method]}
            </span>
        );
    };

    return (
        <div className="space-y-6">
            <div>
                <h1 className="text-3xl font-bold flex items-center gap-2">
                    <Wand2 className="text-primary" /> Auto Organizer
                </h1>
                <p className="text-muted-foreground mt-1">
                    Matches your catalogue against a reference channel list, merges the
                    quality variants, and proposes a numbered, grouped playlist. Nothing
                    is written until you apply.
                </p>
            </div>

            <Card>
                <CardHeader>
                    <CardTitle className="text-lg flex items-center gap-2">
                        <Layers size={18} /> 1. What to organise
                    </CardTitle>
                    <CardDescription>
                        Pick the categories to read. {selectedCount} selected.
                    </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                    {subscriptions.map(subscription => (
                        <div key={subscription.id} className="border rounded-md p-3">
                            <div className="flex items-center justify-between mb-2">
                                <span className="font-medium flex items-center gap-2">
                                    {subscription.name}
                                    <span className="text-xs font-normal px-1.5 py-0.5 rounded border text-muted-foreground">
                                        {subscription.kind === 'm3u' ? 'M3U' : 'Xtream'}
                                    </span>
                                </span>
                                <div className="flex gap-2">
                                    <Button size="sm" variant="outline"
                                        onClick={() => loadCategories(subscription.id)}
                                        disabled={loadingCategories}>
                                        {categories[subscription.id] ? 'Reload' : 'Load categories'}
                                    </Button>
                                    {categories[subscription.id] && (
                                        <Button size="sm" variant="outline"
                                            onClick={() => selectFrench(subscription.id)}>
                                            Select French
                                        </Button>
                                    )}
                                </div>
                            </div>
                            {categories[subscription.id] && (
                                <div className="max-h-56 overflow-y-auto grid grid-cols-1 md:grid-cols-2 gap-1">
                                    {categories[subscription.id].map(category => (
                                        <label key={category.category_id}
                                            className="flex items-center gap-2 text-sm px-2 py-1 rounded hover:bg-accent cursor-pointer">
                                            <Checkbox
                                                checked={selected[subscription.id]?.has(category.category_id) ?? false}
                                                onCheckedChange={() => toggleCategory(subscription.id, category.category_id)}
                                            />
                                            <span className="truncate">{category.category_name}</span>
                                        </label>
                                    ))}
                                </div>
                            )}
                        </div>
                    ))}
                </CardContent>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle className="text-lg">2. How to merge</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                    {profiles.length > 1 && (
                        <div className="space-y-2">
                            <Label>Reference profile</Label>
                            <div className="grid gap-2 md:grid-cols-2">
                                {profiles.map(p => {
                                    const meta = PROFILE_LABELS[p.name];
                                    return (
                                        <button key={p.name} type="button"
                                            onClick={() => setProfile(p.name)}
                                            className={`text-left border rounded-md p-3 transition-colors ${
                                                profile === p.name
                                                    ? 'border-primary bg-primary/5'
                                                    : 'hover:bg-muted/50'}`}>
                                            <div className="font-medium text-sm">
                                                {meta?.title ?? p.name}
                                            </div>
                                            <p className="text-xs text-muted-foreground mt-1">
                                                {meta?.hint ?? `${p.block_count} blocks`}
                                            </p>
                                            <p className="text-[10px] text-muted-foreground mt-1">
                                                {p.channels} reference channels · {p.block_count} blocks
                                                {p.family_count > 0 && ` · ${p.family_count} family rules`}
                                            </p>
                                        </button>
                                    );
                                })}
                            </div>
                        </div>
                    )}
                    <div className="flex flex-wrap gap-2">
                        {Object.keys(QUALITY_PRESETS).map(preset => (
                            <Button key={preset} size="sm"
                                variant={qualityPreset === preset ? 'default' : 'outline'}
                                onClick={() => setQualityPreset(preset)}>
                                {preset}
                            </Button>
                        ))}
                    </div>
                    <div className="flex items-center justify-between">
                        <div>
                            <Label>Keep the discarded variants</Label>
                            <p className="text-xs text-muted-foreground">
                                SD, HD, RAW feeds go to a "Secours / Alternatives" group at the end.
                            </p>
                        </div>
                        <Switch checked={keepBackups} onCheckedChange={setKeepBackups} />
                    </div>
                    <div className="flex items-center justify-between">
                        <div>
                            <Label>Keep +1 channels separate</Label>
                            <p className="text-xs text-muted-foreground">
                                Delayed feeds get their own group, never a real channel's number.
                            </p>
                        </div>
                        <Switch checked={separateTimeshift} onCheckedChange={setSeparateTimeshift} />
                    </div>
                    <div className="flex items-center justify-between">
                        <div>
                            <Label>Include channels the reference does not know</Label>
                            <p className="text-xs text-muted-foreground">
                                A family rule may group them; otherwise they land in a tail
                                group, never in a themed one on a guess.
                            </p>
                        </div>
                        <Switch checked={includeUnmatched} onCheckedChange={setIncludeUnmatched} />
                    </div>
                    <Button onClick={computePlan} disabled={computing || selectedCount === 0}>
                        {computing
                            ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Reading providers…</>
                            : <><Wand2 className="mr-2 h-4 w-4" /> Build the proposal</>}
                    </Button>
                </CardContent>
            </Card>

            {plan && (
                <>
                    <Card>
                        <CardHeader>
                            <CardTitle className="text-lg flex items-center gap-2">
                                <ListOrdered size={18} /> 3. The proposal
                            </CardTitle>
                            <CardDescription>
                                {plan.source_stream_count} provider streams read · reference {plan.reference_version}
                                {plan.reference_profile && ` · profile ${plan.reference_profile}`}
                            </CardDescription>
                        </CardHeader>
                        <CardContent className="space-y-4">
                            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                                {[
                                    ['Channels', plan.stats.channels, Tv],
                                    ['Groups', plan.stats.groups, Layers],
                                    ['With guide', plan.stats.with_guide, CheckCircle2],
                                    ['Backups kept', plan.stats.backups, Layers],
                                    ['Matched by guide id', plan.stats.matched_by_tvg_id, CheckCircle2],
                                    ['Matched by name', plan.stats.matched_by_alias, CheckCircle2],
                                    ['To confirm', plan.stats.to_confirm, AlertTriangle],
                                    ['Grouped by rule', plan.stats.placed_by_family ?? 0, Layers],
                                    ['Left in the tail', plan.stats.in_tail ?? plan.stats.unmatched, HelpCircle],
                                ].map(([label, value, Icon]: any) => (
                                    <div key={label} className="border rounded-md p-3">
                                        <div className="flex items-center gap-2 text-muted-foreground text-xs">
                                            <Icon size={14} /> {label}
                                        </div>
                                        <div className="text-2xl font-semibold">{value}</div>
                                    </div>
                                ))}
                            </div>
                            {plan.junk_dropped.length > 0 && (
                                <p className="text-xs text-muted-foreground">
                                    {plan.junk_dropped.length} separator rows dropped
                                    (e.g. “{plan.junk_dropped[0]}”).
                                </p>
                            )}
                        </CardContent>
                    </Card>

                    {plan.to_confirm.length > 0 && (
                        <Card className="border-amber-500/40">
                            <CardHeader>
                                <CardTitle className="text-lg flex items-center gap-2">
                                    <AlertTriangle size={18} className="text-amber-500" />
                                    Needs your eye — {plan.to_confirm.length} uncertain matches
                                </CardTitle>
                                <CardDescription>
                                    These were matched by similarity, not by identity. They are
                                    left out unless you tick them.
                                </CardDescription>
                            </CardHeader>
                            <CardContent className="space-y-1">
                                {plan.to_confirm.map(channel => (
                                    <label key={channel.number}
                                        className="flex items-center gap-3 text-sm px-2 py-1.5 rounded hover:bg-accent cursor-pointer">
                                        <Checkbox
                                            checked={confirmed.has(channel.number)}
                                            onCheckedChange={() => setConfirmed(prev => {
                                                const next = new Set(prev);
                                                if (next.has(channel.number)) next.delete(channel.number);
                                                else next.add(channel.number);
                                                return next;
                                            })}
                                        />
                                        <span className="font-mono text-xs text-muted-foreground w-12">
                                            {channel.number}
                                        </span>
                                        <span className="truncate flex-1">
                                            <span className="text-muted-foreground">
                                                {channel.stream.provider_name}
                                            </span>
                                            <ChevronRight size={12} className="inline mx-1" />
                                            <span className="font-medium">{channel.reference_name}</span>
                                        </span>
                                        {methodBadge(channel)}
                                    </label>
                                ))}
                            </CardContent>
                        </Card>
                    )}

                    <Card>
                        <CardHeader>
                            <CardTitle className="text-lg">The channel list</CardTitle>
                        </CardHeader>
                        <CardContent className="space-y-2">
                            {plan.groups.map(group => (
                                <div key={group.name} className="border rounded-md">
                                    <button
                                        onClick={() => toggleGroup(group.name)}
                                        className="w-full flex items-center justify-between px-3 py-2 hover:bg-accent rounded-md">
                                        <span className="flex items-center gap-2 font-medium">
                                            {openGroups.has(group.name)
                                                ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                                            {group.name}
                                        </span>
                                        <span className="text-sm text-muted-foreground">
                                            {group.channels.length}
                                        </span>
                                    </button>
                                    {openGroups.has(group.name) && (
                                        <div className="border-t divide-y">
                                            {group.channels.map(channel => (
                                                <div key={`${channel.number}-${channel.stream.stream_id}`}
                                                    className="flex items-center gap-3 px-3 py-1.5 text-sm">
                                                    <span className="font-mono text-xs text-muted-foreground w-12">
                                                        {channel.number}
                                                    </span>
                                                    <span className="flex-1 truncate">{channel.name}</span>
                                                    {!channel.has_guide && (
                                                        <span className="text-[10px] text-muted-foreground">no guide</span>
                                                    )}
                                                    {channel.backups.length > 0 && (
                                                        <span className="text-[10px] text-muted-foreground">
                                                            +{channel.backups.length} alt
                                                        </span>
                                                    )}
                                                    <span className="text-xs text-muted-foreground truncate max-w-[16rem]">
                                                        {channel.stream.provider_name}
                                                    </span>
                                                    {methodBadge(channel)}
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                </div>
                            ))}
                        </CardContent>
                    </Card>

                    <Card>
                        <CardHeader>
                            <CardTitle className="text-lg">4. Apply</CardTitle>
                            <CardDescription>
                                Creates a new playlist. Your existing playlists are never touched.
                            </CardDescription>
                        </CardHeader>
                        <CardContent className="space-y-3">
                            <div>
                                <Label htmlFor="playlist-name">Playlist name</Label>
                                <Input id="playlist-name" value={playlistName}
                                    onChange={e => setPlaylistName(e.target.value)} />
                            </div>
                            <Button onClick={() => setShowApplyDialog(true)}
                                disabled={applying || !playlistName.trim() || channelsToApply.length === 0}>
                                {applying
                                    ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Creating…</>
                                    : <>Create playlist with {channelsToApply.length} channels</>}
                            </Button>
                        </CardContent>
                    </Card>
                </>
            )}

            <ConfirmDialog
                isOpen={showApplyDialog}
                onClose={() => setShowApplyDialog(false)}
                onConfirm={applyPlan}
                title="Create the organised playlist"
                confirmLabel="Create playlist"
            >
                <p>
                    <strong>{channelsToApply.length}</strong> channels will be written into a
                    new playlist named <strong>{playlistName}</strong>.
                </p>
                <p className="text-muted-foreground">
                    Your existing playlists are not modified. Delete this one if the result
                    does not suit you.
                </p>
            </ConfirmDialog>
        </div>
    );
}
