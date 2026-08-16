import React from "react"
import { Check } from "lucide-react"
import { cn } from "@/lib/utils"

export interface CheckboxProps
    extends React.InputHTMLAttributes<HTMLInputElement> {
    onCheckedChange?: (checked: boolean) => void
}

const Checkbox = React.forwardRef<HTMLInputElement, CheckboxProps>(
    ({ className, onCheckedChange, ...props }, ref) => {
        return (
            <div className="relative flex items-center">
                <input
                    type="checkbox"
                    className={cn(
                        "peer h-4 w-4 shrink-0 rounded-sm border border-primary ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 appearance-none bg-background",
                        className
                    )}
                    ref={ref}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => onCheckedChange?.(e.target.checked)}
                    {...props}
                />
                <Check className="absolute h-3 w-3 text-primary opacity-0 peer-checked:opacity-100 pointer-events-none left-0.5" />
            </div>
        )
    }
)
Checkbox.displayName = "Checkbox"

export { Checkbox }
