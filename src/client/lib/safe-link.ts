/** Only ever turn http(s) addresses into clickable links. */
export function isSafeHref(url: string | null | undefined): url is string {
  return !!url && /^https?:\/\//i.test(url);
}
