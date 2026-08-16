import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import {
    BarChart, Bar, XAxis, YAxis, CartesianGrid,
    Tooltip, ResponsiveContainer, Legend
} from 'recharts';
import api from "@/lib/api";

interface DailyStats {
    date: string;
    total_downloads: number;
    completed_downloads: number;
    failed_downloads: number;
    total_bytes_downloaded: number;
}

export default function DownloadStats() {
    const [stats, setStats] = useState<DailyStats[]>([]);

    useEffect(() => {
        fetchStats();
    }, []);

    const fetchStats = async () => {
        try {
            const res = await api.get<DailyStats[]>("/downloads/stats");
            // Reverse to show chronological order for the chart
            setStats(res.data.reverse());
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

    if (!stats.length) return null;

    return (
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
    );
}
