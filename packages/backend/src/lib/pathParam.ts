/** Normalize Express path params (string | string[] in newer typings). */
export function pathParam(id: string | string[] | undefined): string {
  if (id == null) return '';
  return typeof id === 'string' ? id : id[0] ?? '';
}
