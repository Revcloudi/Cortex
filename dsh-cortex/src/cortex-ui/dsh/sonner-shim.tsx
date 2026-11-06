// Sonner replacement for the shadow-root port.
//
// The original Cortex UI uses `sonner` for toasts. Sonner renders through
// react-dom portals into document.body, which would escape our Shadow DOM and
// lose every style. This shim keeps the public API the renderer uses
// (`Toaster`, `toast.success/error/...`) and renders an equivalent toast stack
// inside the app's own container, matching the original visual options that
// App.tsx passes to <Toaster />.
import { useEffect, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'

type ToastTone = 'default' | 'success' | 'error' | 'warning' | 'info'

interface ToastItem {
  id: number
  message: ReactNode
  description?: ReactNode
  tone: ToastTone
  duration: number
}

type Listener = (item: ToastItem) => void

let nextId = 1
const listeners = new Set<Listener>()
const active: ToastItem[] = []
let defaultDuration = 1000

function emit(item: ToastItem): number {
  active.push(item)
  for (const listener of listeners) listener(item)
  return item.id
}

function dismiss(id?: number): void {
  if (id === undefined) {
    active.length = 0
  } else {
    const index = active.findIndex((item) => item.id === id)
    if (index >= 0) active.splice(index, 1)
  }
  flushDismiss()
}

const dismissListeners = new Set<() => void>()
function flushDismiss(): void {
  for (const listener of dismissListeners) listener()
}

function createToast(tone: ToastTone) {
  const fn = (message: ReactNode, options?: { description?: ReactNode; duration?: number }) =>
    emit({ id: nextId++, message, tone, duration: options?.duration ?? defaultDuration, description: options?.description })
  fn.success = (message: ReactNode, options?: { description?: ReactNode; duration?: number }) =>
    createToast('success')(message, options)
  fn.error = (message: ReactNode, options?: { description?: ReactNode; duration?: number }) =>
    createToast('error')(message, options)
  fn.warning = (message: ReactNode, options?: { description?: ReactNode; duration?: number }) =>
    createToast('warning')(message, options)
  fn.info = (message: ReactNode, options?: { description?: ReactNode; duration?: number }) =>
    createToast('info')(message, options)
  fn.loading = (message: ReactNode) => createToast('info')(message, { duration: 60000 })
  fn.message = fn
  fn.dismiss = dismiss
  return fn
}

export const toast = Object.assign(createToast('default'), {
  success: createToast('success'),
  error: createToast('error'),
  warning: createToast('warning'),
  info: createToast('info'),
  message: createToast('default'),
  dismiss,
})

interface ToasterProps {
  theme?: 'light' | 'dark' | 'system'
  position?: string
  offset?: number | string
  duration?: number
  toastOptions?: {
    style?: CSSProperties
    classNames?: Record<string, string>
  }
  children?: ReactNode
}

/** Visual tone accents matching the original app's neutral toast surface. */
const TONE_BORDER: Record<ToastTone, string> = {
  default: 'hsl(220 14% 91%)',
  success: 'hsl(160 84% 32% / 0.45)',
  error: 'hsl(0 72% 46% / 0.45)',
  warning: 'hsl(38 92% 45% / 0.45)',
  info: 'hsl(174 77% 25% / 0.4)',
}

export function Toaster(props: ToasterProps) {
  const [items, setItems] = useState<ToastItem[]>(() => active.slice())
  useEffect(() => {
    if (typeof props.duration === 'number' && props.duration > 0) defaultDuration = props.duration
    const onAdd = () => setItems(active.slice())
    listeners.add(onAdd)
    dismissListeners.add(onAdd)
    return () => {
      listeners.delete(onAdd)
      dismissListeners.delete(onAdd)
    }
  }, [props.duration])

  useEffect(() => {
    if (items.length === 0) return undefined
    const timers = items.map((item) =>
      window.setTimeout(() => {
        dismiss(item.id)
      }, item.duration),
    )
    return () => {
      for (const timer of timers) window.clearTimeout(timer)
    }
  }, [items])

  const baseStyle: CSSProperties = {
    background: 'hsl(0 0% 100%)',
    color: 'hsl(224 18% 10%)',
    border: '1px solid hsl(220 14% 91%)',
    borderRadius: 10,
    boxShadow: '0 16px 40px -16px rgba(15, 23, 42, 0.22), 0 1px 3px rgba(15, 23, 42, 0.06)',
    fontSize: '12.5px',
    padding: '10px 12px',
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
    minWidth: 220,
    maxWidth: 420,
    pointerEvents: 'auto',
    ...(props.toastOptions?.style ?? {}),
  }

  const offset = props.offset ?? 16
  const bottomLeft = props.position === 'bottom-left'
  const containerStyle: CSSProperties = {
    position: 'fixed',
    zIndex: 80,
    bottom: typeof offset === 'number' ? offset : Number(offset) || 16,
    ...(bottomLeft
      ? { left: typeof offset === 'number' ? offset : Number(offset) || 16 }
      : { right: typeof offset === 'number' ? offset : Number(offset) || 16 }),
    display: 'flex',
    flexDirection: bottomLeft ? 'column-reverse' : 'column',
    gap: 8,
    pointerEvents: 'none',
  }

  if (items.length === 0) return null
  return (
    <div style={containerStyle} aria-live="polite" aria-atomic="false">
      {items.map((item) => (
        <div
          key={item.id}
          role="status"
          data-sonner-toast=""
          style={{ ...baseStyle, borderColor: TONE_BORDER[item.tone] }}
        >
          <div style={{ fontSize: 12.5, fontWeight: 500, color: 'hsl(224 18% 10%)' }}>{item.message}</div>
          {item.description ? (
            <div style={{ fontSize: 11.5, color: 'hsl(220 9% 46%)' }}>{item.description}</div>
          ) : null}
        </div>
      ))}
    </div>
  )
}
