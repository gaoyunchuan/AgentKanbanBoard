import { useEffect, useId, useMemo, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { AssociationOption } from "./types";

type AssociationPickerProps = {
  label: string;
  valueLabel?: string;
  getOptions: (query: string) => AssociationOption[];
  onOpen?: () => void | Promise<void>;
  onSelect: (id: string) => void;
};

export function AssociationPicker({
  label,
  valueLabel,
  getOptions,
  onOpen,
  onSelect
}: AssociationPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  const options = useMemo(() => getOptions(query), [getOptions, query]);
  const selectable = options.filter((option) => !option.disabled);
  const active = selectable[Math.min(activeIndex, Math.max(0, selectable.length - 1))];

  const close = () => {
    setOpen(false);
    setQuery("");
    setActiveIndex(0);
    queueMicrotask(() => triggerRef.current?.focus());
  };

  const choose = (id: string) => {
    onSelect(id);
    close();
  };

  useEffect(() => {
    if (open) searchRef.current?.focus();
  }, [open]);

  return (
    <div className="relative min-w-0">
      <button
        ref={triggerRef}
        type="button"
        role="combobox"
        aria-label={label}
        aria-expanded={open}
        aria-controls={listId}
        aria-activedescendant={open && active ? `${listId}-${active.id}` : undefined}
        className="flex h-8 w-full min-w-0 items-center justify-between gap-2 rounded-md border bg-card px-2 text-[12px]"
        onClick={() => {
          const next = !open;
          setOpen(next);
          if (next) void onOpen?.();
        }}
      >
        <span className="truncate">{valueLabel || label}</span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      </button>
      {open && (
        <div className="absolute z-40 mt-1 w-full rounded-md border bg-card shadow-md">
          <div className="p-1">
            <Input
              ref={searchRef}
              role="searchbox"
              aria-label={`搜索${label}`}
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setActiveIndex(0);
              }}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  close();
                } else if (event.key === "ArrowDown") {
                  event.preventDefault();
                  setActiveIndex((index) =>
                    Math.min(index + 1, Math.max(0, selectable.length - 1))
                  );
                } else if (event.key === "ArrowUp") {
                  event.preventDefault();
                  setActiveIndex((index) => Math.max(0, index - 1));
                } else if (event.key === "Enter" && active) {
                  event.preventDefault();
                  choose(active.id);
                }
              }}
            />
          </div>
          <div id={listId} role="listbox" className="max-h-[280px] overflow-y-auto p-1">
            {options.length === 0 ? (
              <div className="px-2 py-4 text-center text-[11px] text-muted-foreground">
                没有符合条件的结果，可尝试其他关键词
              </div>
            ) : (
              options.map((option, index) => {
                const previousGroup = options[index - 1]?.group;
                return (
                  <div key={option.id}>
                    {option.group && option.group !== previousGroup && (
                      <div className="px-2 pb-1 pt-2 text-[10px] font-medium text-muted-foreground">
                        {option.group}
                      </div>
                    )}
                    <button
                      id={`${listId}-${option.id}`}
                      type="button"
                      role="option"
                      aria-disabled={option.disabled || undefined}
                      aria-selected={option.id === active?.id}
                      disabled={option.disabled}
                      className={cn(
                        "block w-full rounded px-2 py-1.5 text-left text-[12px] hover:bg-accent disabled:cursor-not-allowed disabled:opacity-55",
                        option.current && "bg-muted"
                      )}
                      style={{ paddingLeft: `${8 + Math.min(option.depth * 12, 36)}px` }}
                      onClick={() => choose(option.id)}
                    >
                      <span className="block truncate">{option.label}</span>
                      {option.description && (
                        <span className="block truncate text-[10px] text-muted-foreground">
                          {option.description}
                        </span>
                      )}
                    </button>
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
