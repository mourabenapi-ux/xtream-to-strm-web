import { BrowserRouter as Router, Routes, Route, Link, useLocation, Navigate, useNavigate } from 'react-router-dom';
import { LayoutDashboard, Settings, FileText, Activity, Radio, Download, ChevronDown, ChevronRight, Menu, X, LogOut, Database, Globe, Plus, Wand2, Tags } from 'lucide-react';
import Login from './pages/Login';
import ProtectedRoute from './components/ProtectedRoute';
import { ToastProvider } from './contexts/ToastContext';
import { useState, useEffect } from 'react';

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

function Layout({ children }: { children: React.ReactNode }) {
    const location = useLocation();
    const [xtreamExpanded, setXtreamExpanded] = useState(true);
    const [downloadsExpanded, setDownloadsExpanded] = useState(true);
    const [sidebarOpen, setSidebarOpen] = useState(false);
    const navigate = useNavigate();

    const handleLogout = () => {
        localStorage.removeItem('token');
        navigate('/login');
    };

    const isXtreamActive = location.pathname.startsWith('/xtreamtv');
    const isDownloadsActive = location.pathname.startsWith('/downloads');

    // Close sidebar when route changes on mobile
    useEffect(() => {
        setSidebarOpen(false);
    }, [location.pathname]);

    // Close sidebar when clicking outside on mobile
    const handleOverlayClick = () => {
        setSidebarOpen(false);
    };

    return (
        <div className="min-h-screen bg-background text-foreground flex relative">
            {/* Mobile Menu Button */}
            <button
                onClick={() => setSidebarOpen(!sidebarOpen)}
                className="lg:hidden fixed top-4 left-4 z-50 p-2 rounded-md bg-card border border-border shadow-lg"
                aria-label="Toggle menu"
            >
                {sidebarOpen ? <X size={24} /> : <Menu size={24} />}
            </button>

            {/* Mobile Overlay */}
            {sidebarOpen && (
                <div
                    className="lg:hidden fixed inset-0 bg-black bg-opacity-50 z-30"
                    onClick={handleOverlayClick}
                />
            )}

            {/* Sidebar */}
            <aside className={`
                w-64 border-r border-border bg-card p-4 flex flex-col
                fixed lg:relative inset-y-0 left-0 z-40
                transform transition-transform duration-300 ease-in-out
                ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'}
                lg:translate-x-0
            `}>
                <div className="mb-8">
                    <h1 className="text-2xl font-bold text-primary">Xtream2STRM</h1>
                </div>

                <nav className="space-y-1 flex-1">
                    {/* Main Tools Group */}
                    <Link
                        to="/"
                        className={`flex items-center gap-3 px-3 py-2 rounded-md transition-colors ${location.pathname === '/' ? 'bg-accent text-accent-foreground' : 'hover:bg-accent hover:text-accent-foreground'
                            }`}
                    >
                        <LayoutDashboard size={20} />
                        <span>Dashboard</span>
                    </Link>

                    {/* Xtream TV to STRM */}
                    <div>
                        <button
                            onClick={() => setXtreamExpanded(!xtreamExpanded)}
                            className={`w-full flex items-center justify-between gap-3 px-3 py-2 rounded-md transition-colors ${isXtreamActive ? 'bg-accent/50 text-accent-foreground' : 'hover:bg-accent hover:text-accent-foreground'
                                }`}
                        >
                            <div className="flex items-center gap-3 text-sm font-semibold uppercase tracking-wider text-muted-foreground/70">
                                <span>Sources &amp; sync</span>
                            </div>
                            {xtreamExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                        </button>
                        {xtreamExpanded && (
                            <div className="ml-2 mt-1 space-y-1">
                                <Link
                                    to="/xtreamtv/subscriptions"
                                    className={`flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors ${location.pathname === '/xtreamtv/subscriptions' ? 'bg-accent text-accent-foreground' : 'hover:bg-accent hover:text-accent-foreground'
                                        }`}
                                >
                                    <Database size={16} />
                                    <span>Sources</span>
                                </Link>
                                <Link
                                    to="/xtreamtv/selection"
                                    className={`flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors ${location.pathname === '/xtreamtv/selection' ? 'bg-accent text-accent-foreground' : 'hover:bg-accent hover:text-accent-foreground'
                                        }`}
                                >
                                    <Menu size={16} />
                                    <span>Bouquet Selection</span>
                                </Link>
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
                    <div className="px-3 text-sm font-semibold uppercase tracking-wider text-muted-foreground/70 mb-2">
                        Management
                    </div>

                    <Link
                        to="/live-playlists"
                        className={`flex items-center gap-3 px-3 py-2 rounded-md transition-colors ${location.pathname === '/live-playlists' ? 'bg-accent text-accent-foreground' : 'hover:bg-accent hover:text-accent-foreground'
                            }`}
                    >
                        <Radio size={20} className="text-primary" />
                        <span>Live Playlists</span>
                    </Link>

                    <Link
                        to="/live-organizer"
                        className={`flex items-center gap-3 px-3 py-2 rounded-md transition-colors ${location.pathname === '/live-organizer' ? 'bg-accent text-accent-foreground' : 'hover:bg-accent hover:text-accent-foreground'
                            }`}
                    >
                        <Wand2 size={20} className="text-primary" />
                        <span>Auto Organizer</span>
                    </Link>

                    <Link
                        to="/epg-admin"
                        className={`flex items-center gap-3 px-3 py-2 rounded-md transition-colors ${location.pathname === '/epg-admin' ? 'bg-accent text-accent-foreground' : 'hover:bg-accent hover:text-accent-foreground'
                            }`}
                    >
                        <Activity size={20} className="text-primary" />
                        <span>Global EPG Sources</span>
                    </Link>

                    <Link
                        to="/live-epg"
                        className={`flex items-center gap-3 px-3 py-2 rounded-md transition-colors ${location.pathname === '/live-epg' ? 'bg-accent text-accent-foreground' : 'hover:bg-accent hover:text-accent-foreground'
                            }`}
                    >
                        <Globe size={20} className="text-primary" />
                        <span>Playlist EPG Mapping</span>
                    </Link>

                    <Link
                        to="/tmdb-fixes"
                        className={`flex items-center gap-3 px-3 py-2 rounded-md transition-colors ${location.pathname === '/tmdb-fixes' ? 'bg-accent text-accent-foreground' : 'hover:bg-accent hover:text-accent-foreground'
                            }`}
                    >
                        <Tags size={20} className="text-primary" />
                        <span>TMDB Fixes</span>
                    </Link>

                    <Link
                        to="/xtreamtv/scheduling"
                        className={`flex items-center gap-3 px-3 py-2 rounded-md transition-colors ${location.pathname === '/xtreamtv/scheduling' ? 'bg-accent text-accent-foreground' : 'hover:bg-accent hover:text-accent-foreground'
                            }`}
                    >
                        <Settings size={20} className="text-primary" />
                        <span>Auto-Sync Schedule</span>
                    </Link>

                    <div className="h-4" />

                    {/* Downloads Group */}
                    <div>
                        <button
                            onClick={() => setDownloadsExpanded(!downloadsExpanded)}
                            className={`w-full flex items-center justify-between gap-3 px-3 py-2 rounded-md transition-colors ${isDownloadsActive ? 'bg-accent/50 text-accent-foreground' : 'hover:bg-accent hover:text-accent-foreground'
                                }`}
                        >
                            <div className="flex items-center gap-3 text-sm font-semibold uppercase tracking-wider text-muted-foreground/70">
                                <span>Downloads</span>
                            </div>
                            {downloadsExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                        </button>
                        {downloadsExpanded && (
                            <div className="ml-2 mt-1 space-y-1">
                                <Link
                                    to="/downloads/selection"
                                    className={`flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors ${location.pathname === '/downloads/selection' ? 'bg-accent text-accent-foreground' : 'hover:bg-accent hover:text-accent-foreground'
                                        }`}
                                >
                                    <Plus size={16} />
                                    <span>Media Selection</span>
                                </Link>
                                <Link
                                    to="/downloads/monitored"
                                    className={`flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors ${location.pathname === '/downloads/monitored' ? 'bg-accent text-accent-foreground' : 'hover:bg-accent hover:text-accent-foreground'
                                        }`}
                                >
                                    <Activity size={16} />
                                    <span>Active Surveillance</span>
                                </Link>
                                <Link
                                    to="/downloads/manager"
                                    className={`flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors ${location.pathname === '/downloads/manager' ? 'bg-accent text-accent-foreground' : 'hover:bg-accent hover:text-accent-foreground'
                                        }`}
                                >
                                    <Download size={16} />
                                    <span>Download Manager</span>
                                </Link>
                            </div>
                        )}
                    </div>

                    <div className="h-4" />

                    {/* System Section */}
                    <div className="px-3 text-sm font-semibold uppercase tracking-wider text-muted-foreground/70 mb-2">
                        System
                    </div>

                    <Link
                        to="/admin"
                        className={`flex items-center gap-3 px-3 py-2 rounded-md transition-colors ${location.pathname === '/admin' ? 'bg-accent text-accent-foreground' : 'hover:bg-accent hover:text-accent-foreground'
                            }`}
                    >
                        <Settings size={20} />
                        <span>Administration</span>
                    </Link>

                    <Link
                        to="/logs"
                        className={`flex items-center gap-3 px-3 py-2 rounded-md transition-colors ${location.pathname === '/logs' ? 'bg-accent text-accent-foreground' : 'hover:bg-accent hover:text-accent-foreground'
                            }`}
                    >
                        <FileText size={20} />
                        <span>Logs</span>
                    </Link>

                    {/* Logout */}
                    <button
                        onClick={handleLogout}
                        className="w-full flex items-center gap-3 px-3 py-2 rounded-md transition-colors hover:bg-red-500/10 text-red-500 mt-4"
                    >
                        <LogOut size={20} />
                        <span>Logout</span>
                    </button>
                </nav>

                <div className="mt-auto pt-4 border-t border-border">
                    <div className="flex items-center gap-2 text-sm text-muted-foreground px-3">
                        <Activity size={16} />
                        <span>v4.5.2</span>
                    </div>
                </div>
            </aside>

            {/* Main Content */}
            <main className="flex-1 p-4 lg:p-8 overflow-auto w-full lg:w-auto pt-16 lg:pt-8">
                {children}
            </main>
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
