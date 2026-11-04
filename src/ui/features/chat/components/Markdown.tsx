import { Check, Copy } from 'lucide-react';
import { memo, useEffect, useRef, useState, type MouseEvent } from 'react';
import ReactMarkdown, { type Components, type ExtraProps } from 'react-markdown';
import remarkGfm from 'remark-gfm';

type HastElement = NonNullable<ExtraProps['node']>;
type HastChild = HastElement['children'][number];

function textOf(nodes: readonly HastChild[]): string {
  let out = '';
  for (const n of nodes) {
    if (n.type === 'text') out += n.value;
    else if (n.type === 'element') out += textOf(n.children);
  }
  return out;
}

function languageOf(node: HastChild | undefined): string | null {
  if (node?.type !== 'element') return null;
  const names = node.properties.className;
  if (!Array.isArray(names)) return null;
  const tagged = names.map(String).find((n) => n.startsWith('language-'));
  return tagged ? tagged.slice('language-'.length) : null;
}

/** Copia texto al portapapeles y marca «copiado» un momento. */
export function useCopy(source: string): { copied: boolean; copy: () => void } {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  const copy = () => {
    void navigator.clipboard
      ?.writeText(source)
      .then(() => {
        setCopied(true);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => undefined);
  };
  return { copied, copy };
}

export function CodeBlock({ source, language }: { source: string; language: string | null }) {
  const { copied, copy } = useCopy(source);
  return (
    <div className="group relative">
      {language ? <span className="absolute left-4 top-2 font-mono text-[0.6875rem] text-muted">{language}</span> : null}
      <pre className={`selectable overflow-x-auto rounded-xl bg-foreground/[0.04] p-4 font-mono text-[0.8125rem] leading-relaxed ${language ? 'pt-7' : ''}`}>
        <code>{source}</code>
      </pre>
      <button
        type="button"
        aria-label={copied ? 'Copiado' : 'Copiar código'}
        title={copied ? 'Copiado' : 'Copiar código'}
        onClick={copy}
        className="absolute right-2 top-2 flex size-7 items-center justify-center rounded-lg text-muted opacity-0 transition-opacity duration-quick hover:bg-foreground/[0.08] hover:text-foreground focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground group-hover:opacity-100"
      >
        {copied ? <Check className="size-3.5" aria-hidden="true" /> : <Copy className="size-3.5" aria-hidden="true" />}
      </button>
    </div>
  );
}

function openLink(e: MouseEvent<HTMLAnchorElement>, href: string | undefined) {
  const bridge = window.orq;
  if (!bridge || !href || !/^https?:\/\//i.test(href)) return;
  e.preventDefault();
  void bridge.openExternal(href);
}

const COMPONENTS: Components = {
  pre: ({ node }) => {
    const code = node?.children[0];
    const source = code?.type === 'element' ? textOf(code.children).replace(/\n$/, '') : '';
    return <CodeBlock source={source} language={languageOf(code)} />;
  },
  code: ({ children }) => <code className="rounded bg-foreground/[0.06] px-1 py-0.5 font-mono text-[0.875em]">{children}</code>,
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noreferrer noopener" onClick={(e) => openLink(e, href)} className="underline decoration-foreground/30 underline-offset-2 hover:decoration-foreground">
      {children}
    </a>
  ),
  // Las imágenes que escriba la mente no se cargan solas: quedan como enlace.
  img: ({ src, alt }) => (
    <a href={typeof src === 'string' ? src : undefined} target="_blank" rel="noreferrer noopener" className="text-muted underline underline-offset-2">
      {alt ? `Imagen: ${alt}` : 'Imagen'}
    </a>
  ),
  h1: ({ children }) => <h2 className="text-[1.0625rem] font-semibold">{children}</h2>,
  h2: ({ children }) => <h3 className="text-[1rem] font-semibold">{children}</h3>,
  h3: ({ children }) => <h4 className="text-[0.9375rem] font-semibold">{children}</h4>,
  h4: ({ children }) => <h5 className="text-[0.9375rem] font-semibold">{children}</h5>,
  h5: ({ children }) => <h6 className="text-[0.875rem] font-semibold">{children}</h6>,
  h6: ({ children }) => <h6 className="text-[0.875rem] font-semibold">{children}</h6>,
  ul: ({ children, className }) => (
    <ul className={`flex list-disc flex-col gap-1 pl-5 marker:text-muted [li>&]:mt-1 ${className?.includes('contains-task-list') ? 'list-none pl-0' : ''}`}>{children}</ul>
  ),
  ol: ({ children, start }) => (
    <ol start={start} className="flex list-decimal flex-col gap-1 pl-5 marker:text-muted [li>&]:mt-1">
      {children}
    </ol>
  ),
  blockquote: ({ children }) => <blockquote className="flex flex-col gap-2 border-l-2 border-foreground/[0.12] pl-4 text-muted">{children}</blockquote>,
  hr: () => <hr className="border-foreground/[0.08]" />,
  table: ({ children }) => <table className="block w-max max-w-full overflow-x-auto border-collapse text-[0.8125rem]">{children}</table>,
  thead: ({ children }) => <thead className="bg-[var(--table-head)]">{children}</thead>,
  th: ({ children, style }) => (
    <th style={style} className="border-b border-foreground/[0.06] px-3 py-2 text-left text-[0.75rem] font-normal text-muted">
      {children}
    </th>
  ),
  td: ({ children, style }) => (
    <td style={style} className="border-b border-foreground/[0.06] px-3 py-2 text-left">
      {children}
    </td>
  ),
  input: ({ type, checked }) =>
    type === 'checkbox' ? <input type="checkbox" checked={checked ?? false} readOnly disabled className="mr-1.5 align-middle accent-foreground" /> : null,
};

const REMARK = [remarkGfm];

/** Texto en Markdown de la mente (GFM: tablas, listas de tareas, tachado…), seleccionable. */
export const Markdown = memo(function Markdown({ text, muted = false }: { text: string; muted?: boolean }) {
  return (
    <div className={`selectable flex min-w-0 flex-col gap-4 break-words leading-relaxed ${muted ? 'text-[0.8125rem] text-muted' : 'text-[0.9375rem] text-foreground'}`}>
      <ReactMarkdown remarkPlugins={REMARK} components={COMPONENTS}>
        {text}
      </ReactMarkdown>
    </div>
  );
});
