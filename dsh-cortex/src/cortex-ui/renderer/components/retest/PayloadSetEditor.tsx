import { useMemo, useState } from 'react'
import { Eraser } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@renderer/components/ui/select'
import { useI18n } from '@renderer/i18n'
import type { FuzzMode } from '@renderer/lib/fuzz'
import {
  PAYLOAD_PRESETS,
  parsePayloadLines,
  presetPayloadText,
  usedPayloadSetCount
} from '@renderer/lib/fuzz'
import { cn } from '@renderer/lib/utils'

interface PayloadSetEditorProps {
  /** Number of complete marker pairs in the raw request. */
  positions: number
  mode: FuzzMode
  /** One payload-textarea value per position. */
  values: string[]
  disabled?: boolean
  onChange: (index: number, value: string) => void
  onClear: (index: number) => void
  /** Fill every position with the preset's newline-joined payload list. */
  onApplyPreset: (text: string) => void
}

/**
 * One payload textarea per marker position. Sniper/battering-ram only consume
 * set 1, so the extra per-position editors stay visible but disabled; the
 * values are kept for when the user switches to pitchfork/cluster bomb.
 */
export function PayloadSetEditor({
  positions,
  mode,
  values,
  disabled = false,
  onChange,
  onClear,
  onApplyPreset
}: PayloadSetEditorProps) {
  const { t } = useI18n()
  const [presetId, setPresetId] = useState('')

  const activeSets = usedPayloadSetCount(mode, positions)
  const indexed = useMemo(
    () => Array.from({ length: positions }, (_, index) => index),
    [positions]
  )

  const applyPreset = (nextId: string): void => {
    const text = presetPayloadText(nextId)
    if (text === null) return
    setPresetId(nextId)
    onApplyPreset(text)
  }

  return (
    <section className="rounded-lg border border-border bg-background">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 border-b border-border px-3 py-2">
        <span className="text-[12px] font-medium text-foreground">{t('fuzzer.payload.title')}</span>
        <span className="text-[10px] leading-relaxed text-muted-foreground">{t('fuzzer.payload.hint')}</span>
        <div className="ml-auto flex items-center gap-1.5">
          <span className="text-[10px] text-muted-foreground">{t('fuzzer.payload.preset')}</span>
          <Select value={presetId} onValueChange={applyPreset}>
            <SelectTrigger
              data-testid="fuzzer-payload-preset"
              aria-label={t('fuzzer.payload.presetAria')}
              disabled={disabled || positions === 0}
              className="h-7 w-[148px] text-[11px]"
            >
              <SelectValue placeholder={t('fuzzer.payload.presetPlaceholder')} />
            </SelectTrigger>
            <SelectContent>
              {PAYLOAD_PRESETS.map((preset) => (
                <SelectItem key={preset.id} value={preset.id}>
                  {t(preset.labelKey)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="p-3">
        {positions === 0 ? (
          <p className="rounded-md border border-dashed border-border bg-sidebar/40 px-3 py-4 text-center text-[11px] leading-relaxed text-muted-foreground">
            {t('fuzzer.payload.empty')}
          </p>
        ) : (
          <div className="grid max-h-[248px] gap-2 overflow-y-auto pr-0.5 3xl:grid-cols-2">
            {indexed.map((index) => {
              const value = values[index] ?? ''
              const count = parsePayloadLines(value).length
              const active = index < activeSets
              return (
                <div
                  key={index}
                  data-position={index}
                  data-active={active ? 'true' : 'false'}
                  className={cn(
                    'rounded-md border border-border bg-sidebar/30 p-2',
                    !active && 'opacity-60'
                  )}
                >
                  <div className="mb-1 flex flex-wrap items-center gap-1.5">
                    <span className="text-[10.5px] font-medium text-foreground">
                      {t('fuzzer.payload.position', { n: index + 1 })}
                    </span>
                    <span className="rounded border border-border bg-background px-1 py-0.5 font-mono text-[9.5px] tabular-nums text-muted-foreground">
                      {t('fuzzer.payload.count', { count })}
                    </span>
                    {!active ? (
                      <span className="text-[9.5px] leading-tight text-muted-foreground">
                        {t('fuzzer.payload.firstSetOnly')}
                      </span>
                    ) : null}
                    <Button
                      variant="ghost"
                      size="xs"
                      disabled={disabled || !active}
                      aria-label={t('fuzzer.payload.clearAria', { n: index + 1 })}
                      onClick={() => onClear(index)}
                      className="ml-auto h-5 gap-1 px-1 text-[10px] text-muted-foreground hover:text-foreground"
                    >
                      <Eraser aria-hidden="true" className="h-3 w-3" />
                      {t('fuzzer.payload.clear')}
                    </Button>
                  </div>
                  <textarea
                    data-testid={`fuzzer-payload-${index}`}
                    aria-label={t('fuzzer.payload.setAria', { n: index + 1 })}
                    value={value}
                    disabled={disabled || !active}
                    spellCheck={false}
                    placeholder={'1\n2\n3'}
                    onChange={(event) => onChange(index, event.target.value)}
                    className="min-h-[64px] w-full resize-y rounded-md border border-border bg-background px-2 py-1.5 font-mono text-[11px] leading-relaxed text-foreground placeholder:text-muted-foreground/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed"
                  />
                </div>
              )
            })}
          </div>
        )}
      </div>
    </section>
  )
}
