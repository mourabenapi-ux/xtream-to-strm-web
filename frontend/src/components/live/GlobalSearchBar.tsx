import { FC, useState } from 'react';
import { Input } from "@/components/ui/input";
import { Search, Loader2, X } from 'lucide-react';
import { Button } from "@/components/ui/button";

interface GlobalSearchBarProps {
    onSearch: (query: string) => void;
    isLoading: boolean;
}

const GlobalSearchBar: FC<GlobalSearchBarProps> = ({ onSearch, isLoading }) => {
    const [query, setQuery] = useState("");

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        if (query.trim().length >= 3) {
            onSearch(query.trim());
        }
    };

    return (
        <form onSubmit={handleSubmit} className="relative w-full max-w-sm group">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground group-focus-within:text-primary transition-colors" />
            <Input
                type="text"
                placeholder="Global search (min. 3 chars)..."
                className="pl-9 pr-12 h-9 text-xs bg-muted/20 border-indigo-500/10 focus-visible:ring-indigo-500/30"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
            />
            <div className="absolute right-1 top-1 flex items-center gap-1">
                {query && !isLoading && (
                    <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-muted-foreground"
                        onClick={() => setQuery("")}
                    >
                        <X className="h-3.5 w-3.5" />
                    </Button>
                )}
                <Button
                    type="submit"
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 text-indigo-500 hover:bg-indigo-500/10"
                    disabled={isLoading || query.trim().length < 3}
                >
                    {isLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Search className="h-3.5 w-3.5" />}
                </Button>
            </div>
        </form>
    );
};

export default GlobalSearchBar;
