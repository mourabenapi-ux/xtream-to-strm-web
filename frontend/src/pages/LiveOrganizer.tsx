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
    Tv, ListOrdered, HelpCircle, Layers, Search,
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
const PROFILE_LABELS: Record<string, { title: string; hint: string; playlist: string; categories: string }> = {
    detailed: {
        title: 'Detailed — 11 themed blocks',
        hint: 'One bouquet per theme. Everything the reference does not know lands in a single tail bouquet, which on a full French catalogue means about 1 600 channels.',
        playlist: 'FR — organised',
        categories: 'french',
    },
    compact: {
        title: 'Compact — 8 bouquets',
        hint: 'TNT with the généralistes, Découverte with Jeunesse, +1 feeds in Secours. Family rules place the PPV slots, the African channels and the 24/7 loops in bouquets of their own instead of the tail.',
        playlist: 'FR — organised',
        categories: 'french',
    },
    arabic: {
        title: 'Arabic — Tunisia + pan-Arab core',
        hint: 'Tunisia first, then Sport / MBC & Rotana / Info / Documentaire / Divertissement / Musique / Enfants / Religieux. No official numbering exists for pan-Arab channels, so bouquets are grouped by the provider\'s own AR| category rather than a curated list.',
        playlist: 'AR — organised',
        categories: 'arabic',
    },
};

/** Category-name patterns that mark a provider's French / Arabic sections. */
const CATEGORY_PATTERNS: Record<string, RegExp> = {
    french: /^\s*fr\s*[|\-_:]/i,
    arabic: /^\s*(ar|tn)\s*[|\-_:]/i,
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
 * been seen. The fuzzy matches start unticked — they are the only ones that can
 * be wrong in a way that looks right, and a channel is easier to add afterwards
 * than to notice on the wrong number weeks later. Any other channel can also be
 * left out here with its checkbox.
 */
export default function LiveOrganizer() {
    const toast = useToast();
    const navigate = useNavigate();

    const [subscriptions, setSubscriptions] = useState<Subscription[]>([]);
    const [categories, setCategories] = useState<Record<number, Category[]>>({});
    const [categoryFilter, setCategoryFilter] = useState<Record<number, string>>({});
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
    const [dropped, setDropped] = useState<Set<number>>(new Set());
    const [existingNames, setExistingNames] = useState<string[]>([]);
    const [playlistName, setPlaylistName] = useState('FR — organised');
    const [nameTouched, setNameTouched] = useState(false);
    const [showApplyDialog, setShowApplyDialog] = useState(false);

    // Subscriptions, profiles and the names already taken, then every
    // subscription's categories in parallel so the screen opens ready to use.
    useEffect(() => {
        (async () => {
            let subs: Subscription[] = [];
            try {
                const res = await api.get<Subscription[]>('/subscriptions');
                subs = res.data;
                setSubscriptions(subs);
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
            try {
                const res = await api.get<{ name: string }[]>('/live/playlists');
                setExistingNames(res.data.map(p => p.name.trim().toLowerCase()));
            } catch { /* only used for a warning */ }

            setLoadingCategories(true);
            await Promise.all(subs.map(async subscription => {
                try {
                    const res = await api.get<Category[]>(`/live/categories?subscription_id=${subscription.id}`);
                    setCategories(prev => ({ ...prev, [subscription.id]: res.data }));
                } catch (error) {
                    toast.apiError(`Could not load the categories of ${subscription.name}`, error);
                }
            }));
            setLoadingCategories(false);
        })();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // The suggested name follows the profile until the user types their own.
    useEffect(() => {
        if (!nameTouched) setPlaylistName(PROFILE_LABELS[profile]?.playlist ?? 'Organised playlist');
    }, [profile, nameTouched]);

    const setSelection = (subscriptionId: number, ids: string[], mode: 'replace' | 'add' | 'remove') => {
        setSelected(prev => {
            const set = new Set(mode === 'replace' ? [] : prev[subscriptionId] ?? []);
            ids.forEach(id => (mode === 'remove' ? set.delete(id) : set.add(id)));
            return { ...prev, [subscriptionId]: set };
        });
    };

    const toggleCategory = (subscriptionId: number, categoryId: string) => {
        const has = selected[subscriptionId]?.has(categoryId) ?? false;
        setSelection(subscriptionId, [categoryId], has ? 'remove' : 'add');
    };

    const visibleCategories = (subscriptionId: number) => {
        const needle = (categoryFilter[subscriptionId] ?? '').trim().toLowerCase();
        const list = categories[subscriptionId] ?? [];
        return needle ? list.filter(c => c.category_name.toLowerCase().includes(needle)) : list;
    };

    /** Replaces the selection with the categories that look like `kind`. */
    const selectByPattern = (subscriptionId: number, kind: string) => {
        const pattern = CATEGORY_PATTERNS[kind];
        const ids = (categories[subscriptionId] ?? [])
            .filter(c => pattern.test(c.category_name)).map(c => c.category_id);
        setSelection(subscriptionId, ids, 'replace');
        if (ids.length === 0) toast.info('No match', `No category of this provider looks ${kind}.`);
    };

    const selectedCount = useMemo(
        () => Object.values(selected).reduce((total, set) => total + set.size, 0),
        [selected]);

    const suggestedKind = PROFILE_LABELS[profile]?.categories ?? 'french';

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
            setDropped(new Set());
            setOpenGroups(new Set(res.data.groups.slice(0, 1).map(g => g.name)));
            toast.success('Proposal ready',
                `${res.data.stats.channels} channels in ${res.data.stats.groups} groups.`);
        } catch (error) {
            toast.apiError('Could not build the proposal', error);
        } finally {
            setComputing(false);
        }
    };

    /** A channel goes into the playlist unless it was unticked, or is an unconfirmed fuzzy match. */
    const isIncluded = (channel: PlanChannel) =>
        channel.needs_confirmation ? confirmed.has(channel.number) : !dropped.has(channel.number);

    const toggleIncluded = (channel: PlanChannel) => {
        const flip = (set: Set<number>) => {
            const next = new Set(set);
            if (next.has(channel.number)) next.delete(channel.number); else next.add(channel.number);
            return next;
        };
        if (channel.needs_confirmation) setConfirmed(flip);
        else setDropped(flip);
    };

    const channelsToApply = useMemo(() => {
        if (!plan) return [];
        return plan.groups.flatMap(group => group.channels).filter(isIncluded);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [plan, confirmed, dropped]);

    const nameTaken = existingNames.includes(playlistName.trim().toLowerCase());

    const applyPlan = async () => {
        if (!plan) return;
        setApplying(true);
        try {
            const keptGroups = new Set(channelsToApply.map(channel => channel.group));
            const res = await api.post('/organizer/apply', {
                playlist_name: playlistName.trim(),
                description: `Automatic organisation — reference ${plan.reference_version}`,
                group_order: plan.groups.map(g => g.name).filter(name => keptGroups.has(name)),
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
                `${res.data.channels} channels in ${res.data.groups} groups. Opening it in the editor.`);
            navigate(`/live-selection?playlist_id=${res.data.playlist_id}`);
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
            tvg_id: 'guide id', alias: 'name', fuzzy: `similar ${channel.match_score}`,
            none: 'by rule',
        };
        return (
            <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium whitespace-nowrap ${styles[channel.match_method]}`}>
                {labels[channel.match_method]}
            </span>
        );
    };

    const backupTitle = (channel: PlanChannel) =>
        channel.backups.map(b => `${b.provider_name}${b.quality ? ` (${b.quality})` : ''}`).join('\n');

    return (
        <div className="space-y-6 pb-28">
            <div>
                <h1 className="text-3xl font-bold flex items-center gap-2">
                    <Wand2 className="text-primary" /> Auto Organizer
                </h1>
                <p className="text-muted-foreground mt-1">
                    Matches your catalogue against a reference channel list, merges the
                    quality variants, and proposes a numbered, grouped playlist. Nothing
                    is written until you create it, and it is always a new playlist.
                </p>
            </div>

            <Card>
                <CardHeader>
                    <CardTitle className="text-lg flex items-center gap-2">
                        <Layers size={18} /> 1. Reference profile
                    </CardTitle>
                    <CardDescription>
                        The profile decides how many bouquets you get and how the catalogue is numbered.
                    </CardDescription>
                </CardHeader>
                <CardContent className="space-y-2">
                    <div className="grid gap-2 md:grid-cols-3">
                        {profiles.map(p => {
                            const meta = PROFILE_LABELS[p.name];
                            return (
                                <button key={p.name} type="button"
                                    onClick={() => setProfile(p.name)}
                                    aria-pressed={profile === p.name}
                                    className={`text-left border rounded-md p-3 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
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
                </CardContent>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle className="text-lg flex items-center gap-2">
                        <Layers size={18} /> 2. What to organise
                    </CardTitle>
                    <CardDescription>
                        Tick the categories to read. <strong>{selectedCount}</strong> selected.
                        {loadingCategories && <> Loading the catalogues…</>}
                    </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                    {subscriptions.map(subscription => {
                        const list = categories[subscription.id];
                        const shown = visibleCategories(subscription.id);
                        const count = selected[subscription.id]?.size ?? 0;
                        return (
                            <div key={subscription.id} className="border rounded-md p-3 space-y-2">
                                <div className="flex flex-wrap items-center justify-between gap-2">
                                    <span className="font-medium flex items-center gap-2">
                                        {subscription.name}
                                        <span className="text-xs font-normal px-1.5 py-0.5 rounded border text-muted-foreground">
                                            {subscription.kind === 'm3u' ? 'M3U' : 'Xtream'}
                                        </span>
                                        <span className="text-xs font-normal text-muted-foreground">
                                            {list ? `${count} of ${list.length} selected` : 'loading…'}
                                        </span>
                                    </span>
                                    {list && (
                                        <div className="flex flex-wrap gap-2">
                                            <Button size="sm"
                                                variant={suggestedKind === 'french' ? 'default' : 'outline'}
                                                onClick={() => selectByPattern(subscription.id, 'french')}
                                                title="Categories named FR| FR- FR_ FR:">
                                                Select French
                                            </Button>
                                            <Button size="sm"
                                                variant={suggestedKind === 'arabic' ? 'default' : 'outline'}
                                                onClick={() => selectByPattern(subscription.id, 'arabic')}
                                                title="Categories named AR| or TN|">
                                                Select Arabic
                                            </Button>
                                            <Button size="sm" variant="outline"
                                                onClick={() => setSelection(subscription.id, shown.map(c => c.category_id), 'add')}>
                                                Tick shown
                                            </Button>
                                            <Button size="sm" variant="outline"
                                                disabled={count === 0}
                                                onClick={() => setSelection(subscription.id, [], 'replace')}>
                                                Clear
                                            </Button>
                                        </div>
                                    )}
                                </div>
                                {list && (
                                    <>
                                        <div className="relative">
                                            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground pointer-events-none" />
                                            <Input
                                                className="pl-9 h-9"
                                                placeholder={`Filter the ${list.length} categories…`}
                                                value={categoryFilter[subscription.id] ?? ''}
                                                onChange={e => setCategoryFilter(prev => ({ ...prev, [subscription.id]: e.target.value }))}
                                            />
                                        </div>
                                        <div className="max-h-64 overflow-y-auto grid grid-cols-1 md:grid-cols-2 gap-1">
                                            {shown.map(category => (
                                                <label key={category.category_id}
                                                    className="flex items-center gap-2 text-sm px-2 py-1 rounded hover:bg-accent cursor-pointer">
                                                    <Checkbox
                                                        checked={selected[subscription.id]?.has(category.category_id) ?? false}
                                                        onCheckedChange={() => toggleCategory(subscription.id, category.category_id)}
                                                    />
                                                    <span className="truncate" title={category.category_name}>{category.category_name}</span>
                                                </label>
                                            ))}
                                            {shown.length === 0 && (
                                                <p className="text-sm text-muted-foreground italic px-2 py-1">No category matches.</p>
                                            )}
                                        </div>
                                    </>
                                )}
                            </div>
                        );
                    })}
                </CardContent>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle className="text-lg">3. How to merge</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                    <div className="space-y-1">
                        <Label>Which variant to keep when a channel comes in several qualities</Label>
                        <div className="flex flex-wrap gap-2">
                            {Object.keys(QUALITY_PRESETS).map(preset => (
                                <Button key={preset} size="sm"
                                    variant={qualityPreset === preset ? 'default' : 'outline'}
                                    onClick={() => setQualityPreset(preset)}>
                                    {preset}
                                </Button>
                            ))}
                        </div>
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
                    {selectedCount === 0 && (
                        <p className="text-xs text-muted-foreground">Tick at least one category in step 2 first.</p>
                    )}
                </CardContent>
            </Card>

            {plan && (
                <>
                    <Card>
                        <CardHeader>
                            <CardTitle className="text-lg flex items-center gap-2">
                                <ListOrdered size={18} /> 4. The proposal
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
                                    ['With a guide', plan.stats.with_guide, CheckCircle2],
                                    ['Backups kept', plan.stats.backups, Layers],
                                    ['Identified by guide id', plan.stats.matched_by_tvg_id, CheckCircle2],
                                    ['Identified by name', plan.stats.matched_by_alias, CheckCircle2],
                                    ['Similar names to confirm', plan.stats.to_confirm, AlertTriangle],
                                    ['Placed by a group rule', plan.stats.placed_by_family ?? 0, Layers],
                                    ['Not recognised', plan.stats.in_tail ?? plan.stats.unmatched, HelpCircle],
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
                                    <Button size="sm" variant="outline" className="ml-2 h-6 text-xs"
                                        onClick={() => setConfirmed(new Set(plan.to_confirm.map(c => c.number)))}>
                                        Tick all
                                    </Button>
                                    <Button size="sm" variant="outline" className="ml-1 h-6 text-xs"
                                        onClick={() => setConfirmed(new Set())}>
                                        Untick all
                                    </Button>
                                </CardDescription>
                            </CardHeader>
                            <CardContent className="space-y-1">
                                {plan.to_confirm.map(channel => (
                                    <label key={channel.number}
                                        className="flex items-center gap-3 text-sm px-2 py-1.5 rounded hover:bg-accent cursor-pointer">
                                        <Checkbox
                                            checked={confirmed.has(channel.number)}
                                            onCheckedChange={() => toggleIncluded(channel)}
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
                            <CardDescription>
                                Untick a channel to leave it out. You can still edit everything afterwards
                                in the playlist editor.
                            </CardDescription>
                        </CardHeader>
                        <CardContent className="space-y-2">
                            {plan.groups.map(group => {
                                const included = group.channels.filter(isIncluded).length;
                                const open = openGroups.has(group.name);
                                return (
                                    <div key={group.name} className="border rounded-md">
                                        <button
                                            onClick={() => toggleGroup(group.name)}
                                            aria-expanded={open}
                                            className="w-full flex items-center justify-between px-3 py-2 hover:bg-accent rounded-md">
                                            <span className="flex items-center gap-2 font-medium">
                                                {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                                                {group.name}
                                            </span>
                                            <span className="text-sm text-muted-foreground">
                                                {included === group.channels.length
                                                    ? group.channels.length
                                                    : `${included} of ${group.channels.length}`}
                                            </span>
                                        </button>
                                        {open && (
                                            <div className="border-t divide-y">
                                                {group.channels.map(channel => {
                                                    const inPlaylist = isIncluded(channel);
                                                    return (
                                                        <label key={`${channel.number}-${channel.stream.stream_id}`}
                                                            className={`flex items-center gap-3 px-3 py-1.5 text-sm cursor-pointer hover:bg-accent/50 ${inPlaylist ? '' : 'opacity-50'}`}>
                                                            <Checkbox
                                                                checked={inPlaylist}
                                                                onCheckedChange={() => toggleIncluded(channel)}
                                                            />
                                                            <span className="font-mono text-xs text-muted-foreground w-12">
                                                                {channel.number}
                                                            </span>
                                                            <span className={`flex-1 truncate ${inPlaylist ? '' : 'line-through'}`}>{channel.name}</span>
                                                            {channel.needs_confirmation && (
                                                                <span className="text-[10px] text-amber-600 whitespace-nowrap">to confirm</span>
                                                            )}
                                                            {!channel.has_guide && (
                                                                <span className="text-[10px] text-muted-foreground whitespace-nowrap">no guide</span>
                                                            )}
                                                            {channel.backups.length > 0 && (
                                                                <span className="text-[10px] text-muted-foreground whitespace-nowrap"
                                                                    title={backupTitle(channel)}>
                                                                    +{channel.backups.length} alt
                                                                </span>
                                                            )}
                                                            <span className="text-xs text-muted-foreground truncate max-w-[16rem]">
                                                                {channel.stream.provider_name}
                                                            </span>
                                                            {methodBadge(channel)}
                                                        </label>
                                                    );
                                                })}
                                            </div>
                                        )}
                                    </div>
                                );
                            })}
                        </CardContent>
                    </Card>

                    {/* Always in reach: the list above can be hundreds of rows long. */}
                    <div className="fixed bottom-0 left-0 right-0 lg:left-64 z-30 border-t bg-card/95 backdrop-blur shadow-lg">
                        <div className="max-w-6xl mx-auto px-4 py-3 flex flex-wrap items-end gap-3">
                            <div className="flex-1 min-w-[14rem]">
                                <Label htmlFor="playlist-name" className="text-xs">New playlist name</Label>
                                <Input id="playlist-name" value={playlistName}
                                    onChange={e => { setPlaylistName(e.target.value); setNameTouched(true); }} />
                                {nameTaken && (
                                    <p className="text-[11px] text-amber-600 mt-0.5">
                                        A playlist with this name already exists; pick another to tell them apart.
                                    </p>
                                )}
                            </div>
                            <Button onClick={() => setShowApplyDialog(true)}
                                disabled={applying || !playlistName.trim() || channelsToApply.length === 0}>
                                {applying
                                    ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Creating…</>
                                    : <>Create playlist with {channelsToApply.length} channels</>}
                            </Button>
                        </div>
                    </div>
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
                    new playlist named <strong>{playlistName}</strong>, then opened in the editor.
                </p>
                <p className="text-muted-foreground">
                    Your existing playlists are not modified. Delete this one if the result
                    does not suit you.
                </p>
            </ConfirmDialog>
        </div>
    );
}
