import { FC, useEffect, useState } from 'react';
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Copy, Check, Download, Loader2 } from 'lucide-react';
import api from '@/lib/api';

interface M3UPreviewModalProps {
    isOpen: boolean;
    onClose: () => void;
    playlistId: number | null;
}

const M3UPreviewModal: FC<M3UPreviewModalProps> = ({ isOpen, onClose, playlistId }) => {
    const [content, setContent] = useState<string>("");
    const [loading, setLoading] = useState(false);
    const [copied, setCopied] = useState(false);

    useEffect(() => {
        if (isOpen && playlistId) {
            fetchPreview();
        }
    }, [isOpen, playlistId]);

    const fetchPreview = async () => {
        setLoading(true);
        try {
            const res = await api.get(`/live/playlists/${playlistId}/m3u/preview`);
            setContent(res.data.content);
        } catch (error) {
            console.error("Failed to fetch M3U preview", error);
            setContent("Failed to load preview.");
        } finally {
            setLoading(false);
        }
    };

    const handleCopy = () => {
        navigator.clipboard.writeText(content);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    const handleDownload = () => {
        const blob = new Blob([content], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `playlist_${playlistId}.m3u`;
        a.click();
        URL.revokeObjectURL(url);
    };

    return (
        <Dialog isOpen={isOpen} onClose={onClose} title="M3U Preview">
            <div className="flex flex-col gap-4">
                <div className="flex justify-between items-center bg-muted/30 p-2 rounded border">
                    <p className="text-[10px] text-muted-foreground italic max-w-[60%]">
                        This preview reflects the current composition of your playlist.
                    </p>
                    <div className="flex gap-2">
                        <Button
                            size="sm"
                            variant="outline"
                            className={`h-8 text-[11px] ${copied ? 'border-emerald-500/40 text-emerald-600' : ''}`}
                            onClick={handleCopy}
                            disabled={!content || loading}
                        >
                            {copied
                                ? <><Check className="h-3.5 w-3.5 mr-1.5" /> Copied</>
                                : <><Copy className="h-3.5 w-3.5 mr-1.5" /> Copy</>}
                        </Button>
                        <Button size="sm" variant="outline" className="h-8 text-[11px]" onClick={handleDownload} disabled={!content || loading}>
                            <Download className="h-3.5 w-3.5 mr-1.5" /> Download
                        </Button>
                    </div>
                </div>

                <div className="overflow-auto bg-slate-950 p-4 rounded-md border border-indigo-500/20 text-slate-300 font-mono text-[11px] min-h-[400px] max-h-[550px] scrollbar-thin scrollbar-thumb-indigo-500/20">
                    {loading ? (
                        <div className="flex flex-col items-center justify-center h-[400px] gap-3">
                            <Loader2 className="h-8 w-8 animate-spin text-indigo-500" />
                            <span className="text-muted-foreground animate-pulse text-xs">Generating playlist preview...</span>
                        </div>
                    ) : (
                        <pre className="whitespace-pre-wrap leading-relaxed">
                            {content || "No items in playlist."}
                        </pre>
                    )}
                </div>

                <div className="flex justify-end">
                    <Button variant="secondary" size="sm" onClick={onClose} className="text-xs h-8">
                        Close
                    </Button>
                </div>
            </div>
        </Dialog>
    );
};

export default M3UPreviewModal;
