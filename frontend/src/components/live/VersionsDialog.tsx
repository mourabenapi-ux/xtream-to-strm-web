import { FC, useEffect, useState } from 'react';
import { Dialog } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Loader2, History, Trash2, Save, Bot } from 'lucide-react';
import api from '@/lib/api';
import { useToast } from '@/contexts/ToastContext';
import { useLiveSelection } from '@/contexts/LiveSelectionContext';

interface Version { id: number; name: string; automatic: boolean; created_at: string; channel_count: number }

/**
 * Named, restorable copies of the playlist. Unlike Ctrl+Z they survive a
 * reload and last forever. The editor also keeps one by itself before every
 * tool that renumbers or repairs many channels (the last 20 are kept).
 */
export const VersionsDialog: FC<{ isOpen: boolean; onClose: () => void }> = ({ isOpen, onClose }) => {
    const toast = useToast();
    const { playlist, reloadPlaylist } = useLiveSelection();
    const [versions, setVersions] = useState<Version[] | null>(null);
    const [name, setName] = useState('');
    const [toRestore, setToRestore] = useState<Version | null>(null);
    const [busy, setBusy] = useState(false);

    const load = async () => {
        if (!playlist) return;
        try {
            setVersions((await api.get<Version[]>(`/live/playlists/${playlist.id}/versions`)).data);
        } catch (error) {
            toast.apiError('Could not list the versions', error);
        }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    useEffect(() => { if (isOpen) { load(); setName(''); } }, [isOpen]);

    const save = async () => {
        if (!playlist || !name.trim()) return;
        setBusy(true);
        try {
            await api.post(`/live/playlists/${playlist.id}/versions`, { name: name.trim() });
            toast.success('Version saved', name.trim());
            setName('');
            load();
        } catch (error) {
            toast.apiError('Could not save the version', error);
        } finally {
            setBusy(false);
        }
    };

    const restore = async (version: Version) => {
        if (!playlist) return;
        setBusy(true);
        try {
            await api.post(`/live/playlists/${playlist.id}/versions/${version.id}/restore`);
            await reloadPlaylist();
            toast.success(`“${version.name}” restored`, 'The state before it was saved as a version, so this can be undone the same way.');
            onClose();
        } catch (error) {
            toast.apiError('Could not restore the version', error);
        } finally {
            setBusy(false);
            setToRestore(null);
        }
    };

    const remove = async (version: Version) => {
        if (!playlist) return;
        await api.delete(`/live/playlists/${playlist.id}/versions/${version.id}`).catch(e => toast.apiError('Could not delete', e));
        load();
    };

    return (
        <>
            <Dialog isOpen={isOpen} onClose={onClose} title="Versions" size="lg">
                <div className="space-y-3 text-sm">
                    <div className="flex gap-2">
                        <Input placeholder="Name of the current state, e.g. “Before the World Cup”" value={name}
                            onChange={e => setName(e.target.value)} onKeyDown={e => e.key === 'Enter' && save()} />
                        <Button onClick={save} disabled={busy || !name.trim()} className="gap-1.5"><Save className="h-4 w-4" /> Save</Button>
                    </div>
                    <p className="text-[11px] text-muted-foreground">
                        Versions survive a reload, unlike Ctrl+Z. A version is also saved automatically before each repair or renumbering tool.
                    </p>
                    {versions === null ? (
                        <div className="py-8 flex justify-center"><Loader2 className="h-5 w-5 animate-spin" /></div>
                    ) : versions.length === 0 ? (
                        <p className="py-6 text-center text-muted-foreground text-xs">No version yet.</p>
                    ) : (
                        <div className="divide-y border rounded max-h-[50vh] overflow-y-auto">
                            {versions.map(v => (
                                <div key={v.id} className="flex items-center gap-2 p-2">
                                    {v.automatic ? <Bot className="h-4 w-4 text-muted-foreground" /> : <History className="h-4 w-4 text-primary" />}
                                    <div className="flex-1 min-w-0">
                                        <div className="truncate font-medium">{v.name}</div>
                                        <div className="text-[11px] text-muted-foreground">
                                            {new Date(v.created_at + 'Z').toLocaleString()} · {v.channel_count} channels{v.automatic ? ' · automatic' : ''}
                                        </div>
                                    </div>
                                    <Button size="sm" variant="outline" className="h-7 text-xs" disabled={busy} onClick={() => setToRestore(v)}>Restore</Button>
                                    <Button size="icon" variant="ghost" className="h-7 w-7 text-destructive" onClick={() => remove(v)} title="Delete this version" aria-label={`Delete ${v.name}`}>
                                        <Trash2 className="h-3.5 w-3.5" />
                                    </Button>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            </Dialog>
            <ConfirmDialog
                isOpen={!!toRestore}
                onClose={() => setToRestore(null)}
                onConfirm={() => { if (toRestore) restore(toRestore); }}
                title="Restore this version"
                confirmLabel="Restore"
                busy={busy}
            >
                <p>Put the playlist back as it was in <strong>{toRestore?.name}</strong> ({toRestore?.channel_count} channels)?</p>
                <p className="text-muted-foreground">The current state is saved as a version first. The player URLs do not change.</p>
            </ConfirmDialog>
        </>
    );
};
