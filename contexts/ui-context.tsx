'use client'

import { createContext, useContext, useState, useCallback, useMemo, ReactNode } from 'react'

interface UIContextType {
    isInternalSidebarOpen: boolean
    isCollapsed: boolean
    toggleSidebar: () => void
    closeSidebar: () => void
    toggleCollapse: () => void
}

const UIContext = createContext<UIContextType | undefined>(undefined)

export function UIProvider({ children }: { children: ReactNode }) {
    const [isInternalSidebarOpen, setIsInternalSidebarOpen] = useState(false)
    const [isCollapsed, setIsCollapsed] = useState(false)

    const toggleSidebar = useCallback(() => setIsInternalSidebarOpen(prev => !prev), [])
    const closeSidebar = useCallback(() => setIsInternalSidebarOpen(false), [])
    const toggleCollapse = useCallback(() => setIsCollapsed(prev => !prev), [])

    // Memoised so a parent re-render doesn't hand every useUI() consumer a new
    // value object and re-render the whole dashboard chrome with it.
    const value = useMemo(() => ({
        isInternalSidebarOpen,
        isCollapsed,
        toggleSidebar,
        closeSidebar,
        toggleCollapse,
    }), [isInternalSidebarOpen, isCollapsed, toggleSidebar, closeSidebar, toggleCollapse])

    return (
        <UIContext.Provider value={value}>
            {children}
        </UIContext.Provider>
    )
}

export function useUI() {
    const context = useContext(UIContext)
    if (context === undefined) {
        throw new Error('useUI must be used within a UIProvider')
    }
    return context
}
