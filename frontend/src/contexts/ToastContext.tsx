import { createContext, useCallback, useContext, useMemo, useRef, useState, FC, ReactNode } from 'react';
import { CheckCircle2, AlertCircle, Info, X, AlertTriangle } from 'lucide-react';

export type ToastVariant = 'success' | 'error' | 'info' | 'warning';

interface Toast {
    id: number;
    variant: ToastVariant;
    title: string;
    description?: string;
}

interface ToastContextValue {
    toast: (variant: ToastVariant, title: string, description?: string) => void;
    success: (title: string, description?: string) => void;
    error: (title: string, description?: string) => void;
    info: (title: string, description?: string) => void;
    warning: (title: string, description?: string) => void;
    /** Extracts a readable message from an axios error and shows it. */
    apiError: (title: string, err: unknown) => void;
}

const ToastContext = createContext<ToastContextValue | undefined>(undefined);

// Pulls a human-readable message out of whatever the backend returned.
// FastAPI sends `detail` as a string, or as a list of validation objects.
export function describeApiError(err: any): string | undefined {
    const detail = err?.response?.data?.detail;
    if (typeof detail === 'string') return detail;
    if (Array.isArray(detail)) {
        const first = detail[0];
        if (typeof first === 'string') return first;
        if (first?.msg) return String(first.msg);
    }
    if (err?.message) return String(err.message);
    return undefined;
}

const AUTO_DISMISS_MS: Record<ToastVariant, number> = {
    success: 3500,
    info: 4000,
    warning: 6000,
    error: 8000,
};

export const ToastProvider: FC<{ children: ReactNode }> = ({ children }) => {
    const [toasts, setToasts] = useState<Toast[]>([]);
    const nextId = useRef(1);

    const dismiss = useCallback((id: number) => {
        setToasts(prev => prev.filter(t => t.id !== id));
    }, []);

    const toast = useCallback((variant: ToastVariant, title: string, description?: string) => {
        const id = nextId.current++;
        setToasts(prev => [...prev, { id, variant, title, description }]);
        setTimeout(() => dismiss(id), AUTO_DISMISS_MS[variant]);
    }, [dismiss]);

    const value = useMemo<ToastContextValue>(() => ({
        toast,
        success: (title, description) => toast('success', title, description),
        error: (title, description) => toast('error', title, description),
        info: (title, description) => toast('info', title, description),
        warning: (title, description) => toast('warning', title, description),
        apiError: (title, err) => toast('error', title, describeApiError(err)),
    }), [toast]);

    return (
        <ToastContext.Provider value={value}>
            {children}
            <Toaster toasts={toasts} onDismiss={dismiss} />
        </ToastContext.Provider>
    );
};

export function useToast(): ToastContextValue {
    const ctx = useContext(ToastContext);
    if (!ctx) throw new Error('useToast must be used inside a ToastProvider');
    return ctx;
}

const VARIANT_STYLES: Record<ToastVariant, { icon: JSX.Element; frame: string }> = {
    success: {
        icon: <CheckCircle2 className="h-5 w-5 text-emerald-500" />,
        frame: 'border-emerald-500/30 bg-emerald-500/10',
    },
    error: {
        icon: <AlertCircle className="h-5 w-5 text-destructive" />,
        frame: 'border-destructive/30 bg-destructive/10',
    },
    warning: {
        icon: <AlertTriangle className="h-5 w-5 text-amber-500" />,
        frame: 'border-amber-500/30 bg-amber-500/10',
    },
    info: {
        icon: <Info className="h-5 w-5 text-primary" />,
        frame: 'border-primary/30 bg-primary/10',
    },
};

const Toaster: FC<{ toasts: Toast[]; onDismiss: (id: number) => void }> = ({ toasts, onDismiss }) => {
    if (toasts.length === 0) return null;

    return (
        <div
            className="fixed bottom-4 right-4 z-[100] flex flex-col gap-2 w-[min(24rem,calc(100vw-2rem))]"
            role="status"
            aria-live="polite"
        >
            {toasts.map(t => {
                const style = VARIANT_STYLES[t.variant];
                return (
                    <div
                        key={t.id}
                        className={`flex items-start gap-3 p-3 rounded-lg border shadow-lg backdrop-blur-sm bg-card ${style.frame} animate-in slide-in-from-bottom-2 fade-in duration-200`}
                    >
                        <div className="flex-shrink-0 mt-0.5">{style.icon}</div>
                        <div className="flex-1 min-w-0">
                            <div className="text-sm font-semibold">{t.title}</div>
                            {t.description && (
                                <div className="text-xs text-muted-foreground mt-0.5 break-words">{t.description}</div>
                            )}
                        </div>
                        <button
                            onClick={() => onDismiss(t.id)}
                            className="flex-shrink-0 opacity-50 hover:opacity-100 transition-opacity"
                            aria-label="Dismiss notification"
                        >
                            <X className="h-4 w-4" />
                        </button>
                    </div>
                );
            })}
        </div>
    );
};
