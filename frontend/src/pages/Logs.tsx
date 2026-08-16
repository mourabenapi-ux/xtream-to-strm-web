import { useState, useEffect, useRef, useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Pause, Play, Trash2, Download, Search, ArrowDownToLine } from 'lucide-react';

const MAX_LINES = 2000;

type Level = 'all' | 'error' | 'warning' | 'info' | 'debug';

const LEVEL_FILTERS: { value: Level; label: string }[] = [
    { value: 'all', label: 'All' },
    { value: 'error', label: 'Error' },
    { value: 'warning', label: 'Warning' },
    { value: 'info', label: 'Info' },
    { value: 'debug', label: 'Debug' },
];

// Log lines are plain text from Python's logging module, so the level is
// matched on the word rather than on any structured field.
function levelOf(line: string): Exclude<Level, 'all'> | 'other' {
    if (/\b(ERROR|CRITICAL|FATAL|Traceback|Exception)\b/i.test(line)) return 'error';
    if (/\bWARN(ING)?\b/i.test(line)) return 'warning';
    if (/\bINFO\b/i.test(line)) return 'info';
    if (/\bDEBUG\b/i.test(line)) return 'debug';
    return 'other';
}

const LEVEL_CLASS: Record<string, string> = {
    error: 'text-red-400',
    warning: 'text-amber-300',
    info: 'text-emerald-400',
    debug: 'text-sky-400/70',
    other: 'text-emerald-400/80',
};

export default function Logs() {
    const [logs, setLogs] = useState<string[]>([]);
    const [isPaused, setIsPaused] = useState(false);
    const [isConnected, setIsConnected] = useState(false);
    const [level, setLevel] = useState<Level>('all');
    const [search, setSearch] = useState('');
    const [autoScroll, setAutoScroll] = useState(true);
    const [bufferedCount, setBufferedCount] = useState(0);

    const logsEndRef = useRef<HTMLDivElement>(null);
    const eventSourceRef = useRef<EventSource | null>(null);
    const pausedLogsRef = useRef<string[]>([]);
    // The SSE handler is installed once, so it cannot read `isPaused` from
    // state directly — it would capture the value from the first render and
    // never see an update. A ref keeps it honest.
    const isPausedRef = useRef(isPaused);
    isPausedRef.current = isPaused;
    const reconnectTimerRef = useRef<number | null>(null);

    useEffect(() => {
        connectToLogs();
        return () => {
            eventSourceRef.current?.close();
            if (reconnectTimerRef.current) window.clearTimeout(reconnectTimerRef.current);
        };
    }, []);

    const connectToLogs = () => {
        const token = localStorage.getItem('token');
        const es = new EventSource(`/api/v1/logs/stream?token=${token}`);

        es.onopen = () => setIsConnected(true);

        es.onmessage = (event) => {
            if (isPausedRef.current) {
                pausedLogsRef.current.push(event.data);
                setBufferedCount(pausedLogsRef.current.length);
            } else {
                setLogs(prev => [...prev, event.data].slice(-MAX_LINES));
            }
        };

        es.onerror = () => {
            setIsConnected(false);
            es.close();
            reconnectTimerRef.current = window.setTimeout(connectToLogs, 5000);
        };

        eventSourceRef.current = es;
    };

    const visibleLogs = useMemo(() => {
        const needle = search.trim().toLowerCase();
        return logs.filter(line => {
            if (level !== 'all' && levelOf(line) !== level) return false;
            if (needle && !line.toLowerCase().includes(needle)) return false;
            return true;
        });
    }, [logs, level, search]);

    // Only follow the tail when the user hasn't taken manual control.
    useEffect(() => {
        if (!isPaused && autoScroll) {
            logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
        }
    }, [visibleLogs, isPaused, autoScroll]);

    const handlePauseToggle = () => {
        if (isPaused) {
            // Resume: flush everything that arrived while paused.
            setLogs(prev => [...prev, ...pausedLogsRef.current].slice(-MAX_LINES));
            pausedLogsRef.current = [];
            setBufferedCount(0);
        }
        setIsPaused(!isPaused);
    };

    const handleClear = () => {
        setLogs([]);
        pausedLogsRef.current = [];
        setBufferedCount(0);
    };

    const handleDownload = () => {
        // Export what is on screen, so a filtered view exports the filtered lines.
        const text = visibleLogs.join('\n');
        const blob = new Blob([text], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `xtream_logs_${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    };

    const isFiltered = level !== 'all' || search.trim() !== '';

    return (
        <div className="space-y-6">
            <div>
                <h2 className="text-3xl font-bold tracking-tight">Logs</h2>
                <p className="text-muted-foreground">Real-time application logs</p>
            </div>

            <Card>
                <CardHeader className="space-y-3 pb-3">
                    <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
                        <CardTitle className="flex items-center gap-2">
                            <span>Live Logs</span>
                            <span
                                className={`w-2 h-2 rounded-full ${isConnected ? 'bg-green-500' : 'bg-red-500'}`}
                                title={isConnected ? 'Connected' : 'Disconnected — retrying every 5s'}
                            />
                            <span className="text-xs font-normal text-muted-foreground">
                                {isFiltered
                                    ? `${visibleLogs.length} of ${logs.length} lines`
                                    : `${logs.length} lines`}
                            </span>
                        </CardTitle>
                        <div className="flex flex-wrap gap-2">
                            <Button
                                size="sm"
                                variant={autoScroll ? 'outline' : 'secondary'}
                                onClick={() => setAutoScroll(!autoScroll)}
                                title="Follow new lines as they arrive"
                            >
                                <ArrowDownToLine className="w-4 h-4 mr-2" />
                                {autoScroll ? 'Following' : 'Follow'}
                            </Button>
                            <Button size="sm" variant={isPaused ? 'default' : 'outline'} onClick={handlePauseToggle}>
                                {isPaused ? <Play className="w-4 h-4 mr-2" /> : <Pause className="w-4 h-4 mr-2" />}
                                {isPaused ? `Resume${bufferedCount ? ` (${bufferedCount})` : ''}` : 'Pause'}
                            </Button>
                            <Button size="sm" variant="outline" onClick={handleClear} disabled={logs.length === 0}>
                                <Trash2 className="w-4 h-4 mr-2" />
                                Clear
                            </Button>
                            <Button size="sm" variant="outline" onClick={handleDownload} disabled={visibleLogs.length === 0}>
                                <Download className="w-4 h-4 mr-2" />
                                Download
                            </Button>
                        </div>
                    </div>

                    <div className="flex flex-col sm:flex-row gap-2">
                        <div className="flex gap-1 flex-wrap">
                            {LEVEL_FILTERS.map(f => (
                                <Button
                                    key={f.value}
                                    size="sm"
                                    variant={level === f.value ? 'default' : 'ghost'}
                                    className="h-8 text-xs"
                                    onClick={() => setLevel(f.value)}
                                >
                                    {f.label}
                                </Button>
                            ))}
                        </div>
                        <div className="relative flex-1 min-w-[200px]">
                            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                            <Input
                                placeholder="Filter lines…"
                                className="pl-8 h-9"
                                value={search}
                                onChange={(e) => setSearch(e.target.value)}
                            />
                        </div>
                    </div>
                </CardHeader>
                <CardContent>
                    <div
                        className="bg-black p-4 rounded-md font-mono text-sm h-[600px] overflow-auto"
                        // Any manual scroll away from the bottom stops the auto-follow,
                        // so reading history isn't yanked away by incoming lines.
                        onScroll={(e) => {
                            const el = e.currentTarget;
                            const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
                            if (!atBottom && autoScroll) setAutoScroll(false);
                        }}
                    >
                        {logs.length === 0 ? (
                            <div className="text-gray-500">Waiting for logs...</div>
                        ) : visibleLogs.length === 0 ? (
                            <div className="text-gray-500">
                                No line matches the current filter ({logs.length} hidden).
                            </div>
                        ) : (
                            <>
                                {visibleLogs.map((log, index) => (
                                    <div
                                        key={index}
                                        className={`whitespace-pre-wrap break-words ${LEVEL_CLASS[levelOf(log)]}`}
                                    >
                                        {log}
                                    </div>
                                ))}
                                <div ref={logsEndRef} />
                            </>
                        )}
                    </div>
                    {isPaused && (
                        <div className="mt-2 text-sm text-muted-foreground">
                            Paused — {bufferedCount} new line(s) buffered, they will appear when you resume.
                        </div>
                    )}
                </CardContent>
            </Card>
        </div>
    );
}
