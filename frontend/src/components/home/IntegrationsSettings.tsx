import { FC, useEffect, useMemo, useRef, useState } from 'react';
import { BellRing, Camera, Globe, Library, Loader2 } from 'lucide-react';
import api from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { useToast } from '@/contexts/ToastContext';
import { useUnsavedChanges } from '@/hooks/useUnsavedChanges';
import { setPublicBase } from '@/lib/home';

interface Settings {
    PUBLIC_BASE_URL: string;
    DASHBOARD_PLAYLIST_ID: string;
    TVWALL_ENABLED: string;
    JELLYFIN_URL: string;
    HAS_JELLYFIN_API_KEY: boolean;
    NOTIFY_NTFY_URL: string;
    HAS_NOTIFY_NTFY_TOKEN: boolean;
    HAS_NOTIFY_TELEGRAM_TOKEN: boolean;
    NOTIFY_TELEGRAM_CHAT_ID: string;
    NOTIFY_WEBHOOK_URL: string;
    NOTIFY_MIN_SEVERITY: string;
    NOTIFY_DOWNLOAD_DONE: string;
    playlists: { id: number; name: string }[];
}

type Form = Record<string, string>;
const TEXT_KEYS = ['PUBLIC_BASE_URL', 'DASHBOARD_PLAYLIST_ID', 'TVWALL_ENABLED', 'JELLYFIN_URL', 'NOTIFY_NTFY_URL',
    'NOTIFY_TELEGRAM_CHAT_ID', 'NOTIFY_WEBHOOK_URL', 'NOTIFY_MIN_SEVERITY', 'NOTIFY_DOWNLOAD_DONE'] as const;
const SECRET_KEYS = ['JELLYFIN_API_KEY', 'NOTIFY_NTFY_TOKEN', 'NOTIFY_TELEGRAM_TOKEN'] as const;

const select = 'flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

/** A password-like field that never receives the stored value back. */
const Secret: FC<{ label: string; isSet: boolean; value: string; onChange: (v: string) => void; hint?: string }> = ({ label, isSet, value, onChange, hint }) => (
    <div className="space-y-1.5">
        <Label>{label}</Label>
        <div className="flex gap-2">
            <Input type="password" autoComplete="off" value={value === 'CLEAR' ? '' : value}
                placeholder={value === 'CLEAR' ? 'Will be removed on save' : isSet ? 'Saved. Type to replace it.' : ''}
                onChange={e => onChange(e.target.value)} />
            {isSet && value !== 'CLEAR' && <Button type="button" variant="outline" onClick={() => onChange('CLEAR')}>Remove</Button>}
        </div>
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
);

export const IntegrationsSettings: FC = () => {
    const toast = useToast();
    const [loaded, setLoaded] = useState<Settings | null>(null);
    const [form, setForm] = useState<Form>({});
    const [busy, setBusy] = useState<string | null>(null);
    const root = useRef<HTMLElement>(null);

    const load = async () => {
        const res = await api.get<Settings>('/dashboard/settings');
        setLoaded(res.data);
        const next: Form = {};
        TEXT_KEYS.forEach(k => { next[k] = String(res.data[k] ?? ''); });
        SECRET_KEYS.forEach(k => { next[k] = ''; });
        setForm(next);
        setPublicBase(res.data.PUBLIC_BASE_URL);
    };

    useEffect(() => {
        load().catch(err => toast.apiError('Could not load the integrations', err));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
        if (loaded && window.location.hash === '#integrations') root.current?.scrollIntoView({ block: 'start' });
    }, [loaded]);

    const changes = useMemo(() => {
        if (!loaded) return {} as Form;
        const out: Form = {};
        TEXT_KEYS.forEach(k => { if ((form[k] ?? '') !== String(loaded[k] ?? '')) out[k] = form[k] ?? ''; });
        SECRET_KEYS.forEach(k => { if (form[k]) out[k] = form[k]; });
        return out;
    }, [form, loaded]);
    const dirty = Object.keys(changes).length > 0;
    useUnsavedChanges(dirty);

    const set = (key: string) => (value: string) => setForm(f => ({ ...f, [key]: value }));
    const flag = (key: string) => form[key] === 'true';

    const save = async () => {
        setBusy('save');
        try {
            await api.put('/dashboard/settings', changes);
            await load();
            toast.success('Integrations saved');
        } catch (err) {
            toast.apiError('Could not save', err);
        } finally {
            setBusy(null);
        }
    };

    const test = async (what: 'notification' | 'jellyfin') => {
        setBusy(what);
        try {
            if (what === 'notification') {
                const res = await api.post<{ channel: string; ok: string; error?: string }[]>('/dashboard/settings/test-notification');
                const bad = res.data.filter(r => r.ok !== 'true');
                if (bad.length) toast.error('A channel failed', bad.map(b => `${b.channel}: ${b.error}`).join(' · '));
                else toast.success('Test sent', `Check your ${res.data.map(r => r.channel).join(' and ')}.`);
            } else {
                const res = await api.post<{ ok?: boolean; error?: string; server?: string; libraries?: unknown[] }>('/dashboard/settings/test-jellyfin');
                if (res.data.ok) toast.success('Jellyfin answers', `${res.data.server ?? 'Server'} · ${res.data.libraries?.length ?? 0} libraries.`);
                else toast.error('Jellyfin does not answer', res.data.error);
            }
        } catch (err) {
            toast.apiError('Test failed', err);
        } finally {
            setBusy(null);
        }
    };

    if (!loaded) return null;

    return (
        <section ref={root} id="integrations" className="space-y-4 scroll-mt-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
                <h3 className="text-xl font-semibold">Integrations</h3>
                <Button onClick={save} disabled={!dirty || busy === 'save'}>
                    {busy === 'save' && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                    {dirty ? 'Save integrations' : 'Saved'}
                </Button>
            </div>

            <div className="grid gap-4 lg:grid-cols-2">
                <Card>
                    <CardHeader><CardTitle className="flex items-center gap-2 text-lg"><Globe className="h-5 w-5" /> Address of this machine</CardTitle></CardHeader>
                    <CardContent className="space-y-4">
                        <div className="space-y-1.5">
                            <Label htmlFor="pub">Public address</Label>
                            <Input id="pub" value={form.PUBLIC_BASE_URL ?? ''} onChange={e => set('PUBLIC_BASE_URL')(e.target.value)} placeholder="http://192.168.1.20" />
                            <p className="text-xs text-muted-foreground">
                                Used in the playlist addresses you copy, and in the links in notifications. Without it, they start with the address this page was opened on, which a TV cannot reach if that is <code>localhost</code>.
                            </p>
                        </div>
                    </CardContent>
                </Card>

                <Card>
                    <CardHeader><CardTitle className="flex items-center gap-2 text-lg"><Camera className="h-5 w-5" /> TV wall</CardTitle></CardHeader>
                    <CardContent className="space-y-4">
                        <div className="flex items-start justify-between gap-4">
                            <div>
                                <Label>Capture a picture of free channels</Label>
                                <p className="text-xs text-muted-foreground max-w-sm mt-1">
                                    Every 15 minutes, 12 channels of the chosen playlist are opened for one frame. Only free M3U sources: a paid provider allows one connection, and the capture would cut your TV off.
                                </p>
                            </div>
                            <Switch checked={flag('TVWALL_ENABLED')} onCheckedChange={v => set('TVWALL_ENABLED')(v ? 'true' : 'false')} aria-label="TV wall" />
                        </div>
                        <div className="space-y-1.5">
                            <Label htmlFor="feat">Playlist shown on the dashboard</Label>
                            <select id="feat" className={select} value={form.DASHBOARD_PLAYLIST_ID ?? ''} onChange={e => set('DASHBOARD_PLAYLIST_ID')(e.target.value)}>
                                <option value="">Automatic (best programme guide)</option>
                                {loaded.playlists.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                            </select>
                        </div>
                    </CardContent>
                </Card>

                <Card>
                    <CardHeader><CardTitle className="flex items-center gap-2 text-lg"><Library className="h-5 w-5" /> Jellyfin</CardTitle></CardHeader>
                    <CardContent className="space-y-4">
                        <div className="space-y-1.5">
                            <Label htmlFor="jf">Server address</Label>
                            <Input id="jf" value={form.JELLYFIN_URL ?? ''} onChange={e => set('JELLYFIN_URL')(e.target.value)} placeholder="http://192.168.1.20:8096" />
                        </div>
                        <Secret label="API key" isSet={loaded.HAS_JELLYFIN_API_KEY} value={form.JELLYFIN_API_KEY ?? ''} onChange={set('JELLYFIN_API_KEY')}
                            hint="Create one in Jellyfin: Dashboard, API Keys. It is read only here, plus the library scan button." />
                        <Button variant="outline" onClick={() => test('jellyfin')} disabled={dirty || busy === 'jellyfin' || !loaded.JELLYFIN_URL}
                            title={dirty ? 'Save first' : undefined}>
                            {busy === 'jellyfin' && <Loader2 className="h-4 w-4 mr-2 animate-spin" />} Test the connection
                        </Button>
                    </CardContent>
                </Card>

                <Card>
                    <CardHeader><CardTitle className="flex items-center gap-2 text-lg"><BellRing className="h-5 w-5" /> Notifications</CardTitle></CardHeader>
                    <CardContent className="space-y-4">
                        <p className="text-xs text-muted-foreground">
                            A problem is sent when it is still there five minutes later, and again when it is gone. Switching this on does not send the problems already on the dashboard.
                        </p>
                        <div className="space-y-1.5">
                            <Label htmlFor="ntfy">ntfy topic address</Label>
                            <Input id="ntfy" value={form.NOTIFY_NTFY_URL ?? ''} onChange={e => set('NOTIFY_NTFY_URL')(e.target.value)} placeholder="https://ntfy.sh/my-private-topic" />
                        </div>
                        <Secret label="ntfy access token (optional)" isSet={loaded.HAS_NOTIFY_NTFY_TOKEN} value={form.NOTIFY_NTFY_TOKEN ?? ''} onChange={set('NOTIFY_NTFY_TOKEN')} />
                        <div className="grid gap-4 sm:grid-cols-2">
                            <Secret label="Telegram bot token" isSet={loaded.HAS_NOTIFY_TELEGRAM_TOKEN} value={form.NOTIFY_TELEGRAM_TOKEN ?? ''} onChange={set('NOTIFY_TELEGRAM_TOKEN')} />
                            <div className="space-y-1.5">
                                <Label htmlFor="tg">Telegram chat id</Label>
                                <Input id="tg" value={form.NOTIFY_TELEGRAM_CHAT_ID ?? ''} onChange={e => set('NOTIFY_TELEGRAM_CHAT_ID')(e.target.value)} />
                            </div>
                        </div>
                        <div className="space-y-1.5">
                            <Label htmlFor="hook">Webhook (JSON)</Label>
                            <Input id="hook" value={form.NOTIFY_WEBHOOK_URL ?? ''} onChange={e => set('NOTIFY_WEBHOOK_URL')(e.target.value)} placeholder="https://…" />
                        </div>
                        <div className="space-y-1.5">
                            <Label htmlFor="sev">Send</Label>
                            <select id="sev" className={select} value={form.NOTIFY_MIN_SEVERITY ?? 'warning'} onChange={e => set('NOTIFY_MIN_SEVERITY')(e.target.value)}>
                                <option value="warning">Serious problems and things to check</option>
                                <option value="danger">Serious problems only</option>
                            </select>
                        </div>
                        <div className="flex items-center justify-between gap-4">
                            <Label>Also tell me when a download completes</Label>
                            <Switch checked={flag('NOTIFY_DOWNLOAD_DONE')} onCheckedChange={v => set('NOTIFY_DOWNLOAD_DONE')(v ? 'true' : 'false')} aria-label="Download completed" />
                        </div>
                        <Button variant="outline" onClick={() => test('notification')}
                            disabled={dirty || busy === 'notification'} title={dirty ? 'Save first' : undefined}>
                            {busy === 'notification' && <Loader2 className="h-4 w-4 mr-2 animate-spin" />} Send a test
                        </Button>
                    </CardContent>
                </Card>
            </div>
        </section>
    );
};
