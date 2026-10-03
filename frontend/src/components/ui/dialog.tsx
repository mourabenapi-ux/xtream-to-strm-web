import React, { useEffect } from "react"
import { X } from "lucide-react"

interface DialogProps {
    isOpen: boolean
    onClose: () => void
    title: string
    children: React.ReactNode
    /** Wider panel for lists and tables. */
    size?: "md" | "lg" | "xl"
}

const WIDTH = { md: "max-w-lg", lg: "max-w-2xl", xl: "max-w-4xl" }

export function Dialog({ isOpen, onClose, title, children, size = "md" }: DialogProps) {
    // Escape closes every dialog: it used to do nothing, which left the search
    // results and the guide mapping open until the mouse found the cross.
    useEffect(() => {
        if (!isOpen) return
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") {
                e.stopPropagation()
                onClose()
            }
        }
        window.addEventListener("keydown", onKey)
        return () => window.removeEventListener("keydown", onKey)
    }, [isOpen, onClose])

    if (!isOpen) return null

    return (
        // The panel is bounded by the overlay (max-h-full), not by 80vh: on a
        // phone 80vh plus the title bar was taller than the visible screen,
        // and the buttons at the bottom of a dialog could not be reached.
        <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-black/50 backdrop-blur-sm animate-in fade-in duration-200">
            <div role="dialog" aria-modal="true" aria-label={title}
                className={`bg-background border rounded-lg shadow-xl w-full ${WIDTH[size]} max-h-full flex flex-col overflow-hidden animate-in zoom-in-95 duration-200`}>
                <div className="flex items-center justify-between gap-2 p-4 border-b flex-shrink-0">
                    <h3 className="text-lg font-semibold">{title}</h3>
                    <button
                        onClick={onClose}
                        className="rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none"
                    >
                        <X className="h-4 w-4" />
                        <span className="sr-only">Close</span>
                    </button>
                </div>
                <div className="p-4 overflow-y-auto overscroll-contain min-h-0 sm:max-h-[80vh]">
                    {children}
                </div>
            </div>
        </div>
    )
}
