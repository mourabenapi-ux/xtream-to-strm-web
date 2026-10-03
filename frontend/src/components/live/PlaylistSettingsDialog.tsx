import { FC, useEffect, useState } from 'react';
import { copyText, getPublicBase } from '@/lib/home';
import { Dialog } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Copy } from 'lucide-react';
import { useToast } from '@/contexts/ToastContext';
import { useLiveSelection } from '@/contexts/LiveSelectionContext';

/** The URLs a player needs, short form first: they are typed with a remote. */
export const playerUrls = (playlist: { public_id: string | null; short_name?: string | null; id: number }) => {
    const origin = getPublicBase();
    const key = playlist.short_name || playlist.public_id || String(playlist.id);
    return {
        m3u: `${origin}/p/${key}.m3u`,
        xml: `${origin}/p/${key}.xml`,
        longM3u: `${origin}/api/v1/live/playlist.m3u?playlist_id=${playlist.public_id}`,
        longXml: `${origin}/api/v1/live/playlist.xml?playlist_id=${playlist.public_id}`,
    };
};

export const PlaylistSettingsDialog: FC<{ isOpen: boolean; onClose: () => void }> = ({ isOpen, onClose }) => {
    const toast = useToast();
    const { playlist, updatePlaylistMeta } = useLiveSelection();
    const [name, setName] = useState('');
    const [description, setDescription] = useState('');
    const [shortName, setShortName] = useState('');
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        if (!isOpen || !playlist) return;
        setName(playlist.name);
        setDescription(playlist.description ?? '');
        setShortName(playlist.short_name ?? '');
    }, [isOpen, playlist]);

    if (!playlist) return null;
    const urls = playerUrls({ ...playlist, short_name: shortName.trim().toLowerCase() || null });
    const copy = async (text: string) => { (await copyText(text)) ? toast.success('Copied', text) : toast.error('Could not copy', 'Select the address and copy it by hand.'); };

    const save = async () => {
        setBusy(true);
        const ok = await updatePlaylistMeta({ name: name.trim() || playlist.name, description: description.trim() || null, short_name: shortName.trim() || null });
        setBusy(false);
        if (ok) { toast.success('Playlist saved'); onClose(); }
    };

    const row = (label: string, value: string) => (
        <div className="flex items-center gap-2">
            <span className="w-20 text-xs text-muted-foreground">{label}</span>
            <code className="flex-1 truncate text-xs bg-muted rounded px-2 py-1" title={value}>{value}</code>
            <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => copy(value)} aria-label={`Copy ${label}`}><Copy className="h-3.5 w-3.5" /></Button>
        </div>
    );

    return (
        <Dialog isOpen={isOpen} onClose={onClose} title="Playlist settings" size="lg">
            <div className="space-y-4 text-sm">
                <div className="grid gap-3 md:grid-cols-2">
                    <div className="space-y-1"><Label htmlFor="pl-name">Name</Label><Input id="pl-name" value={name} onChange={e => setName(e.target.value)} /></div>
                    <div className="space-y-1"><Label htmlFor="pl-desc">Description</Label><Input id="pl-desc" value={description} onChange={e => setDescription(e.target.value)} /></div>
                </div>
                <div className="space-y-1">
                    <Label htmlFor="pl-short">Short name for the player URLs</Label>
                    <div className="flex items-center gap-2">
                        <span className="text-xs text-muted-foreground">{window.location.origin}/p/</span>
                        <Input id="pl-short" className="w-40" placeholder={playlist.public_id ?? ''} value={shortName}
                            onChange={e => setShortName(e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, ''))} maxLength={20} />
                        <span className="text-xs text-muted-foreground">.m3u</span>
                    </div>
                    <p className="text-[11px] text-muted-foreground">
                        Letters, digits, - and _. These short URLs are easier to type with a TV remote. The long URLs keep working, and so do the
                        URLs already in TiviMate.
                    </p>
                </div>
                <div className="space-y-1.5 border rounded-md p-3">
                    <div className="text-xs font-semibold">Paste these into TiviMate</div>
                    {row('Playlist', urls.m3u)}
                    {row('Guide', urls.xml)}
                    <details className="text-xs">
                        <summary className="cursor-pointer text-muted-foreground">Long URLs</summary>
                        <div className="space-y-1.5 pt-1.5">{row('Playlist', urls.longM3u)}{row('Guide', urls.longXml)}</div>
                    </details>
                </div>
                <div className="flex justify-end gap-2 border-t pt-3">
                    <Button variant="ghost" onClick={onClose}>Cancel</Button>
                    <Button onClick={save} disabled={busy}>Save</Button>
                </div>
            </div>
        </Dialog>
    );
};
