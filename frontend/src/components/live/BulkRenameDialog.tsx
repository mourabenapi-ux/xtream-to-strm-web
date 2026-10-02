import { FC, useMemo, useState, useEffect } from 'react';
import { Dialog } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useToast } from '@/contexts/ToastContext';
import { useLiveSelection, PlaylistChannel } from '@/contexts/LiveSelectionContext';

type Scope = 'selection' | 'group' | 'playlist';
type CaseMode = 'keep' | 'title' | 'upper';

interface Rules {
    fromProvider: boolean;
    prefix: boolean;
    quality: boolean;
    brackets: boolean;
    noise: boolean;
    decorations: boolean;
    caseMode: CaseMode;
    find: string;
    replace: string;
    regex: boolean;
}

const PREFIX = /^\s*[^|:]{1,8}?\s*[|:]\s*/;
const QUALITY = /(^|[\s_-])(uhd|fhd|hd|sd|lq|hq|4k|8k|hevc|h\.?265|h\.?264|raw|\d{3,4}[pi])(?=$|[\s_-])/gi;
const BRACKETS = /\s*[[(][^\])]*[\])]/g;
const NOISE = /\b(not\s*24\s*\/?\s*7|geo[\s-]?blocked)\b/gi;

const titleCase = (text: string) => text.split(' ').map(word => {
    if (!word) return word;
    const letters = word.replace(/[^\p{L}]/gu, '');
    // Short capitals are acronyms (TF1, BFM, RMC): left alone.
    if (letters.length <= 4 && letters === letters.toUpperCase()) return word;
    if (letters === letters.toUpperCase() || letters === letters.toLowerCase()) {
        return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    }
    return word;
}).join(' ');

export const applyRules = (input: string, rules: Rules): string => {
    let text = input.normalize('NFKC');
    if (rules.prefix) {
        for (let i = 0; i < 3 && PREFIX.test(text); i++) text = text.replace(PREFIX, '');
    }
    if (rules.brackets) text = text.replace(BRACKETS, ' ');
    if (rules.noise) text = text.replace(NOISE, ' ');
    if (rules.quality) text = text.replace(QUALITY, '$1');
    if (rules.decorations) text = text.replace(/[^\p{L}\p{N}\s+&'.!?-]/gu, ' ');
    if (rules.find) {
        try {
            text = rules.regex
                ? text.replace(new RegExp(rules.find, 'gi'), rules.replace)
                : text.split(rules.find).join(rules.replace);
        } catch { /* an invalid regex changes nothing */ }
    }
    text = text.replace(/\s+/g, ' ').replace(/^[\s\-_|:]+|[\s\-_|:]+$/g, '').trim();
    if (rules.caseMode === 'title') text = titleCase(text);
    if (rules.caseMode === 'upper') text = text.toUpperCase();
    return text;
};

/**
 * Renames many channels at once with rules, previewed before anything is
 * written: the provider's "FR| M6 HD (1080p)" or "Baraka Television Not 24 7"
 * become "M6" and "Baraka Television". Ctrl+Z undoes it.
 */
export const BulkRenameDialog: FC<{ isOpen: boolean; onClose: () => void }> = ({ isOpen, onClose }) => {
    const toast = useToast();
    const { playlist, selectedBouquetId, selectedChannelIds, channelLabel, sourceNames, bulkRename, bouquetLabel } = useLiveSelection();
    const [scope, setScope] = useState<Scope>('group');
    const [rules, setRules] = useState<Rules>({
        fromProvider: false, prefix: true, quality: true, brackets: true, noise: true, decorations: true,
        caseMode: 'keep', find: '', replace: '', regex: false,
    });

    useEffect(() => {
        if (isOpen) setScope(selectedChannelIds.size > 0 ? 'selection' : 'group');
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isOpen]);

    const channels: PlaylistChannel[] = useMemo(() => {
        if (!playlist) return [];
        if (scope === 'selection') return playlist.bouquets.flatMap(b => b.channels).filter(c => selectedChannelIds.has(c.id));
        if (scope === 'group') return playlist.bouquets.find(b => b.id === selectedBouquetId)?.channels ?? [];
        return playlist.bouquets.flatMap(b => b.channels);
    }, [playlist, scope, selectedChannelIds, selectedBouquetId]);

    const changes = useMemo(() => channels.map(c => {
        const before = channelLabel(c);
        const base = rules.fromProvider ? (sourceNames[String(c.id)] || before) : before;
        const after = applyRules(base, rules) || before;
        return { id: c.id, before, after };
    }).filter(x => x.after !== x.before), [channels, rules, channelLabel, sourceNames]);

    const set = <K extends keyof Rules>(key: K, value: Rules[K]) => setRules(prev => ({ ...prev, [key]: value }));
    const box = (key: keyof Rules, label: string, hint: string) => (
        <label className="flex items-start gap-2 text-sm cursor-pointer" title={hint}>
            <input type="checkbox" className="mt-1" checked={rules[key] as boolean} onChange={e => set(key, e.target.checked as any)} />
            <span>{label}<span className="block text-[11px] text-muted-foreground">{hint}</span></span>
        </label>
    );

    const group = playlist?.bouquets.find(b => b.id === selectedBouquetId);

    return (
        <Dialog isOpen={isOpen} onClose={onClose} title="Rename channels by rules" size="xl">
            <div className="grid gap-4 md:grid-cols-[18rem_1fr] text-sm">
                <div className="space-y-3">
                    <div className="space-y-1">
                        <div className="text-xs font-semibold">Which channels</div>
                        {([
                            ['selection', `The selection (${selectedChannelIds.size})`, selectedChannelIds.size === 0],
                            ['group', `This group${group ? ` — ${bouquetLabel(group)}` : ''}`, !group],
                            ['playlist', 'The whole playlist', false],
                        ] as const).map(([value, label, disabled]) => (
                            <label key={value} className={`flex items-center gap-2 ${disabled ? 'opacity-40' : 'cursor-pointer'}`}>
                                <input type="radio" name="rename-scope" disabled={disabled} checked={scope === value} onChange={() => setScope(value)} />
                                {label}
                            </label>
                        ))}
                    </div>
                    <div className="space-y-2 border-t pt-3">
                        {box('fromProvider', 'Start from the provider\'s name', 'Ignore earlier renames')}
                        {box('prefix', 'Remove the prefix', '"FR| TF1" → "TF1"')}
                        {box('quality', 'Remove quality tags', 'HD, FHD, 4K, 1080p, HEVC…')}
                        {box('brackets', 'Remove (…) and […]', '"(1080p)", "[Geo-blocked]"')}
                        {box('noise', 'Remove notices', '"Not 24/7", "Geo-blocked"')}
                        {box('decorations', 'Remove symbols', '◉ ⚽ ★ and superscripts')}
                    </div>
                    <div className="space-y-1 border-t pt-3">
                        <div className="text-xs font-semibold">Case</div>
                        <select className="w-full border rounded p-1.5 bg-background" value={rules.caseMode} onChange={e => set('caseMode', e.target.value as CaseMode)}>
                            <option value="keep">Unchanged</option>
                            <option value="title">Capitalised words (acronyms kept: TF1, BFM)</option>
                            <option value="upper">UPPERCASE</option>
                        </select>
                    </div>
                    <div className="space-y-1 border-t pt-3">
                        <div className="text-xs font-semibold">Find and replace</div>
                        <Input placeholder="find" value={rules.find} onChange={e => set('find', e.target.value)} />
                        <Input placeholder="replace with" value={rules.replace} onChange={e => set('replace', e.target.value)} />
                        <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={rules.regex} onChange={e => set('regex', e.target.checked)} /> Regular expression</label>
                    </div>
                </div>
                <div className="flex flex-col min-h-0">
                    <div className="text-xs text-muted-foreground mb-1">
                        <strong className="text-foreground">{changes.length}</strong> of {channels.length} channel(s) would change.
                    </div>
                    <div className="flex-1 max-h-[55vh] overflow-y-auto border rounded divide-y">
                        {changes.slice(0, 300).map(x => (
                            <div key={x.id} className="grid grid-cols-2 gap-2 px-2 py-1 text-xs">
                                <span className="truncate text-muted-foreground line-through" title={x.before}>{x.before}</span>
                                <span className="truncate font-medium" title={x.after}>{x.after}</span>
                            </div>
                        ))}
                        {changes.length === 0 && <p className="p-6 text-center text-muted-foreground text-xs">Nothing to change with these rules.</p>}
                    </div>
                    <div className="flex justify-end gap-2 pt-3">
                        <Button variant="ghost" onClick={onClose}>Cancel</Button>
                        <Button disabled={changes.length === 0} onClick={async () => {
                            await bulkRename(new Map(changes.map(x => [x.id, x.after])));
                            toast.success(`${changes.length} channel(s) renamed`, 'Ctrl+Z undoes it.');
                            onClose();
                        }}>Rename {changes.length}</Button>
                    </div>
                </div>
            </div>
        </Dialog>
    );
};
