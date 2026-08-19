"use client";

import type { ComponentProps } from "react";
import { ShimmerLabel } from "@/lib/surfaces";
import { cn } from "@/lib/utils";

export type GenerationLoaderVariant = "dots" | "squares" | "rounded";

export interface GenerationLoaderProps
  extends Omit<ComponentProps<"div">, "children"> {
  label: string;
  /** Omit to use the CSS-only animation without scheduling React updates. */
  tick?: number;
  variant?: GenerationLoaderVariant;
}

const CELL_SHAPES: Record<GenerationLoaderVariant, string> = {
  dots: "rounded-full",
  squares: "rounded-[1px]",
  rounded: "rounded-[3px]",
};

export function GenerationLoader({
  label,
  tick,
  variant = "squares",
  className,
  ...props
}: GenerationLoaderProps) {
  const pixelOffset = tick === undefined ? 0 : Math.floor(tick / 3);

  return (
    <div
      data-slot="generation-loader"
      className={cn("flex flex-row items-center gap-2", className)}
      {...props}
    >
      <div aria-hidden className="grid grid-cols-3 gap-0.5">
        {Array.from({ length: 9 }, (_, index) => {
          const active = (index * 2 + pixelOffset) % 9 < 3;
          return (
            <span
              key={index}
              className={cn(
                "bg-foreground size-[4px] transition-opacity duration-300 motion-reduce:transition-none",
                CELL_SHAPES[variant],
                tick === undefined
                  ? "animate-pulse opacity-15 [animation-duration:900ms] motion-reduce:animate-none"
                  : active
                    ? "opacity-90"
                    : "opacity-15",
              )}
              style={
                tick === undefined
                  ? { animationDelay: `${index * 100}ms` }
                  : undefined
              }
            />
          );
        })}
      </div>
      <ShimmerLabel className="text-foreground/55 relative inline-block text-sm/4">
        {label}
      </ShimmerLabel>
    </div>
  );
}
