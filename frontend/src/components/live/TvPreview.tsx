import { FC, useEffect, useMemo, useRef, useState } from 'react';
import { X, Radio } from 'lucide-react';
import { useLiveSelection, PlaylistChannel } from '@/contexts/LiveSelectionContext';

const time = (seconds?: number | null) =>
    seconds ? new Date(seconds * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';

/**
 * The playlist as a TV player shows it: the groups in published order, the
 * channels with their numbers and logos, what is on now and next. Only what
 * the player really receives — hidden and dead channels are left out, exactly
 * as in the M3U. Arrow keys move like a remote, Esc closes.
 */
export const TvPreview: FC<{ isOpen: boolean; onClose: () => void }> = ({ isOpen, onClose }) => {
    const { playlist, bouquetLabel, channelLabel, effectiveOf, useChannelNumbers } = useLiveSelection();
    const [groupIndex, setGroupIndex] = useState(0);
    const [channelIndex, setChannelIndex] = useState(0);
    const listRef = useRef<HTMLDivElement>(null);

    const groups = useMemo(() => (playlist?.bouquets ?? [])
        .map(b => ({
            id: b.id,
            name: bouquetLabel(b),
            channels: b.channels
                .filter(c => !c.is_excluded && effectiveOf(c.id)?.served !== false)
                .sort((x, y) => x.order - y.order),
        }))
        .filter(g => g.channels.length > 0), [playlist, bouquetLabel, effectiveOf]);

    const group = groups[Math.min(groupIndex, groups.length - 1)];
    const channel: PlaylistChannel | undefined = group?.channels[Math.min(channelIndex, group.channels.length - 1)];
    const info = channel ? effectiveOf(channel.id) : undefined;

    useEffect(() => { if (isOpen) { setGroupIndex(0); setChannelIndex(0); } }, [isOpen]);
    useEffect(() => { setChannelIndex(0); }, [groupIndex]);
    useEffect(() => {
        listRef.current?.querySelector(`[data-ch="${channelIndex}"]`)?.scrollIntoView({ block: 'nearest' });
    }, [channelIndex, groupIndex]);

    useEffect(() => {
        if (!isOpen) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') { e.preventDefault(); onClose(); }
            else if (e.key === 'ArrowDown') { e.preventDefault(); setChannelIndex(i => Math.min(i + 1, (group?.channels.length ?? 1) - 1)); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setChannelIndex(i => Math.max(i - 1, 0)); }
            else if (e.key === 'ArrowRight') { e.preventDefault(); setGroupIndex(i => Math.min(i + 1, groups.length - 1)); }
            else if (e.key === 'ArrowLeft') { e.preventDefault(); setGroupIndex(i => Math.max(i - 1, 0)); }
        };
        window.addEventListener('keydown', onKey, true);
        return () => window.removeEventListener('keydown', onKey, true);
    }, [isOpen, group, groups.length, onClose]);

    if (!isOpen) return null;
    const now = Date.now() / 1000;
    const progress = (start?: number | null, stop?: number | null) =>
        start && stop && stop > start ? Math.min(100, Math.max(0, ((now - start) / (stop - start)) * 100)) : 0;

    return (
        <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-2 sm:p-4" role="dialog" aria-label="Preview as on the TV">
            <div className="w-full max-w-6xl h-full sm:h-[85vh] bg-[#0f1419] text-slate-100 rounded-xl shadow-2xl flex flex-col overflow-hidden border border-slate-700">
                <div className="flex items-center justify-between gap-2 px-3 sm:px-5 py-3 border-b border-slate-700/70">
                    <div className="min-w-0">
                        <div className="font-semibold">{playlist?.name}</div>
                        <div className="text-[11px] text-slate-400">As your player receives it<span className="hidden sm:inline"> · ← → groups · ↑ ↓ channels · Esc to close</span></div>
                    </div>
                    <button type="button" onClick={onClose} className="p-1.5 rounded hover:bg-slate-700" aria-label="Close"><X className="h-5 w-5" /></button>
                </div>
                {groups.length === 0 ? (
                    <div className="flex-1 flex items-center justify-center text-slate-400">This playlist serves no channel.</div>
                ) : (
                    <div className="flex-1 flex min-h-0">
                        <div className="w-32 sm:w-56 flex-shrink-0 border-r border-slate-700/70 overflow-y-auto">
                            {groups.map((g, i) => (
                                <button key={g.id} type="button" onClick={() => setGroupIndex(i)}
                                    className={`w-full text-left px-2 sm:px-4 py-2.5 text-xs sm:text-sm flex justify-between gap-2 ${i === groupIndex ? 'bg-sky-600 text-white' : 'hover:bg-slate-800 text-slate-300'}`}>
                                    <span className="truncate">{g.name}</span><span className="opacity-70">{g.channels.length}</span>
                                </button>
                            ))}
                        </div>
                        <div ref={listRef} className="flex-1 overflow-y-auto">
                            {group?.channels.map((c, i) => {
                                const e = effectiveOf(c.id);
                                return (
                                    <button key={c.id} data-ch={i} type="button" onClick={() => setChannelIndex(i)}
                                        className={`w-full flex items-center gap-2 sm:gap-3 px-2 sm:px-4 py-2 text-left ${i === channelIndex ? 'bg-slate-700/80' : 'hover:bg-slate-800/70'}`}>
                                        {useChannelNumbers && <span className="w-8 sm:w-12 flex-shrink-0 text-right text-slate-400 font-mono text-xs sm:text-sm">{c.order}</span>}
                                        <span className="w-10 h-7 flex-shrink-0 flex items-center justify-center bg-slate-800 rounded overflow-hidden">
                                            {e?.logo ? <img src={e.logo} alt="" className="max-h-full max-w-full object-contain" loading="lazy" /> : <Radio className="h-4 w-4 text-slate-500" />}
                                        </span>
                                        <span className="flex-1 min-w-0">
                                            <span className="block truncate text-sm font-medium">{channelLabel(c)}</span>
                                            <span className="block truncate text-xs text-slate-400">{e?.now ?? (e?.guide === 'live' ? '' : 'No information')}</span>
                                            {e?.now && <span className="block h-0.5 mt-1 bg-slate-700 rounded"><span className="block h-full bg-sky-500 rounded" style={{ width: `${progress(e.now_start, e.now_stop)}%` }} /></span>}
                                        </span>
                                    </button>
                                );
                            })}
                        </div>
                        <div className="w-80 border-l border-slate-700/70 p-5 space-y-4 hidden lg:block">
                            {channel && (
                                <>
                                    <div className="h-24 flex items-center justify-center bg-slate-800 rounded-lg">
                                        {info?.logo ? <img src={info.logo} alt="" className="max-h-20 max-w-[80%] object-contain" /> : <Radio className="h-8 w-8 text-slate-500" />}
                                    </div>
                                    <div className="text-lg font-semibold">{useChannelNumbers ? `${channel.order} · ` : ''}{channelLabel(channel)}</div>
                                    <div className="space-y-1">
                                        <div className="text-[11px] uppercase tracking-wider text-slate-400">Now {info?.now_start ? `· ${time(info.now_start)}–${time(info.now_stop)}` : ''}</div>
                                        <div className="text-sm">{info?.now ?? 'No programme information'}</div>
                                        {info?.now && <div className="h-1 bg-slate-700 rounded"><div className="h-full bg-sky-500 rounded" style={{ width: `${progress(info.now_start, info.now_stop)}%` }} /></div>}
                                    </div>
                                    <div className="space-y-1">
                                        <div className="text-[11px] uppercase tracking-wider text-slate-400">Next {info?.next_start ? `· ${time(info.next_start)}` : ''}</div>
                                        <div className="text-sm text-slate-300">{info?.next ?? '—'}</div>
                                    </div>
                                    <div className="text-[11px] text-slate-500 font-mono break-all">{info?.epg_id ? `tvg-id ${info.epg_id}` : 'no tvg-id'}</div>
                                </>
                            )}
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
};
