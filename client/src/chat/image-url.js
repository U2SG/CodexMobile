// Cache-buster suffix appender for image retry. Used by GeneratedImage and
// ImagePreviewModal so that an onError -> retry round-trip forces the browser
// to re-fetch the image instead of serving the same cached failure.
//
// retryKey === 0 / null / undefined → original url unchanged (first load).
// truthy retryKey → appends `r=<key>` using `?` or `&` depending on whether
// the url already has a query string.

export function imageUrlWithRetry(url, retryKey) {
  if (!retryKey) {
    return url;
  }
  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}r=${retryKey}`;
}
