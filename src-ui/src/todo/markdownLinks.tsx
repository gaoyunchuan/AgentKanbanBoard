import type { ReactNode } from "react";

const namedHttpLinkPattern = /\[([^\]]+)]\((https?:\/\/[^\s)]+)\)/g;

export function MarkdownText({
  value,
  onOpenLink
}: {
  value: string;
  onOpenLink?: (url: string) => void;
}) {
  const parts: ReactNode[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;
  namedHttpLinkPattern.lastIndex = 0;

  while ((match = namedHttpLinkPattern.exec(value)) !== null) {
    if (match.index > cursor) parts.push(value.slice(cursor, match.index));
    const [source, label, url] = match;
    parts.push(
      <a
        key={`${match.index}-${url}`}
        href={url}
        target="_blank"
        rel="noreferrer"
        className="font-medium text-primary underline decoration-primary/25 underline-offset-2 hover:decoration-primary"
        onClick={(event) => {
          if (!onOpenLink) return;
          event.preventDefault();
          onOpenLink(url);
        }}
      >
        {label}
      </a>
    );
    cursor = match.index + source.length;
  }

  if (cursor < value.length) parts.push(value.slice(cursor));
  return <span className="whitespace-pre-wrap break-words">{parts}</span>;
}
