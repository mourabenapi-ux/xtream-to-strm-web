import { Component, ErrorInfo, ReactNode } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface Props { children: ReactNode; label?: string }
interface State { error: Error | null }

/**
 * Keeps one broken component from blanking the whole screen.
 *
 * Without it a single bad response (the header search once returned a flat
 * list where a grouped one was expected) unmounted the entire app and left a
 * white page with nothing to click. Everything is saved as it is made, so
 * reloading is always safe, and the message says so.
 */
export class ErrorBoundary extends Component<Props, State> {
    state: State = { error: null };

    static getDerivedStateFromError(error: Error): State {
        return { error };
    }

    componentDidCatch(error: Error, info: ErrorInfo) {
        console.error(`${this.props.label ?? 'Screen'} crashed`, error, info.componentStack);
    }

    render() {
        if (!this.state.error) return this.props.children;
        return (
            <div className="flex h-[60vh] items-center justify-center p-6">
                <div className="max-w-md text-center space-y-3">
                    <AlertTriangle className="h-10 w-10 text-destructive mx-auto" />
                    <h2 className="text-lg font-semibold">{this.props.label ?? 'This screen'} hit an error</h2>
                    <p className="text-sm text-muted-foreground">
                        Your changes were saved as you made them. Reloading brings the screen back.
                    </p>
                    <p className="text-xs font-mono text-muted-foreground break-all">{this.state.error.message}</p>
                    <Button onClick={() => window.location.reload()} className="gap-2">
                        <RefreshCw className="h-4 w-4" /> Reload
                    </Button>
                </div>
            </div>
        );
    }
}
