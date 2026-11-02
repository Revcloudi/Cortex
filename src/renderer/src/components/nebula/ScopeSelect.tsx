import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown } from 'lucide-react'
import { useI18n } from '@renderer/i18n'
import { cn } from '@renderer/lib/utils'

export interface ScopeSelectOption {
  value: string
  label: string
}

export interface ScopeSelectProps {
  id?: string
  value: string | null
  options: readonly ScopeSelectOption[]
  onChange: (value: string) => void
  disabled?: boolean
  /** Accessible name for the trigger and the listbox. */
  ariaLabel: string
  className?: string
}

interface DropdownPosition {
  top: number
  left: number
  width: number
}

/**
 * Dark themed dropdown that replaces the native `<select>` in the nebula
 * control panel. Native option lists cannot be styled consistently (they fall
 * back to the OS menu), so the trigger is a styled button and the list is
 * rendered in a portal that matches the glass panel.
 *
 * Keyboard: Enter/Space/ArrowUp/ArrowDown open, arrows/Home/End move, Enter or
 * Space select, Escape closes. Mouse: click toggles, hover highlights, an
 * outside click / scroll / resize closes.
 */
export function ScopeSelect({
  id,
  value,
  options,
  onChange,
  disabled = false,
  ariaLabel,
  className
}: ScopeSelectProps) {
  const { t } = useI18n()
  const listboxId = useId()
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(-1)
  const [position, setPosition] = useState<DropdownPosition | null>(null)
  const selected = options.find((option) => option.value === value) ?? null
  const isDisabled = disabled || options.length === 0

  const close = useCallback((restoreFocus = false) => {
    setOpen(false)
    setActiveIndex(-1)
    if (restoreFocus) triggerRef.current?.focus()
  }, [])

  const openList = useCallback(() => {
    if (isDisabled) return
    const rect = triggerRef.current?.getBoundingClientRect()
    if (!rect) return
    setPosition({ top: rect.bottom + 6, left: rect.left, width: rect.width })
    setOpen(true)
    const selectedIndex = options.findIndex((option) => option.value === value)
    setActiveIndex(selectedIndex >= 0 ? selectedIndex : 0)
  }, [isDisabled, options, value])

  // Close on outside click, Escape, scroll or resize while open.
  useEffect(() => {
    if (!open) return
    const handlePointerDown = (event: MouseEvent): void => {
      const target = event.target as Node | null
      if (target === null) return
      if (triggerRef.current?.contains(target) === true) return
      if (listRef.current?.contains(target) === true) return
      close()
    }
    const handleKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        close(true)
      }
    }
    const handleViewportChange = (): void => close()
    window.addEventListener('mousedown', handlePointerDown, true)
    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('resize', handleViewportChange)
    window.addEventListener('scroll', handleViewportChange, true)
    return () => {
      window.removeEventListener('mousedown', handlePointerDown, true)
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('resize', handleViewportChange)
      window.removeEventListener('scroll', handleViewportChange, true)
    }
  }, [open, close])

  // Keep the highlighted row visible when navigating with the keyboard.
  useEffect(() => {
    if (!open || activeIndex < 0) return
    const row = listRef.current?.querySelector<HTMLElement>(
      `[data-option-index="${activeIndex}"]`
    )
    row?.scrollIntoView({ block: 'nearest' })
  }, [open, activeIndex])

  const selectOption = (option: ScopeSelectOption): void => {
    onChange(option.value)
    close(true)
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (!open) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        openList()
      }
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      close(true)
    } else if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActiveIndex((index) => Math.min(options.length - 1, index + 1))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActiveIndex((index) => Math.max(0, index - 1))
    } else if (event.key === 'Home') {
      event.preventDefault()
      setActiveIndex(0)
    } else if (event.key === 'End') {
      event.preventDefault()
      setActiveIndex(options.length - 1)
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      const option = options[activeIndex]
      if (option !== undefined) selectOption(option)
    }
  }

  return (
    <>
      <button
        ref={triggerRef}
        id={id}
        type="button"
        role="combobox"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        disabled={isDisabled}
        onClick={() => (open ? close() : openList())}
        onKeyDown={handleKeyDown}
        className={cn(
          'flex h-8 w-full items-center gap-2 rounded-md border border-white/10 bg-white/[0.04]',
          'pl-2 pr-2 text-[12px] outline-none transition-colors duration-150',
          'hover:border-white/20 hover:bg-white/[0.06]',
          'focus-visible:border-sky-400/40 focus-visible:bg-white/[0.06] focus-visible:ring-1 focus-visible:ring-sky-400/40',
          'disabled:cursor-not-allowed disabled:opacity-50',
          className
        )}
      >
        <span
          className={cn(
            'min-w-0 flex-1 truncate text-left',
            selected === null ? 'text-white/35' : 'text-white/85'
          )}
        >
          {selected?.label ?? t('nebula.scope.selectPlaceholder')}
        </span>
        <ChevronDown
          aria-hidden="true"
          className={cn(
            'h-3.5 w-3.5 shrink-0 text-white/35 transition-transform duration-150',
            open && 'rotate-180'
          )}
        />
      </button>

      {open && position !== null
        ? createPortal(
            <div
              ref={listRef}
              id={listboxId}
              role="listbox"
              aria-label={ariaLabel}
              className={cn(
                'scrollbar-thin fixed z-[70] max-h-64 overflow-y-auto rounded-md',
                'border border-white/[0.12] bg-[#0b0c10]/[0.98] p-1',
                'shadow-[0_20px_50px_-20px_rgba(0,0,0,0.9)] backdrop-blur-xl'
              )}
              style={{ top: position.top, left: position.left, width: position.width }}
            >
              {options.map((option, index) => {
                const isSelected = option.value === value
                const isHighlighted = index === activeIndex
                return (
                  <button
                    key={option.value}
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    data-option-index={index}
                    onMouseEnter={() => setActiveIndex(index)}
                    onClick={() => selectOption(option)}
                    className={cn(
                      'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[12px]',
                      'transition-colors duration-100',
                      isHighlighted ? 'bg-white/[0.08]' : 'bg-transparent',
                      isSelected ? 'text-sky-200' : 'text-white/70'
                    )}
                  >
                    <span className="min-w-0 flex-1 truncate" title={option.label}>
                      {option.label}
                    </span>
                    {isSelected ? (
                      <Check aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-sky-300" />
                    ) : null}
                  </button>
                )
              })}
            </div>,
            document.body
          )
        : null}
    </>
  )
}
