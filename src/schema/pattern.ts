/**
 * A Pattern is either `/source/flags` (a regular expression) or a plain
 * string (matched as a literal substring). YAML has no regex type, so
 * `stdout: /listening on :3000/` arrives here as the string
 * `"/listening on :3000/"`.
 *
 * Returns null when the /…/ form is used but does not compile. Plain
 * strings always compile, because they are escaped first.
 */
export function compilePattern(source: string): RegExp | null {
  if (source.startsWith('/')) {
    const end = source.lastIndexOf('/');
    if (end <= 0) return null;
    try {
      return new RegExp(source.slice(1, end), source.slice(end + 1));
    } catch {
      return null;
    }
  }
  return new RegExp(source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
}
