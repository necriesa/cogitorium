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

export const CloseIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="m4.5 4.5 7 7M11.5 4.5l-7 7" />
  </Svg>
);

/** Vault: a folder with a clasp. */
export const VaultIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M2 4.5c0-.6.4-1 1-1h3l1.5 1.5H13c.6 0 1 .4 1 1V12c0 .6-.4 1-1 1H3c-.6 0-1-.4-1-1Z" />
    <path d="M8 8v2.5" />
  </Svg>
);

/** Quill: vane, shaft and nib. */
export const QuillIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M13.5 2.5C9 3 5.5 6.5 4.5 11l1 .5C9.5 10.5 12.5 7 13.5 2.5Z" />
    <path d="M5.5 11.5 3 14M7 9l3-3" />
  </Svg>
);

/** Hourglass in a frame. */
export const HourglassIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3.5 2h9M3.5 14h9M5 2c0 3 3 4 3 6s-3 3-3 6M11 2c0 3-3 4-3 6s3 3 3 6" />
  </Svg>
);
