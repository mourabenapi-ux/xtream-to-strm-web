import { useState, useCallback, useMemo } from 'react';

export function useUndoRedo<T>(initialState: T) {
    const [history, setHistory] = useState<T[]>([initialState]);
    const [currentIndex, setCurrentIndex] = useState(0);

    const canUndo = currentIndex > 0;
    const canRedo = currentIndex < history.length - 1;

    const record = useCallback((newState: T) => {
        setHistory(prev => {
            const newHistory = prev.slice(0, currentIndex + 1);
            // Limit history to 30 items
            if (newHistory.length >= 30) {
                newHistory.shift();
                setCurrentIndex(prevIndex => prevIndex - 1);
            }
            return [...newHistory, newState];
        });
        setCurrentIndex(prev => prev + 1);
    }, [currentIndex]);

    const undo = useCallback(() => {
        if (canUndo) {
            setCurrentIndex(prev => prev - 1);
            return history[currentIndex - 1];
        }
        return null;
    }, [canUndo, currentIndex, history]);

    const redo = useCallback(() => {
        if (canRedo) {
            setCurrentIndex(prev => prev + 1);
            return history[currentIndex + 1];
        }
        return null;
    }, [canRedo, currentIndex, history]);

    const resetHistory = useCallback((newState: T) => {
        setHistory([newState]);
        setCurrentIndex(0);
    }, []);

    return useMemo(() => ({
        state: history[currentIndex],
        record,
        undo,
        redo,
        canUndo,
        canRedo,
        resetHistory
    }), [history, currentIndex, record, undo, redo, canUndo, canRedo, resetHistory]);
}
