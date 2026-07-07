'use client'

import * as React from 'react'
import { Moon, Sun, Laptop, Check } from 'lucide-react'
import { useTheme } from 'next-themes'

import { Button } from '@/components/ui/button'
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'

const THEMES = [
    { id: 'light', label: 'Light', icon: Sun },
    { id: 'dark', label: 'Dark', icon: Moon },
    { id: 'system', label: 'System', icon: Laptop },
] as const

export function ThemeToggle({ className }: { className?: string }) {
    const { theme, setTheme } = useTheme()

    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <Button
                    variant="ghost"
                    size="icon"
                    className={cn(
                        'h-9 w-9 rounded-xl border border-border/60 text-muted-foreground hover:text-foreground hover:bg-secondary/50',
                        className
                    )}
                >
                    <Sun className="h-[1rem] w-[1rem] rotate-0 scale-100 transition-all dark:-rotate-90 dark:scale-0" />
                    <Moon className="absolute h-[1rem] w-[1rem] rotate-90 scale-0 transition-all dark:rotate-0 dark:scale-100" />
                    <span className="sr-only">Toggle theme</span>
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44 rounded-xl p-1.5 border-border/60">
                {THEMES.map((t) => {
                    const Icon = t.icon
                    const active = theme === t.id
                    return (
                        <DropdownMenuItem
                            key={t.id}
                            onClick={() => setTheme(t.id)}
                            className={cn(
                                'rounded-lg px-2.5 py-2 cursor-pointer flex items-center justify-between',
                                active && 'bg-primary/10 text-primary'
                            )}
                        >
                            <span className="flex items-center gap-2 text-sm font-semibold">
                                <Icon className="h-4 w-4" />
                                {t.label}
                            </span>
                            {active && <Check className="h-4 w-4" />}
                        </DropdownMenuItem>
                    )
                })}
            </DropdownMenuContent>
        </DropdownMenu>
    )
}

