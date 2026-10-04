import { useEffect, useState } from 'react';

/**
 * A small router, ported from Foreman: the current path, navigation without a reload, and the back
 * button. The screens here are few and flat, which is all this has to serve.
 */

/** Paths the API serves. A click on one must leave the SPA — `/auth/oidc/start` is a redirect. */
const SERVER_PATHS = ['/auth', '/api', '/health', '/healthz', '/readyz'];

export interface Location {
  readonly path: string;
  readonly search: string;
}

function current(): Location {
  return { path: window.location.pathname, search: window.location.search };
}

const listeners = new Set<() => void>();

export function navigate(to: string, { replace = false } = {}): void {
  if (replace) window.history.replaceState({}, '', to);
  else window.history.pushState({}, '', to);
  for (const listener of listeners) listener();
  window.scrollTo(0, 0);
}

export function useLocation(): Location {
  const [location, setLocation] = useState(current);

  useEffect(() => {
    const update = () => { setLocation(current()); };
    listeners.add(update);
    window.addEventListener('popstate', update);
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = (event.target as HTMLElement | null)?.closest('a');
      if (anchor === null || anchor === undefined) return;
      const to = anchor.getAttribute('href');
      if (to === null || !to.startsWith('/')) return;
      if (anchor.target === '_blank' || anchor.hasAttribute('download')) return;
      if (SERVER_PATHS.some((prefix) => to === prefix || to.startsWith(`${prefix}/`))) return;
      event.preventDefault();
      navigate(to);
    };
    document.addEventListener('click', onClick);
    return () => {
      listeners.delete(update);
      window.removeEventListener('popstate', update);
      document.removeEventListener('click', onClick);
    };
  }, []);

  return location;
}

/** Read one query parameter once, then drop it from the URL so a reload does not repeat it. */
export function takeParam(name: string): string | null {
  const params = new URLSearchParams(window.location.search);
  const value = params.get(name);
  if (value === null) return null;
  params.delete(name);
  const rest = params.toString();
  window.history.replaceState({}, '', `${window.location.pathname}${rest === '' ? '' : `?${rest}`}`);
  return value;
}
