import { BrowserRouter as Router, Routes, Route, Link, useLocation, Navigate, useNavigate } from 'react-router-dom';
import { LayoutDashboard, Settings, FileText, Activity, Radio, Download, ChevronDown, ChevronRight, Menu, X, LogOut, Database, Globe, Plus, Wand2, Tags, Search } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import Login from './pages/Login';
import ProtectedRoute from './components/ProtectedRoute';
import { ToastProvider } from './contexts/ToastContext';
import { useState, useEffect, useRef } from 'react';

// Pages
import Dashboard from './pages/Dashboard';
import Administration from './pages/Administration';
import Logs from './pages/Logs';

// XtreamTV Pages
import XTVSubscriptions from './pages/xtreamtv/XTVSubscriptions';
import XTVSelection from './pages/xtreamtv/XTVSelection';
import XTVScheduling from './pages/xtreamtv/XTVScheduling';

// Download Pages
import Downloads from './pages/Downloads';
import DownloadSelection from './pages/DownloadSelection';
import LiveSelection from './pages/LiveSelection';
import LivePlaylists from './pages/LivePlaylists';
import LiveOrganizer from './pages/LiveOrganizer';
import LiveEPG from './pages/LiveEPG';
import EPGAdmin from './pages/EPGAdmin';
import MonitoredList from './pages/MonitoredList';
import TmdbFixes from './pages/TmdbFixes';
import { QuickFind } from './components/QuickFind';
import { NotificationBell } from './components/home/NotificationBell';
import { loadPublicBase } from './lib/home';

/** Title shown in the phone's top bar, where the sidebar is hidden. */
const PAGE_TITLES: Record<string, string> = {
    '/': 'Dashboard',
    '/xtreamtv/subscriptions': 'Sources',
    '/xtreamtv/selection': 'Bouquet Selection',
    '/xtreamtv/scheduling': 'Auto-Sync Schedule',
    '/live-playlists': 'Live Playlists',
    '/live-organizer': 'Auto Organizer',
    '/live-selection': 'Playlist editor',
    '/live-epg': 'Playlist EPG Mapping',
    '/epg-admin': 'Global EPG Sources',
    '/tmdb-fixes': 'TMDB Fixes',
    '/downloads/selection': 'Media Selection',
    '/downloads/monitored': 'Active Surveillance',
    '/downloads/manager': 'Download Manager',
    '/admin': 'Administration',
    '/logs': 'Logs',
};

/** Screens that manage their own scrolling and fill the whole content area. */
const FULL_BLEED = new Set(['/live-selection']);

function Layout({ children }: { children: React.ReactNode }) {
    const location = useLocation();
    const [xtreamExpanded, setXtreamExpanded] = useState(true);
    const [downloadsExpanded, setDownloadsExpanded] = useState(true);
    const [sidebarOpen, setSidebarOpen] = useState(false);
    const mainRef = useRef<HTMLElement>(null);
    const navigate = useNavigate();

    // The address players should use is configured once and shared by every screen.
    useEffect(() => { loadPublicBase(); }, []);

    const handleLogout = () => {
        localStorage.removeItem('token');
        navigate('/login');
    };

    const isXtreamActive = location.pathname.startsWith('/xtreamtv');
    const isDownloadsActive = location.pathname.startsWith('/downloads');
    const fullBleed = FULL_BLEED.has(location.pathname);

    // A new screen opens at its top. <main> is the scroll container, not the
    // window, so the browser never reset it: a page opened from the menu kept
    // the previous page's scroll and landed halfway down.
    useEffect(() => {
        setSidebarOpen(false);
        mainRef.current?.scrollTo(0, 0);
    }, [location.pathname]);

    useEffect(() => {
        if (!sidebarOpen) return;
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setSidebarOpen(false); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [sidebarOpen]);

    const navItem = (to: string, Icon: LucideIcon, label: string, opts: { sub?: boolean; tint?: boolean } = {}) => (
        <Link
            to={to}
            className={`flex items-center gap-3 px-3 py-2 rounded-md transition-colors ${opts.sub ? 'text-sm' : ''} ${location.pathname === to ? 'bg-accent text-accent-foreground' : 'hover:bg-accent hover:text-accent-foreground'}`}
        >
            <Icon size={opts.sub ? 16 : 20} className={opts.tint ? 'text-primary' : undefined} />
            <span>{label}</span>
        </Link>
    );

    const sectionLabel = 'text-sm font-semibold uppercase tracking-wider text-muted-foreground/70';

    // The whole frame is exactly the visible screen (h-dvh, see index.css).
    // It used to be 100vh, which on a phone is taller than what the browser
    // shows while its address bar is visible: the bottom of the menu and of
    // every page sat under the browser's toolbar, out of reach.
    return (
        <div className="app-frame overflow-hidden bg-background text-foreground flex relative">
            {/* Phone overlay behind the open menu */}
            {sidebarOpen && (
                <div
                    className="lg:hidden fixed inset-0 bg-black/50 z-30"
                    onClick={() => setSidebarOpen(false)}
                    aria-hidden="true"
                />
            )}

            {/* Sidebar: a drawer on phones and tablets, a column from lg up.
                Header and footer stay put; only the links scroll, and the
                scroll never leaks to the page behind (overscroll-contain). */}
            <aside
                className={`
                    w-72 max-w-[85vw] lg:w-64 border-r border-border bg-card flex flex-col
                    fixed lg:relative inset-y-0 left-0 z-40 app-frame
                    transform transition-transform duration-300 ease-in-out
                    ${sidebarOpen ? 'translate-x-0 shadow-xl' : '-translate-x-full'}
                    lg:translate-x-0 lg:shadow-none
                `}
                aria-label="Main menu"
            >
                <div className="flex items-center justify-between gap-2 px-4 pt-4 pb-3 lg:pb-6">
                    <h1 className="text-2xl font-bold text-primary">Xtream2STRM</h1>
                    <button
                        onClick={() => setSidebarOpen(false)}
                        className="lg:hidden p-2 -mr-2 rounded-md hover:bg-accent"
                        aria-label="Close the menu"
                    >
                        <X size={22} />
                    </button>
                </div>

                <nav className="flex-1 min-h-0 overflow-y-auto overscroll-contain px-4 pb-4 space-y-1">
                    {navItem('/', LayoutDashboard, 'Dashboard')}

                    {/* Xtream TV to STRM */}
                    <div>
                        <button
                            onClick={() => setXtreamExpanded(!xtreamExpanded)}
                            className={`w-full flex items-center justify-between gap-3 px-3 py-2 rounded-md transition-colors ${isXtreamActive ? 'bg-accent/50 text-accent-foreground' : 'hover:bg-accent hover:text-accent-foreground'}`}
                            aria-expanded={xtreamExpanded}
                        >
                            <span className={sectionLabel}>Sources &amp; sync</span>
                            {xtreamExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                        </button>
                        {xtreamExpanded && (
                            <div className="ml-2 mt-1 space-y-1">
                                {navItem('/xtreamtv/subscriptions', Database, 'Sources', { sub: true })}
                                {navItem('/xtreamtv/selection', Menu, 'Bouquet Selection', { sub: true })}
                            </div>
                        )}
                    </div>

                    {/* The "M3U to STRM" section used to live here. An M3U
                        playlist is a source like any other now — it is added,
                        selected and synchronised on the two screens above — so
                        a section of its own only duplicated them. The /m3u/*
                        routes still exist and redirect there. */}

                    <div className="h-4" />

                    {/* Playlist & EPG Section */}
                    <div className={`px-3 mb-2 ${sectionLabel}`}>Management</div>
                    {navItem('/live-playlists', Radio, 'Live Playlists', { tint: true })}
                    {navItem('/live-organizer', Wand2, 'Auto Organizer', { tint: true })}
                    {navItem('/epg-admin', Activity, 'Global EPG Sources', { tint: true })}
                    {navItem('/live-epg', Globe, 'Playlist EPG Mapping', { tint: true })}
                    {navItem('/tmdb-fixes', Tags, 'TMDB Fixes', { tint: true })}
                    {navItem('/xtreamtv/scheduling', Settings, 'Auto-Sync Schedule', { tint: true })}

                    <div className="h-4" />

                    {/* Downloads Group */}
                    <div>
                        <button
                            onClick={() => setDownloadsExpanded(!downloadsExpanded)}
                            className={`w-full flex items-center justify-between gap-3 px-3 py-2 rounded-md transition-colors ${isDownloadsActive ? 'bg-accent/50 text-accent-foreground' : 'hover:bg-accent hover:text-accent-foreground'}`}
                            aria-expanded={downloadsExpanded}
                        >
                            <span className={sectionLabel}>Downloads</span>
                            {downloadsExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                        </button>
                        {downloadsExpanded && (
                            <div className="ml-2 mt-1 space-y-1">
                                {navItem('/downloads/selection', Plus, 'Media Selection', { sub: true })}
                                {navItem('/downloads/monitored', Activity, 'Active Surveillance', { sub: true })}
                                {navItem('/downloads/manager', Download, 'Download Manager', { sub: true })}
                            </div>
                        )}
                    </div>

                    <div className="h-4" />

                    {/* System Section */}
                    <div className={`px-3 mb-2 ${sectionLabel}`}>System</div>
                    {navItem('/admin', Settings, 'Administration')}
                    {navItem('/logs', FileText, 'Logs')}
                </nav>

                {/* Always visible, whatever the height of the screen. */}
                <div className="px-4 py-3 border-t border-border flex items-center justify-between gap-2">
                    <button
                        onClick={handleLogout}
                        className="flex items-center gap-3 px-3 py-2 rounded-md transition-colors hover:bg-red-500/10 text-red-500"
                    >
                        <LogOut size={20} />
                        <span>Logout</span>
                    </button>
                    <div className="flex items-center gap-2 text-sm text-muted-foreground px-3">
                        <Activity size={16} />
                        <span>v4.8.0</span>
                    </div>
                </div>
            </aside>

            <QuickFind pages={PAGE_TITLES} />

            <div className="flex-1 min-w-0 flex flex-col">
                {/* Header on every screen: the menu button on phones and tablets (the
                    sidebar is a drawer there), the search, and the notification bell.
                    It used to exist on phones only and floated over the page. */}
                <header className="flex-shrink-0 h-12 flex items-center gap-1 px-2 lg:px-4 border-b border-border bg-card z-20">
                    <button
                        onClick={() => setSidebarOpen(true)}
                        className="lg:hidden p-2 rounded-md hover:bg-accent"
                        aria-label="Open the menu"
                        aria-expanded={sidebarOpen}
                    >
                        <Menu size={22} />
                    </button>
                    <span className="lg:hidden font-semibold truncate ml-1">{PAGE_TITLES[location.pathname] ?? 'Xtream2STRM'}</span>
                    <div className="ml-auto flex items-center gap-1">
                        {!fullBleed && (
                            <button
                                onClick={() => window.dispatchEvent(new CustomEvent('open-quickfind'))}
                                className="flex items-center gap-2 h-9 px-2 sm:px-3 rounded-md border border-input text-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                                aria-label="Find a channel or a page"
                            >
                                <Search size={16} />
                                <span className="hidden sm:inline">Find</span>
                                <kbd className="hidden md:inline rounded border px-1.5 text-[10px]">Ctrl K</kbd>
                            </button>
                        )}
                        <NotificationBell />
                    </div>
                </header>

                <main
                    ref={mainRef}
                    className={`flex-1 min-h-0 ${fullBleed ? 'overflow-hidden' : 'overflow-auto overscroll-contain p-4 lg:p-8'}`}
                >
                    {children}
                </main>
            </div>
        </div>
    );
}

function App() {
    return (
        <ToastProvider>
            <Router>
                <Routes>
                <Route path="/login" element={<Login />} />

                <Route path="/" element={<ProtectedRoute><Layout><Dashboard /></Layout></ProtectedRoute>} />

                {/* XtreamTV */}
                <Route path="/xtreamtv/subscriptions" element={<ProtectedRoute><Layout><XTVSubscriptions /></Layout></ProtectedRoute>} />
                <Route path="/xtreamtv/selection" element={<ProtectedRoute><Layout><XTVSelection /></Layout></ProtectedRoute>} />
                <Route path="/xtreamtv/scheduling" element={<ProtectedRoute><Layout><XTVScheduling /></Layout></ProtectedRoute>} />

                {/* Live TV */}
                <Route path="/live-playlists" element={<ProtectedRoute><Layout><LivePlaylists /></Layout></ProtectedRoute>} />
                <Route path="/live-organizer" element={<ProtectedRoute><Layout><LiveOrganizer /></Layout></ProtectedRoute>} />
                <Route path="/live-selection" element={<ProtectedRoute><Layout><LiveSelection /></Layout></ProtectedRoute>} />
                <Route path="/live-epg" element={<ProtectedRoute><Layout><LiveEPG /></Layout></ProtectedRoute>} />
                <Route path="/epg-admin" element={<ProtectedRoute><Layout><EPGAdmin /></Layout></ProtectedRoute>} />

                {/* Library metadata */}
                <Route path="/tmdb-fixes" element={<ProtectedRoute><Layout><TmdbFixes /></Layout></ProtectedRoute>} />

                {/* M3U — an M3U playlist is a source like any other since the
                    unification, so these now land on the shared screens. The
                    routes are kept so an existing bookmark still works. */}
                <Route path="/m3u/sources" element={<Navigate to="/xtreamtv/subscriptions" replace />} />
                <Route path="/m3u/selection" element={<Navigate to="/xtreamtv/selection" replace />} />

                {/* Downloads */}
                <Route path="/downloads/selection" element={<ProtectedRoute><Layout><DownloadSelection /></Layout></ProtectedRoute>} />
                <Route path="/downloads/monitored" element={<ProtectedRoute><Layout><MonitoredList /></Layout></ProtectedRoute>} />
                <Route path="/downloads/manager" element={<ProtectedRoute><Layout><Downloads /></Layout></ProtectedRoute>} />

                {/* Administration & Logs */}
                <Route path="/admin" element={<ProtectedRoute><Layout><Administration /></Layout></ProtectedRoute>} />
                <Route path="/logs" element={<ProtectedRoute><Layout><Logs /></Layout></ProtectedRoute>} />

                    {/* Redirect all other routes to dashboard */}
                    <Route path="*" element={<Navigate to="/" replace />} />
                </Routes>
            </Router>
        </ToastProvider>
    );
}

export default App;
