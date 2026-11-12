/**
 * Small line icons drawn on a 16px grid (1.5px strokes, currentColor), so the
 * title bar and buttons use real icons instead of Unicode glyphs or emoji.
 */
type IconProps = { size?: number; className?: string };

function Svg({ size = 16, className, children }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export const PinIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6 2.5h4M7 2.5v4L4.5 9h7L9 6.5v-4M8 9v4.5" />
  </Svg>
);

export const MinimiseIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 8.5h8" />
  </Svg>
);

/** Maximise: one square. */
export const MaximiseIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3.5" y="3.5" width="9" height="9" rx="1" />
  </Svg>
);

/** Restore: two overlapping squares. */
export const RestoreIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3" y="5.5" width="7.5" height="7.5" rx="1" />
    <path d="M5.5 5.5V4a1 1 0 0 1 1-1H12a1 1 0 0 1 1 1v5.5a1 1 0 0 1-1 1h-1.5" />
  </Svg>
);

export const CloseIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="m4.5 4.5 7 7M11.5 4.5l-7 7" />
  </Svg>
);

/** Cogitator: a brain, flesh on the left and a circuit node on the right. */
export const CogitatorIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8 3.2C6.9 2.3 5 2.5 4.4 3.7 3 3.8 2.3 5 2.6 6.2 1.8 7 1.9 8.4 2.7 9.1 2.6 10.6 3.7 11.8 5 11.8 5.6 12.9 7 13.2 8 12.6" />
    <path d="M8 3.2V12.6M8 5.5H11V4M8 8.5H12.5M8 11H10.5V12.5" />
    <circle cx="11" cy="3.5" r=".6" />
    <circle cx="13" cy="8.5" r=".6" />
  </Svg>
);

/** Pop out: a window with an arrow leaving it. */
export const PopOutIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9.5 2.5h4v4M13.5 2.5 8 8M12 9.5v3a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h3" />
  </Svg>
);

/** Vault: a folder with a clasp. */
export const VaultIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M2 4.5c0-.6.4-1 1-1h3l1.5 1.5H13c.6 0 1 .4 1 1V12c0 .6-.4 1-1 1H3c-.6 0-1-.4-1-1Z" />
    <path d="M8 8v2.5" />
  </Svg>
);

/** Data stylus: a slim pen with a grip band and a fine tip. */
export const StylusIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M11 2.5 13.5 5 6 12.5 2.5 13.5 3.5 10Z" />
    <path d="M9.5 4 12 6.5M3.5 10l2.5 2.5" />
  </Svg>
);

/** Hourglass in a frame. */
export const HourglassIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3.5 2h9M3.5 14h9M5 2c0 3 3 4 3 6s-3 3-3 6M11 2c0 3-3 4-3 6s3 3 3 6" />
  </Svg>
);
