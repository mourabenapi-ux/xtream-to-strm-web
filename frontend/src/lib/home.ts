import api from '@/lib/api';

// ---------------------------------------------------------------------------
// What GET /dashboard/overview returns (see backend services/overview.py)
// ---------------------------------------------------------------------------

export type Severity = 'info' | 'warning' | 'danger';

export interface ActionSpec {
    kind: 'repair_dead' | 'fix_numbering' | 'sync' | 'refresh_guide' | 'jellyfin_scan';
    label: string;
    playlist_id?: number;
    subscription_id?: number;
    type?: 'movies' | 'series' | 'all';
    source_id?: number;
}

export interface Condition {
    key: string;
    severity: Severity;
    title: string;
    detail: string | null;
    action: ActionSpec | null;
    link: string | null;
    since: string | null;
    notified: boolean;
}

export interface PlayerSeen { kind: 'm3u' | 'xml'; client: string; last_at: string | null; first_at: string | null; count: number }

export interface PlaylistRow {
    id: number;
    name: string;
    key: string;
    short_name: string | null;
    public_id: string | null;
    numbered: boolean;
    rows: number;
    served: number;
    dead: number;
    excluded?: number;
    with_schedule: number;
    schedule_percentage: number;
    free_channels?: number;
    issues: { type: string; severity: string; title: string; fix: string | null; count: number }[];
    dead_reasons: Record<string, number>;
    error: string | null;
    players: PlayerSeen[];
}

export interface SyncRow { at: string | null; status: string; added: number; deleted: number; refreshed: number; error: string | null }

export interface Account {
    status?: string; auth?: number; exp_date?: number; expires_at?: string; days_left?: number;
    active_cons?: number; max_connections?: number; is_trial?: boolean; message?: string;
    checked_at?: string; error?: string;
}

export interface ProviderRow {
    id: number;
    name: string;
    kind: 'xtream' | 'm3u';
    is_active: boolean;
    vod: boolean;
    movies: number;
    series: number;
    syncs: { movies: SyncRow | null; series: SyncRow | null };
    schedules: { type: string; frequency: string; enabled: boolean; next_run: string | null }[];
    schedule_enabled: boolean;
    account: Account | null;
}

export interface GuideRow {
    id: number; name: string; type: string; active: boolean; channel_count: number;
    cached_channels: number | null; last_updated: string | null; refresh_hours: number;
    playlists: number; duplicate_of: { id: number; name: string } | null;
}

export interface Library {
    movies?: number; series?: number; orphan_movies?: number; orphan_series?: number;
    strm?: { movies: number; episodes: number; shows: number; bytes: number };
    downloaded?: { movies: number; episodes: number; bytes: number };
    downloads?: { queued: number; running: number; completed: number; failed: number };
}

export interface JellyfinLibrary { name: string; type: string; count: number | null; role: string | null }
export interface JellyfinCard { id: string; name: string; type: 'movie' | 'series'; year: number | null; added_at: string | null; episodes: number }
export interface Jellyfin {
    configured: boolean; ok?: boolean; error?: string; server?: string; version?: string;
    libraries?: JellyfinLibrary[]; recent?: JellyfinCard[];
}

export interface SystemInfo {
    disk?: { total: number; used: number; free: number; percent: number; app_bytes: number };
    redis?: { online: boolean; used_bytes?: number };
    workers?: number | null;
}

export interface ActiveTask {
    id: string; type: 'sync' | 'download'; name: string; progress: number;
    speed_kbps?: number; eta_seconds?: number; status: string; phase?: string | null;
}

export interface JournalEvent {
    id: number; at: string; kind: string; severity: Severity; title: string;
    detail: string | null; link: string | null; notified: boolean;
}

export interface ConditionsPayload {
    computed_at: string | null;
    refreshing: boolean;
    conditions: Condition[];
}

export interface Overview {
    pending: boolean;
    refreshing: boolean;
    computed_at: string | null;
    duration_ms: number | null;
    now: string;
    conditions: Condition[];
    playlists: PlaylistRow[];
    featured_playlist_id: number | null;
    providers: ProviderRow[];
    guides: GuideRow[];
    library: Library;
    system: SystemInfo;
    jellyfin: Jellyfin;
    tasks: ActiveTask[];
    events: JournalEvent[];
    settings: { public_base_url: string; tvwall_enabled: boolean; notifications: boolean };
}

export interface OnAirChannel {
    channel_id: number | null; number: number | null; name: string; logo: string | null; group: string | null;
    free: boolean; guide: string; now: string | null; now_start: number | null; now_stop: number | null;
    next: string | null; next_start: number | null; picture: { ok: boolean; checked_at: string; error: string | null } | null;
}

export interface TonightChannel {
    channel_id: number | null; number: number | null; name: string; logo: string | null; title: string;
    sub: string | null; category: string | null; icon: string | null; start: number; stop: number; desc: string;
    then: { title: string; start: number } | null;
}

export interface WallChannel {
    channel_id: number; number: number | null; name: string; logo: string | null; ok: boolean | null;
    error: string | null; seconds: number | null; checked_at: string | null; has_image: boolean;
}
export interface Wall { enabled: boolean; running: boolean; finished_at: string | null; channels: WallChannel[]; paid_channels: number }

export interface FindHit {
    playlist_id: number; playlist: string; channel_id: number | null; number: number | null; name: string;
    logo: string | null; group: string | null; now: string | null; guide: string;
}

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

/** "3 min ago", "yesterday", "9 days ago". Takes an ISO string or epoch seconds. */
export function timeAgo(value: string | number | null | undefined, now: number = Date.now()): string {
    if (value === null || value === undefined || value === '') return 'never';
    const then = typeof value === 'number' ? value * 1000 : new Date(value).getTime();
    if (Number.isNaN(then)) return 'never';
    const seconds = Math.round((now - then) / 1000);
    if (seconds < 0) return 'in the future';
    if (seconds < 45) return 'just now';
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes} min ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${hours} h ago`;
    const days = Math.round(hours / 24);
    return days === 1 ? 'yesterday' : `${days} days ago`;
}

export function clock(seconds: number | null | undefined): string {
    return seconds ? new Date(seconds * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
}

export function bytes(value: number | null | undefined): string {
    if (!value) return '0 MB';
    const gb = value / 1024 ** 3;
    if (gb >= 100) return `${Math.round(gb)} GB`;
    if (gb >= 1) return `${gb.toFixed(1)} GB`;
    return `${Math.max(1, Math.round(value / 1024 ** 2))} MB`;
}

export function number(value: number | null | undefined): string {
    return (value ?? 0).toLocaleString('en-US').replace(/,/g, ' ');
}

// ---------------------------------------------------------------------------
// Player URLs
// ---------------------------------------------------------------------------

const BASE_KEY = 'public-base-url';

/** The address players should use: the configured one, else the one this page was opened on. */
export function getPublicBase(): string {
    try {
        return localStorage.getItem(BASE_KEY) || window.location.origin;
    } catch {
        return window.location.origin;
    }
}

export function setPublicBase(value: string | null | undefined): void {
    try {
        const clean = (value || '').trim().replace(/\/+$/, '');
        if (clean) localStorage.setItem(BASE_KEY, clean);
        else localStorage.removeItem(BASE_KEY);
    } catch { /* private window: the page origin is the fallback */ }
}

/** Fetched once at start so every screen builds the same URLs. */
export async function loadPublicBase(): Promise<void> {
    try {
        const res = await api.get<{ PUBLIC_BASE_URL?: string }>('/dashboard/settings');
        setPublicBase(res.data.PUBLIC_BASE_URL);
    } catch { /* the dashboard still works with the page address */ }
}

export function shortUrls(p: { key: string }): { m3u: string; xml: string } {
    const base = getPublicBase();
    return { m3u: `${base}/p/${p.key}.m3u`, xml: `${base}/p/${p.key}.xml` };
}

/** True when the URLs point at this machine only: a TV cannot reach them. */
export function isLocalOnly(url: string): boolean {
    try {
        const host = new URL(url).hostname;
        return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
    } catch {
        return false;
    }
}

// ---------------------------------------------------------------------------
// Clipboard
// ---------------------------------------------------------------------------

/**
 * Copies text. `navigator.clipboard` only exists on https and on localhost:
 * opened from the LAN (http://192.168.x.x), it is undefined and the copy
 * buttons did nothing. The textarea route works everywhere.
 */
export async function copyText(text: string): Promise<boolean> {
    try {
        if (navigator.clipboard && window.isSecureContext) {
            await navigator.clipboard.writeText(text);
            return true;
        }
    } catch { /* fall through */ }
    try {
        const area = document.createElement('textarea');
        area.value = text;
        area.setAttribute('readonly', '');
        area.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
        document.body.appendChild(area);
        area.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(area);
        return ok;
    } catch {
        return false;
    }
}
