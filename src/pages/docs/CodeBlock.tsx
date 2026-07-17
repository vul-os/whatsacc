import { useEffect, useMemo, useRef, useState } from 'react';
import Prism from 'prismjs';

// Languages we explicitly load. Prism is opt-in per language: if a doc page
// asks for one not in this list it falls through to plain rendering.
import 'prismjs/components/prism-bash';
import 'prismjs/components/prism-json';
import 'prismjs/components/prism-javascript';
import 'prismjs/components/prism-typescript';
import 'prismjs/components/prism-python';
import 'prismjs/components/prism-go';
import 'prismjs/components/prism-markup';
import 'prismjs/components/prism-yaml';
import 'prismjs/components/prism-http';

export type CodeLang =
  | 'bash'
  | 'json'
  | 'js'
  | 'ts'
  | 'python'
  | 'go'
  | 'html'
  | 'yaml'
  | 'http'
  | 'plain';

const aliases: Record<CodeLang, string> = {
  bash: 'bash',
  json: 'json',
  js: 'javascript',
  ts: 'typescript',
  python: 'python',
  go: 'go',
  html: 'markup',
  yaml: 'yaml',
  http: 'http',
  plain: 'plain',
};

const labels: Record<CodeLang, string> = {
  bash: 'Shell',
  json: 'JSON',
  js: 'JavaScript',
  ts: 'TypeScript',
  python: 'Python',
  go: 'Go',
  html: 'HTML',
  yaml: 'YAML',
  http: 'HTTP',
  plain: 'Text',
};

export type CodeBlockProps = {
  /** the code to display — preserve newlines via a template string. */
  children: string;
  /** language for syntax highlighting; defaults to 'plain'. */
  lang?: CodeLang;
  /** small label rendered above the code (e.g. file path or shell name). */
  title?: string;
};

export function CodeBlock({ children, lang = 'plain', title }: CodeBlockProps) {
  const code = children.trimEnd();
  const ref = useRef<HTMLElement | null>(null);
  const [copied, setCopied] = useState(false);

  const html = useMemo(() => {
    const grammarKey = aliases[lang];
    const grammar = grammarKey === 'plain' ? null : Prism.languages[grammarKey];
    if (!grammar) {
      // Plaintext path — escape & insert as-is.
      return escapeHtml(code);
    }
    try {
      return Prism.highlight(code, grammar, grammarKey);
    } catch {
      return escapeHtml(code);
    }
  }, [code, lang]);

  // re-tokenise after mount so any late-loaded language plug-ins still apply.
  useEffect(() => {
    if (ref.current) Prism.highlightElement(ref.current);
  }, [html]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {/* noop */}
  }

  return (
    <figure className="hl-figure not-prose my-4">
      <header className="hl-toolbar">
        <span className="hl-lang">{title ?? labels[lang]}</span>
        <button type="button" onClick={copy} className="hl-copy" aria-label="Copy code">
          {copied ? 'Copied' : 'Copy'}
        </button>
      </header>
      <pre className={`hl-pre language-${aliases[lang]}`}>
        <code
          ref={ref}
          className={`language-${aliases[lang]}`}
          dangerouslySetInnerHTML={{ __html: html }}
        />
      </pre>
    </figure>
  );
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
