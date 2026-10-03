import { useState, useEffect, useMemo } from "react";
import { BarChart3, ChevronDown, ChevronRight } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import {
    BarChart, Bar, XAxis, YAxis, CartesianGrid,
    Tooltip, ResponsiveContainer, Legend
} from 'recharts';
import api from "@/lib/api";

const DAYS = 7;
const OPEN_KEY = "downloads.stats.open";

const isoDay = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

interface DailyStats {
    date: string;
    total_downloads: number;
    completed_downloads: number;
    failed_downloads: number;
    total_bytes_downloaded: number;
}

export default function DownloadStats() {
    const [rows, setRows] = useState<DailyStats[]>([]);
    // Collapsed unless he opened it last time: the charts are background
    // information on a page whose job is the queue below.
    const [open, setOpen] = useState(() => {
        try { return localStorage.getItem(OPEN_KEY) === "1"; } catch { return false; }
    });

    const toggle = () => {
        setOpen(prev => {
            try { localStorage.setItem(OPEN_KEY, prev ? "0" : "1"); } catch { /* storage unavailable */ }
            return !prev;
        });
    };

    useEffect(() => {
        fetchStats();
    }, []);

    const fetchStats = async () => {
        try {
            const res = await api.get<DailyStats[]>("/downloads/stats", { params: { days: DAYS } });
            setRows(res.data);
        } catch (error) {
            console.error("Failed to fetch statistics", error);
        }
    };

    const formatSize = (bytes: number) => {
        if (bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    };

    // Exactly DAYS consecutive days ending today; a day with no activity has no
    // row on the server, so it is drawn as zero instead of being skipped.
    const stats = useMemo<DailyStats[]>(() => {
        const byDate = new Map(rows.map(r => [r.date, r]));
        const out: DailyStats[] = [];
        for (let i = DAYS - 1; i >= 0; i--) {
            const d = new Date();
            d.setDate(d.getDate() - i);
            const key = isoDay(d);
            out.push(byDate.get(key) ?? {
                date: key, total_downloads: 0, completed_downloads: 0,
                failed_downloads: 0, total_bytes_downloaded: 0,
            });
        }
        return out;
    }, [rows]);

    const completed = stats.reduce((n, d) => n + d.completed_downloads, 0);
    const failed = stats.reduce((n, d) => n + d.failed_downloads, 0);
    const bytes = stats.reduce((n, d) => n + d.total_bytes_downloaded, 0);

    return (
        <div className="space-y-3">
            <button
                type="button"
                onClick={toggle}
                aria-expanded={open}
                className="w-full flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border bg-muted/30 px-3 py-2 text-left text-sm hover:bg-muted/50 transition-colors"
            >
                {open ? <ChevronDown className="h-4 w-4 shrink-0" /> : <ChevronRight className="h-4 w-4 shrink-0" />}
                <BarChart3 className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="font-medium">Last {DAYS} days</span>
                <span className="text-muted-foreground">
                    <span className="text-green-600">{completed} completed</span>
                    {' · '}
                    <span className={failed > 0 ? "text-red-500" : ""}>{failed} failed</span>
                    {' · '}
                    {formatSize(bytes)}
                </span>
            </button>
            {open && (
        <div className="grid gap-4 md:grid-cols-2">
            <Card>
                <CardHeader>
                    <CardTitle className="text-sm font-medium">Download Activity (Last 7 Days)</CardTitle>
                </CardHeader>
                <CardContent className="h-[200px]">
                    <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={stats}>
                            <CartesianGrid strokeDasharray="3 3" vertical={false} />
                            <XAxis
                                dataKey="date"
                                fontSize={10}
                                tickFormatter={(str) => str.split('-').slice(1).join('/')}
                            />
                            <YAxis fontSize={10} />
                            <Tooltip
                                contentStyle={{ fontSize: '12px', borderRadius: '8px' }}
                                labelStyle={{ fontWeight: 'bold' }}
                            />
                            <Legend wrapperStyle={{ fontSize: '10px' }} />
                            <Bar dataKey="completed_downloads" name="Completed" fill="#22c55e" radius={[4, 4, 0, 0]} />
                            <Bar dataKey="failed_downloads" name="Failed" fill="#ef4444" radius={[4, 4, 0, 0]} />
                        </BarChart>
                    </ResponsiveContainer>
                </CardContent>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle className="text-sm font-medium">Data Transferred</CardTitle>
                </CardHeader>
                <CardContent className="h-[200px]">
                    <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={stats}>
                            <CartesianGrid strokeDasharray="3 3" vertical={false} />
                            <XAxis
                                dataKey="date"
                                fontSize={10}
                                tickFormatter={(str) => str.split('-').slice(1).join('/')}
                            />
                            <YAxis
                                fontSize={10}
                                tickFormatter={(val) => val > 1024 * 1024 * 1024 ? `${(val / (1024 * 1024 * 1024)).toFixed(1)}GB` : `${(val / (1024 * 1024)).toFixed(1)}MB`}
                            />
                            <Tooltip
                                formatter={(val: number) => formatSize(val)}
                                contentStyle={{ fontSize: '12px', borderRadius: '8px' }}
                            />
                            <Bar dataKey="total_bytes_downloaded" name="Data Usage" fill="#3b82f6" radius={[4, 4, 0, 0]} />
                        </BarChart>
                    </ResponsiveContainer>
                </CardContent>
            </Card>
        </div>
            )}
        </div>
    );
}
