import { FC, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
    AlertOctagon, AlertTriangle, CalendarClock, CheckCircle2, Download, Info, Loader2, MonitorPlay, RefreshCw,
} from 'lucide-react';
import api from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { timeAgo, type ActiveTask, type JournalEvent } from '@/lib/home';

const KIND_ICON: Record<string, typeof Info> = {
    sync: RefreshCw, guide: CalendarClock, download: Download, player: MonitorPlay, resolved: CheckCircle2,
    condition: AlertTriangle,
};

function iconOf(e: JournalEvent) {
    if (e.severity === 'danger') return { Icon: AlertOctagon, tone: 'text-red-500' };
    if (e.severity === 'warning') return { Icon: KIND_ICON[e.kind] ?? AlertTriangle, tone: 'text-amber-500' };
    if (e.kind === 'resolved') return { Icon: CheckCircle2, tone: 'text-emerald-500' };
    return { Icon: KIND_ICON[e.kind] ?? Info, tone: 'text-muted-foreground' };
}

export const ActivityPanel: FC<{ tasks: ActiveTask[]; events: JournalEvent[] }> = ({ tasks, events }) => {
    const navigate = useNavigate();
    const [extra, setExtra] = useState<JournalEvent[]>([]);
    const [done, setDone] = useState(false);
    const [loading, setLoading] = useState(false);
    const all = [...events, ...extra.filter(x => !events.some(e => e.id === x.id))];

    const more = async () => {
        const last = all[all.length - 1];
        if (!last) return;
        setLoading(true);
        try {
            const res = await api.get<JournalEvent[]>('/dashboard/events', { params: { limit: 20, before_id: last.id } });
            setExtra(prev => [...prev, ...res.data]);
            if (res.data.length < 20) setDone(true);
        } finally {
            setLoading(false);
        }
    };

    return (
        <Card className="p-4">
            <h3 className="text-lg font-semibold pb-2">Activity</h3>
            {tasks.length > 0 && (
                <ul className="space-y-3 pb-3 mb-3 border-b">
                    {tasks.map(t => (
                        <li key={t.id}>
                            <div className="flex items-center gap-2 text-sm">
                                {t.type === 'sync' ? <RefreshCw className="h-4 w-4 text-purple-500 animate-spin" /> : <Download className="h-4 w-4 text-blue-500" />}
                                <span className="font-medium truncate">{t.name}</span>
                                <span className="ml-auto text-xs text-muted-foreground shrink-0">
                                    {t.phase || (t.type === 'download' && t.speed_kbps ? `${(t.speed_kbps / 1024).toFixed(1)} MB/s` : 'running')}
                                    {' · '}{Math.round(t.progress)}%
                                </span>
                            </div>
                            <div className="h-1.5 rounded-full bg-secondary overflow-hidden mt-1.5" role="progressbar" aria-valuenow={Math.round(t.progress)} aria-valuemin={0} aria-valuemax={100}>
                                <div className={`h-full transition-all duration-500 ${t.type === 'sync' ? 'bg-purple-500' : 'bg-blue-500'}`} style={{ width: `${t.progress}%` }} />
                            </div>
                        </li>
                    ))}
                </ul>
            )}
            {all.length === 0 ? (
                <p className="text-sm text-muted-foreground py-4">
                    Nothing yet. Syncs, guide refreshes, downloads and problems are listed here as they happen.
                </p>
            ) : (
                <ul className="space-y-0.5">
                    {all.map(e => {
                        const { Icon, tone } = iconOf(e);
                        const body = (
                            <>
                                <Icon className={`h-4 w-4 mt-0.5 shrink-0 ${tone}`} />
                                <div className="min-w-0 flex-1 text-left">
                                    <div className="text-sm truncate" title={e.title}>{e.title}</div>
                                    {e.detail && <div className="text-xs text-muted-foreground truncate" title={e.detail}>{e.detail}</div>}
                                </div>
                                <div className="text-[11px] text-muted-foreground shrink-0 mt-0.5" title={new Date(e.at).toLocaleString()}>{timeAgo(e.at)}</div>
                            </>
                        );
                        return (
                            <li key={e.id}>
                                {e.link
                                    ? <button className="w-full flex gap-2.5 rounded-md px-2 py-1.5 hover:bg-muted/60" onClick={() => navigate(e.link!)}>{body}</button>
                                    : <div className="flex gap-2.5 px-2 py-1.5">{body}</div>}
                            </li>
                        );
                    })}
                </ul>
            )}
            {all.length >= 15 && !done && (
                <div className="pt-2 text-center">
                    <Button variant="ghost" size="sm" onClick={more} disabled={loading}>
                        {loading && <Loader2 className="h-4 w-4 mr-1 animate-spin" />} Earlier
                    </Button>
                </div>
            )}
        </Card>
    );
};
