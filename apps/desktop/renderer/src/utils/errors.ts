/** Convert transport wrappers into bounded, readable messages without displaying credentials. */
export function userFacingError(error: unknown, fallback = 'The operation could not be completed. Try again.'): string {
  let message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  message = message.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/i, '').replace(/^Error:\s*/i, '');
  try {
    const parsed = JSON.parse(message);
    if (typeof parsed.detail === 'string') message = parsed.detail;
    else if (Array.isArray(parsed.detail)) message = 'Some values are invalid. Check the form and try again.';
    else message = fallback;
  } catch { /* Non-JSON errors already contain a message. */ }
  return (message || fallback)
    .replace(/Bearer\s+[^\s,;"}]+/gi, 'Bearer [redacted]')
    .replace(/((?:password|token|secret|api[_-]?key)\s*[=:]\s*)[^\s,;"}]+/gi, '$1[redacted]')
    .replace(/[A-Za-z]:\\[^\r\n"<>]+/g, '[local path]')
    .slice(0, 400);
}

export async function withTimeout<T>(operation: Promise<T>, message: string, timeoutMs = 20000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
