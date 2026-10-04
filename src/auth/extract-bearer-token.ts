/** The bearer token from an Authorization header, or undefined if there isn't one. */
export function extractBearerToken(request: {
  headers: Record<string, string | undefined>;
}): string | undefined {
  const header = request.headers.authorization;
  if (!header?.startsWith('Bearer ')) return undefined;
  return header.slice('Bearer '.length);
}
