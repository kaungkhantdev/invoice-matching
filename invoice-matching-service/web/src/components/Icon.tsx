import type { Ref } from "react";

/** SVG path data for each icon, drawn on a 24 × 24 grid. */
const ICONS = {
  logo: ["M4 7h16M4 12h16M4 17h10"],
  invoice: ["M7 3h7l5 5v13H7z", "M14 3v5h5M10 13h6M10 17h6"],
  search: ["M17 11a6 6 0 1 1-12 0 6 6 0 0 1 12 0z", "m20 20-4.2-4.2"],
  recheck: ["M20 11a8 8 0 1 0-2.3 5.7", "M20 4v7h-7"],
  link: ["M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1", "M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"],
  eye: ["M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z", "M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z"],
  close: ["M6 6l12 12", "M18 6 6 18"],
} as const;

type IconName = keyof typeof ICONS;

/** A line icon, hidden from screen readers (the button or link around it carries the text). */
export function Icon({ name }: { name: IconName }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      {ICONS[name].map((path) => (
        <path key={path} d={path} />
      ))}
    </svg>
  );
}

interface IconButtonProps {
  icon: IconName;
  /** Read by screen readers; also the tooltip unless `title` is given. */
  label: string;
  title?: string;
  primary?: boolean;
  disabled?: boolean;
  onClick: () => void;
  ref?: Ref<HTMLButtonElement>;
}

/** A square button showing only an icon (the label is for screen readers). */
export function IconButton({ icon, label, title = label, primary = false, disabled, onClick, ref }: IconButtonProps) {
  const className = `icon-btn${primary ? " primary" : ""}`;
  return (
    <button ref={ref} type="button" className={className} title={title} disabled={disabled} onClick={onClick}>
      <Icon name={icon} />
      <span className="sr-only">{label}</span>
    </button>
  );
}
