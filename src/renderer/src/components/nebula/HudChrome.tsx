import {
  forwardRef,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type ReactNode
} from 'react'
import { HUD_OVERLAY, NEBULA_UI } from '@renderer/lib/graphTheme'
import { cn } from '@renderer/lib/utils'

/**
 * J.A.R.V.I.S. tactical HUD chrome primitives.
 *
 * These are the only shared visual building blocks of the redesigned Memory
 * Nebula: a full-bleed holographic backdrop (40px cyan grid, 6s scanline, four
 * 20px corner brackets, soft vignette) plus the glass panel / stat / button /
 * kbd recipes every HUD surface composes. All motion is disabled by
 * `prefers-reduced-motion` through a scoped stylesheet, so the panels do not
 * need their own media-query logic.
 *
 * The components are intentionally dumb and unthemed beyond the graphTheme HUD
 * tokens; layout and behaviour stay with the page / panel owners.
 */

const HUD_STYLE_ELEMENT_ID = 'nebula-hud-keyframes'

function HudMotionStyles() {
  return (
    <style id={HUD_STYLE_ELEMENT_ID}>{`
      @keyframes nebula-hud-scan {
        0% { transform: translate3d(0, -4px, 0); opacity: 0; }
        8% { opacity: 1; }
        92% { opacity: 1; }
        100% { transform: translate3d(0, 100vh, 0); opacity: 0; }
      }
      @keyframes nebula-hud-flicker {
        0%, 100% { opacity: 0.55; }
        50% { opacity: 0.85; }
      }
      @keyframes nebula-hud-pulse {
        0%, 100% { opacity: 0.35; }
        50% { opacity: 0.9; }
      }
      .nebula-hud-scanline {
        animation: nebula-hud-scan ${HUD_OVERLAY.scanlineDurationMs}ms linear infinite;
      }
      .nebula-hud-flicker { animation: nebula-hud-flicker 4s ease-in-out infinite; }
      .nebula-hud-pulse { animation: nebula-hud-pulse 2.4s ease-in-out infinite; }
      @media (prefers-reduced-motion: reduce) {
        .nebula-hud-scanline,
        .nebula-hud-flicker,
        .nebula-hud-pulse { animation: none; }
        .nebula-hud-scanline { opacity: 0; }
      }
    `}</style>
  )
}

/** Full-bleed decorative HUD backdrop (grid + scanline + corners + vignette). */
export function HudBackdrop({ className }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      data-hud="backdrop"
      className={cn('pointer-events-none absolute inset-0 z-10 overflow-hidden', className)}
    >
      <HudMotionStyles />
      {/* 40px cyan holo grid */}
      <div
        className="absolute inset-0"
        style={{
          backgroundImage: `linear-gradient(${HUD_OVERLAY.gridColor} 1px, transparent 1px), linear-gradient(90deg, ${HUD_OVERLAY.gridColor} 1px, transparent 1px)`,
          backgroundSize: `${HUD_OVERLAY.gridSizePx}px ${HUD_OVERLAY.gridSizePx}px`,
          backgroundPosition: 'center center'
        }}
      />
      {/* Slow horizontal scanline with cyan bloom */}
      <div className="absolute inset-x-0 top-0 h-px overflow-visible">
        <div
          className="nebula-hud-scanline absolute inset-x-0 top-0 h-px"
          style={{
            background: `linear-gradient(90deg, transparent 0%, ${HUD_OVERLAY.scanlineColor} 18%, ${HUD_OVERLAY.scanlineColor} 82%, transparent 100%)`,
            boxShadow: `0 0 20px ${HUD_OVERLAY.scanlineGlow}`
          }}
        />
      </div>
      {/* Vignette keeps the eye on the graph centre */}
      <div className="absolute inset-0" style={{ background: HUD_OVERLAY.vignette }} />
      <HudCorners />
    </div>
  )
}

/** Four 20px cyan viewfinder brackets pinned to the page corners. */
export function HudCorners({ className }: { className?: string }) {
  const base = 'absolute h-5 w-5 border-2 border-[#00E5FF]/40'
  return (
    <div aria-hidden="true" className={cn('pointer-events-none absolute inset-0', className)}>
      <span className={cn(base, 'left-5 top-5 border-b-0 border-r-0')} />
      <span className={cn(base, 'right-5 top-5 border-b-0 border-l-0')} />
      <span className={cn(base, 'bottom-5 left-5 border-r-0 border-t-0')} />
      <span className={cn(base, 'bottom-5 right-5 border-l-0 border-t-0')} />
    </div>
  )
}

export interface HudPanelProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode
  /** Left 2px cyan accent bar (reference HUD panel signature). */
  accent?: boolean
}

/** Translucent navy glass panel with the HUD border + optional left accent bar. */
export function HudPanel({ children, className, accent = true, ...rest }: HudPanelProps) {
  return (
    <div
      {...rest}
      className={cn(
        NEBULA_UI.glass,
        NEBULA_UI.panelRadius,
        'relative overflow-hidden',
        accent &&
          "before:pointer-events-none before:absolute before:inset-y-0 before:left-0 before:w-[2px] before:bg-[#00E5FF]/70 before:content-['']",
        className
      )}
    >
      {children}
    </div>
  )
}

export interface HudPanelHeaderProps {
  /** Section title, rendered uppercase with wide tracking. */
  title: ReactNode
  /** Secondary line, e.g. a live status or item count. */
  meta?: ReactNode
  /** Right-aligned controls (icon buttons). */
  actions?: ReactNode
  className?: string
}

/** Panel header: `// TITLE` + meta + optional right-aligned controls. */
export function HudPanelHeader({ title, meta, actions, className }: HudPanelHeaderProps) {
  return (
    <div className={cn('flex items-start justify-between gap-2 px-3 pt-2.5', className)}>
      <div className="min-w-0">
        <h2 className={cn(NEBULA_UI.heading, 'flex items-center gap-1.5 font-semibold')}>
          <span aria-hidden="true" className="text-[#00E5FF]/50">
            //
          </span>
          <span className="truncate">{title}</span>
        </h2>
        {meta !== undefined ? (
          <p className={cn(NEBULA_UI.muted, 'mt-1 truncate text-[11px]')}>{meta}</p>
        ) : null}
      </div>
      {actions !== undefined ? (
        <div className="flex shrink-0 items-center gap-1">{actions}</div>
      ) : null}
    </div>
  )
}

/** Small uppercase section label with a hairline rule. */
export function HudSectionTitle({
  children,
  trailing,
  className
}: {
  children: ReactNode
  trailing?: ReactNode
  className?: string
}) {
  return (
    <div className={cn('flex items-center gap-2', className)}>
      <span className={cn(NEBULA_UI.label, 'shrink-0 text-[#7FA9BE]')}>{children}</span>
      <span aria-hidden="true" className="h-px min-w-0 flex-1 bg-[#00E5FF]/10" />
      {trailing !== undefined ? (
        <span className={cn(NEBULA_UI.label, 'shrink-0 text-[#5C8FAE]')}>{trailing}</span>
      ) : null}
    </div>
  )
}

export type HudStatTone = 'default' | 'cyan' | 'danger' | 'warning' | 'success' | 'white'

const STAT_TONE_CLASS: Record<HudStatTone, string> = {
  default: 'text-[#C7E9F5]',
  cyan: 'text-[#00E5FF]',
  danger: 'text-[#FF3366]',
  warning: 'text-[#FFAA00]',
  success: 'text-[#10B981]',
  white: 'text-white'
}

/** `LABEL  VALUE` HUD statistic row. */
export function HudStat({
  label,
  value,
  tone = 'default',
  className
}: {
  label: ReactNode
  value: ReactNode
  tone?: HudStatTone
  className?: string
}) {
  return (
    <div className={cn('flex items-baseline justify-between gap-2 leading-none', className)}>
      <span className={cn(NEBULA_UI.label, 'truncate')}>{label}</span>
      <span
        className={cn(
          'shrink-0 font-mono text-[13px] font-semibold tabular-nums tracking-[0.03em]',
          STAT_TONE_CLASS[tone]
        )}
      >
        {value}
      </span>
    </div>
  )
}

export type HudButtonVariant = 'ghost' | 'primary' | 'danger'
export type HudButtonSize = 'sm' | 'md' | 'icon'

const BUTTON_SIZE_CLASS: Record<HudButtonSize, string> = {
  sm: 'h-7 px-2 text-[10.5px]',
  md: 'h-8 px-3 text-[11px]',
  icon: 'h-7 w-7 p-0'
}

/** HUD button: cyan hairline, mono uppercase, keyboard focus ring included. */
export const HudButton = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: HudButtonVariant
    size?: HudButtonSize
  }
>(function HudButton({ variant = 'ghost', size = 'md', className, type = 'button', ...rest }, ref) {
  const variantClass =
    variant === 'primary'
      ? NEBULA_UI.buttonPrimary
      : variant === 'danger'
        ? NEBULA_UI.buttonDanger
        : NEBULA_UI.button
  return (
    <button
      ref={ref}
      type={type}
      className={cn(variantClass, BUTTON_SIZE_CLASS[size], NEBULA_UI.focusRing, className)}
      {...rest}
    />
  )
})

/** Inline keyboard hint. */
export function HudKbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      className={cn(
        'inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-[2px] border border-[#00E5FF]/25 bg-[#00E5FF]/[0.06] px-1 font-mono text-[10px] leading-none text-[#9BC1D2]',
        className
      )}
    >
      {children}
    </kbd>
  )
}

/** Hairline divider matching the panel border colour. */
export function HudDivider({ className }: { className?: string }) {
  return <div aria-hidden="true" className={cn('h-px w-full bg-[#00E5FF]/[0.12]', className)} />
}

/** Status dot + label (ONLINE / SYNCING / OFFLINE). */
export function HudStatusDot({
  tone = 'cyan',
  pulse = true,
  className
}: {
  tone?: 'cyan' | 'danger' | 'warning' | 'success'
  pulse?: boolean
  className?: string
}) {
  const color =
    tone === 'danger'
      ? 'bg-[#FF3366] shadow-[0_0_8px_rgba(255,51,102,0.8)]'
      : tone === 'warning'
        ? 'bg-[#FFAA00] shadow-[0_0_8px_rgba(255,170,0,0.8)]'
        : tone === 'success'
          ? 'bg-[#10B981] shadow-[0_0_8px_rgba(16,185,129,0.8)]'
          : 'bg-[#00E5FF] shadow-[0_0_8px_rgba(0,229,255,0.8)]'
  return (
    <span
      aria-hidden="true"
      className={cn('inline-block h-1.5 w-1.5 rounded-full', color, pulse && 'nebula-hud-pulse', className)}
    />
  )
}
