import { useRouteError } from 'react-router-dom';

// Heuristic: any error whose message looks like it came from a failed
// `import()` of a code-split chunk. Different bundlers / browsers phrase
// it slightly differently — match the common variants.
function looksLikeChunkLoadError(err: unknown): boolean {
  const msg =
    err instanceof Error
      ? `${err.name}: ${err.message}`
      : typeof err === 'object' && err !== null && 'message' in err
        ? String((err as { message: unknown }).message)
        : String(err);
  return (
    /Failed to fetch dynamically imported module/i.test(msg) ||
    /Loading chunk \d+ failed/i.test(msg) ||
    /Importing a module script failed/i.test(msg) ||
    /ChunkLoadError/i.test(msg)
  );
}

const RELOAD_FLAG = 'lintel.chunkReloadAttempted';

// Mounted as `errorElement` for every lazy-loaded route. When the user has
// a stale `index.html` cached (chunk hashes from an older deploy) the new
// chunk filename doesn't exist, the lazy import 404s, React Router lands
// here. We trigger a single `location.reload()` — the fresh response gets
// the latest `index.html` (no-cache headers ensure this) which references
// the current chunks.
export default function ChunkLoadBoundary() {
  const error = useRouteError();

  if (looksLikeChunkLoadError(error)) {
    // Avoid an infinite reload loop if the chunk really is gone (e.g. CDN
    // origin error). One auto-reload, then show the friendly fallback if
    // we land here again.
    const attempted =
      typeof sessionStorage !== 'undefined' && sessionStorage.getItem(RELOAD_FLAG) === '1';
    if (!attempted) {
      try {
        sessionStorage.setItem(RELOAD_FLAG, '1');
      } catch {/* private mode */}
      // Defer to give React a tick before navigating.
      setTimeout(() => window.location.reload(), 50);
      return (
        <div className="min-h-screen bg-paper grid place-items-center px-6">
          <span className="text-ink/55 text-sm uppercase tracking-[0.22em]">updating…</span>
        </div>
      );
    }
  } else {
    // Different error — clear the chunk-reload flag so a future genuine
    // chunk failure can still trigger one fresh reload.
    try {
      sessionStorage.removeItem(RELOAD_FLAG);
    } catch {/* ignore */}
  }

  // Fallback UI (something genuinely broken, or the chunk reload just
  // happened and we're still in trouble — let the user see the issue
  // and retry).
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : 'Something went wrong loading this page.';
  return (
    <div className="min-h-screen bg-paper grid place-items-center px-6">
      <div className="max-w-md w-full text-center">
        <p className="text-[11px] uppercase tracking-[0.22em] text-ink/45">Error</p>
        <h1 className="mt-2 font-display-tight text-3xl">Couldn't load that page.</h1>
        <p className="mt-3 text-sm text-ink/65 break-words">{message}</p>
        <div className="mt-6 flex items-center justify-center gap-2">
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="h-10 px-5 rounded-full bg-ink text-paper text-sm hover:bg-ink-soft"
          >
            Reload
          </button>
          <button
            type="button"
            onClick={() => {
              try { sessionStorage.removeItem(RELOAD_FLAG); } catch {/**/}
              window.location.href = '/';
            }}
            className="h-10 px-5 rounded-full text-sm text-ink/65 hover:text-ink"
          >
            Go home
          </button>
        </div>
      </div>
    </div>
  );
}
