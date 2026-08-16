import { FC, ReactNode, useEffect, useState } from 'react';
import { Dialog } from './dialog';
import { Button } from './button';
import { Input } from './input';
import { AlertTriangle } from 'lucide-react';

interface ConfirmDialogProps {
    isOpen: boolean;
    onClose: () => void;
    onConfirm: () => void | Promise<void>;
    title: string;
    /** Main body. Keep it specific — name the thing being acted on. */
    children: ReactNode;
    confirmLabel?: string;
    cancelLabel?: string;
    /** 'default' for reversible actions, 'destructive' for anything that deletes. */
    variant?: 'default' | 'destructive';
    /**
     * When set, the confirm button stays disabled until the user types this
     * exact word. Use it for irreversible, wide-blast-radius actions.
     */
    requireTyped?: string;
    busy?: boolean;
}

export const ConfirmDialog: FC<ConfirmDialogProps> = ({
    isOpen,
    onClose,
    onConfirm,
    title,
    children,
    confirmLabel = 'Confirm',
    cancelLabel = 'Cancel',
    variant = 'default',
    requireTyped,
    busy = false,
}) => {
    const [typed, setTyped] = useState('');

    // Never carry a previous confirmation over to the next dialog.
    useEffect(() => {
        if (!isOpen) setTyped('');
    }, [isOpen]);

    const blocked = Boolean(requireTyped) && typed.trim() !== requireTyped;

    return (
        <Dialog isOpen={isOpen} onClose={onClose} title={title}>
            <div className="space-y-4">
                {variant === 'destructive' ? (
                    <div className="flex gap-3">
                        <AlertTriangle className="h-5 w-5 text-destructive flex-shrink-0 mt-0.5" />
                        <div className="space-y-2 text-sm">{children}</div>
                    </div>
                ) : (
                    <div className="space-y-2 text-sm">{children}</div>
                )}

                {requireTyped && (
                    <div className="p-3 rounded border border-destructive/30 bg-destructive/10 space-y-2">
                        <label className="block text-sm font-medium">
                            Type <span className="font-mono bg-background px-1 rounded">{requireTyped}</span> to confirm:
                        </label>
                        <Input
                            value={typed}
                            onChange={e => setTyped(e.target.value)}
                            placeholder={requireTyped}
                            autoFocus
                        />
                    </div>
                )}

                <div className="flex justify-end gap-2 pt-2">
                    <Button variant="outline" onClick={onClose} disabled={busy}>
                        {cancelLabel}
                    </Button>
                    <Button
                        variant={variant === 'destructive' ? 'destructive' : 'default'}
                        onClick={onConfirm}
                        disabled={blocked || busy}
                    >
                        {busy ? 'Working…' : confirmLabel}
                    </Button>
                </div>
            </div>
        </Dialog>
    );
};
