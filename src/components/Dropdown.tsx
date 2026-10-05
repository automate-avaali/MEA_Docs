"use client";
import { Check, ChevronDown } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { cn } from "./ui";

export type DropdownOption<T extends string> = {
  value: T;
  label: ReactNode; // main line (e.g. native language name)
  sub?: ReactNode; // second line (e.g. English name)
  badge?: ReactNode; // small mono code on the start side (EN / AR / UR)
  dir?: "ltr" | "rtl" | "auto";
};

/**
 * Styled listbox (replaces the native <select>): pill trigger, floating card, keyboard support
 * (↑ ↓ Home End Enter Space Esc), closes on outside click, opens towards the inline end in RTL too.
 */
export function Dropdown<T extends string>({
  value,
  options,
  onChange,
  trigger,
  title,
  ariaLabel,
  disabled,
  className,
  triggerClassName,
  panelClassName,
}: {
  value: T;
  options: DropdownOption<T>[];
  onChange: (v: T) => void;
  trigger: ReactNode;
  title?: ReactNode;
  ariaLabel: string;
  disabled?: boolean;
  className?: string;
  triggerClassName?: string;
  panelClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState<CSSProperties>({});
  const root = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const id = useId();

  // Fixed positioning clamped to the viewport: never runs off-screen on phones, LTR or RTL.
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const r = btn.current!.getBoundingClientRect();
      const w = Math.min(panel.current?.offsetWidth ?? 256, window.innerWidth - 24);
      const rtl = getComputedStyle(btn.current!).direction === "rtl";
      const preferred = rtl ? r.left : r.right - w; // open towards the inline end
      const left = Math.max(12, Math.min(preferred, window.innerWidth - w - 12));
      setPos({ position: "fixed", top: r.bottom + 8, left, width: w });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !root.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", close);
    list.current?.focus();
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  function openMenu() {
    if (disabled) return;
    setActive(Math.max(0, options.findIndex((o) => o.value === value)));
    setOpen(true);
  }
  function pick(v: T) {
    setOpen(false);
    if (v !== value) onChange(v);
  }
  function onKey(e: React.KeyboardEvent) {
    if (e.key === "Escape") return setOpen(false);
    if (e.key === "ArrowDown") setActive((a) => (a + 1) % options.length);
    else if (e.key === "ArrowUp") setActive((a) => (a - 1 + options.length) % options.length);
    else if (e.key === "Home") setActive(0);
    else if (e.key === "End") setActive(options.length - 1);
    else if (e.key === "Enter" || e.key === " ") pick(options[active].value);
    else if (e.key === "Tab") return setOpen(false);
    else return;
    e.preventDefault();
  }

  return (
    <div ref={root} className={cn("relative inline-block", className)}>
      <button
        ref={btn}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={`${id}-list`}
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : openMenu())}
        onKeyDown={(e) => {
          if (["ArrowDown", "ArrowUp", "Enter", " "].includes(e.key)) {
            e.preventDefault();
            openMenu();
          }
        }}
        className={cn(
          "inline-flex h-9 cursor-pointer items-center gap-2 rounded-full border border-line bg-surface ps-3 pe-2.5 text-sm text-ink transition hover:border-ink/25 hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-coral/40 disabled:opacity-60 sm:h-10",
          open && "border-ink/25 bg-surface-2",
          triggerClassName,
        )}
      >
        {trigger}
        <ChevronDown className={cn("size-4 shrink-0 text-muted transition-transform duration-200", open && "rotate-180")} />
      </button>

      {open && (
        <div
          ref={panel}
          style={pos}
          className={cn(
            "animate-pop z-50 w-64 origin-top overflow-hidden rounded-2xl border border-line bg-surface p-1.5 shadow-[0_24px_60px_-20px_rgba(13,15,18,0.45)]",
            !pos.position && "invisible fixed",
            panelClassName,
          )}
        >
          {title && <div className="px-3 pb-1.5 pt-2 font-mono text-[10.5px] uppercase tracking-[0.16em] text-muted">{title}</div>}
          <ul ref={list} id={`${id}-list`} role="listbox" tabIndex={-1} aria-label={ariaLabel} aria-activedescendant={`${id}-${active}`} onKeyDown={onKey} className="outline-none">
            {options.map((o, i) => {
              const selected = o.value === value;
              return (
                <li
                  key={o.value}
                  id={`${id}-${i}`}
                  role="option"
                  aria-selected={selected}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => pick(o.value)}
                  className={cn("flex cursor-pointer items-center gap-3 rounded-xl px-2.5 py-2 transition-colors", i === active ? "bg-surface-2" : "", selected && "bg-cream")}
                >
                  {o.badge && (
                    <span
                      className={cn(
                        "grid size-8 shrink-0 place-items-center rounded-lg font-mono text-[11px] font-semibold tracking-wide",
                        selected ? "bg-coral text-white" : "bg-surface-2 text-ink-2 ring-1 ring-line",
                      )}
                    >
                      {o.badge}
                    </span>
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-start text-[15px] font-medium leading-tight text-ink">
                      <bdi dir={o.dir}>{o.label}</bdi>
                    </span>
                    {o.sub && <span className="mt-0.5 block truncate text-xs text-muted">{o.sub}</span>}
                  </span>
                  {selected && <Check className="size-4 shrink-0 text-coral" />}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
