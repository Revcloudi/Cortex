import { forwardRef, useEffect, useImperativeHandle, useRef, type InputHTMLAttributes } from 'react'
import { cn } from '@renderer/lib/utils'

interface CheckboxProps extends InputHTMLAttributes<HTMLInputElement> {
  indeterminate?: boolean
}

/**
 * Native checkbox styled with the app accent. Native input keeps keyboard and
 * screen-reader semantics; `indeterminate` is applied via the DOM property.
 */
export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(
  ({ className, indeterminate = false, ...props }, ref) => {
    const innerRef = useRef<HTMLInputElement>(null)
    useImperativeHandle(ref, () => innerRef.current as HTMLInputElement, [])

    useEffect(() => {
      if (innerRef.current) innerRef.current.indeterminate = indeterminate
    }, [indeterminate])

    return (
      <input
        ref={innerRef}
        type="checkbox"
        className={cn(
          'h-3.5 w-3.5 shrink-0 cursor-pointer accent-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50',
          className
        )}
        {...props}
      />
    )
  }
)
Checkbox.displayName = 'Checkbox'
