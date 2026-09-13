// Identity of the bundle this page is actually running, parsed from the Vite
// content hash in the script tag. Returns null in dev (no hashed assets), so
// the update prompt can never fire against the dev server.
export function currentBuildId() {
  if (typeof document === 'undefined') {
    return null;
  }
  for (const script of document.querySelectorAll('script[src]')) {
    const match = script.src.match(/\/assets\/index-([\w-]+)\.js/);
    if (match) {
      return match[1];
    }
  }
  return null;
}
