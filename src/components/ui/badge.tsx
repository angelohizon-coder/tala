import React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "../../lib/utils"

const badgeVariants = cva(
  "inline-flex items-center border rounded-full px-2.5 py-0.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2",
  {
    variants: {
      variant: {
        default: "bg-primary hover:bg-primary/80 border-transparent text-primary-foreground",
        secondary: "bg-slate-100 text-slate-900 border-transparent hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-100",
        outline: "text-foreground",
        cleared: "bg-green-100 text-green-800 border-transparent dark:bg-green-900 dark:text-green-100",
        pending: "bg-amber-100 text-amber-800 border-transparent dark:bg-amber-900 dark:text-amber-100",
        failed: "bg-red-100 text-red-800 border-transparent dark:bg-red-900 dark:text-red-100",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <div className={cn(badgeVariants({ variant }), className)} {...props} />
  )
}

export { Badge, badgeVariants }
