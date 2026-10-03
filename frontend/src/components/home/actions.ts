import { useCallback, useState } from 'react';
import api from '@/lib/api';
import { useToast } from '@/contexts/ToastContext';
import type { ActionSpec } from '@/lib/home';

/**
 * Runs the one-click fixes the dashboard offers. Each one calls a tool the
 * playlist editor already has, so a fix made here is the same fix made there
 * (and the editor saves a restorable version before it rewrites anything).
 *
 * `onDone` is called after the call, so the page can ask for a fresh look.
 */
export function useActionRunner(onDone: () => void) {
    const toast = useToast();
    const [running, setRunning] = useState<string | null>(null);

    const run = useCallback(async (action: ActionSpec, id: string) => {
        setRunning(id);
        try {
            switch (action.kind) {
                case 'repair_dead': {
                    const res = await api.post(`/live/playlists/${action.playlist_id}/channels/repair-dead`);
                    const repaired = res.data.repaired?.length ?? 0;
                    const left = res.data.unresolved?.length ?? 0;
                    if (repaired) toast.success(`${repaired} channel${repaired > 1 ? 's' : ''} repaired`,
                        left ? `${left} could not be matched. The playlist was saved as a version first.` : 'The playlist was saved as a version first.');
                    else toast.warning('Nothing to repair with', 'No replacement was found at any provider.');
                    break;
                }
                case 'fix_numbering': {
                    const res = await api.post(`/live/playlists/${action.playlist_id}/numbering/fix`, {});
                    toast.success('Numbering fixed', `${res.data.changed} channel number${res.data.changed === 1 ? '' : 's'} changed. The playlist was saved as a version first.`);
                    break;
                }
                case 'sync': {
                    const kinds = action.type === 'all' || !action.type ? ['movies', 'series'] : [action.type];
                    await Promise.all(kinds.map(k => api.post(`/sync/${k}/${action.subscription_id}`)));
                    toast.info('Sync started', 'Progress shows under Activity.');
                    break;
                }
                case 'refresh_guide':
                    await api.post(`/epg-sources/${action.source_id}/refresh`);
                    toast.info('Guide refresh started', 'A large guide takes about half a minute.');
                    break;
                case 'jellyfin_scan':
                    await api.post('/dashboard/jellyfin/scan');
                    toast.info('Jellyfin is scanning its libraries');
                    break;
            }
        } catch (err) {
            toast.apiError(`${action.label} failed`, err);
        } finally {
            setRunning(null);
            onDone();
        }
    }, [toast, onDone]);

    return { run, running };
}
