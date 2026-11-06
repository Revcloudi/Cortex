import { cva, type VariantProps } from 'class-variance-authority'
import { forwardRef, type ButtonHTMLAttributes } from 'react'
import { cn } from '@renderer/lib/utils'

const buttonVariants = cva(
  'inline-flex select-none items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        primary: 'bg-foreground text-background hover:bg-[hsl(var(--foreground)/0.9)]',
        outline: 'border border-border bg-background text-foreground hover:bg-muted',
        ghost: 'text-muted-foreground hover:bg-muted hover:text-foreground',
        subtle: 'bg-secondary text-secondary-foreground hover:bg-muted',
        destructive:
          'bg-destructive text-destructive-foreground hover:bg-[hsl(var(--destructive)/0.92)]'
      },
      size: {
        default: 'h-9 px-3.5 text-[13px]',
        sm: 'h-8 px-3 text-[12.5px]',
        xs: 'h-7 px-2 text-[11.5px]',
        icon: 'h-8 w-8',
        'icon-sm': 'h-7 w-7'
      }
    },
    defaultVariants: {
      variant: 'outline',
      size: 'default'
    }
  }
)

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, type = 'button', ...props }, ref) => (
    <button ref={ref} type={type} className={cn(buttonVariants({ variant, size }), className)} {...props} />
  )
)
Button.displayName = 'Button'

export { buttonVariants }
