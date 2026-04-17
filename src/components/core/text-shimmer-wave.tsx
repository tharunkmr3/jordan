'use client'

// ============================================================================
// TextShimmerWave — per-character shimmer wave animation. Ported from
// motion-primitives so we don't pull another dep.
//
// Each character in `children` is wrapped in its own motion.span and
// animated on an infinite loop with a staggered delay, producing a wave
// of color/position/rotation that sweeps left→right.
//
// Tuning knobs (all CSS vars / props):
//   --base-color            resting color of the text
//   --base-gradient-color   color at the wave peak
//   duration                seconds per full cycle
//   spread                  how many characters share a phase (lower = tighter wave)
//   zDistance / yDistance   px of translate at the wave peak
//   scaleDistance           scale multiplier at the peak
//   rotateYDistance         deg of rotateY at the peak
// ============================================================================

import { cn } from '@/lib/utils'
import { motion, type Transition } from 'framer-motion'
import React from 'react'

export type TextShimmerWaveProps = {
  children: string
  as?: keyof React.JSX.IntrinsicElements
  className?: string
  duration?: number
  zDistance?: number
  xDistance?: number
  yDistance?: number
  spread?: number
  scaleDistance?: number
  rotateYDistance?: number
  transition?: Transition
}

export function TextShimmerWave({
  children,
  as = 'p',
  className,
  duration = 1,
  zDistance = 10,
  xDistance = 2,
  yDistance = -2,
  spread = 1,
  scaleDistance = 1.1,
  rotateYDistance = 10,
  transition,
}: TextShimmerWaveProps) {
  const MotionTag = motion[as as keyof typeof motion] as typeof motion.div
  const chars = children.split('')

  return (
    <MotionTag
      className={cn(
        'relative inline-block [perspective:500px]',
        '[--base-color:#a3a3a3] [--base-gradient-color:#2e2e2e]',
        'text-[var(--base-color)]',
        className,
      )}
      style={{ color: 'var(--base-color)' }}
    >
      {chars.map((char, i) => {
        const delay = (i * duration * (1 / spread)) / chars.length
        return (
          <motion.span
            key={i}
            className="inline-block whitespace-pre [transform-style:preserve-3d]"
            initial={{
              translateZ: 0,
              scale: 1,
              rotateY: 0,
              color: 'var(--base-color)',
            }}
            animate={{
              translateZ: [0, zDistance, 0],
              translateX: [0, xDistance, 0],
              translateY: [0, yDistance, 0],
              scale: [1, scaleDistance, 1],
              rotateY: [0, rotateYDistance, 0],
              color: [
                'var(--base-color)',
                'var(--base-gradient-color)',
                'var(--base-color)',
              ],
            }}
            transition={{
              duration,
              repeat: Infinity,
              repeatDelay: (chars.length * 0.05) / spread,
              delay,
              ease: 'easeInOut',
              ...transition,
            }}
          >
            {char}
          </motion.span>
        )
      })}
    </MotionTag>
  )
}
