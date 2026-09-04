import { LineCounter, parseDocument, isNode, isMap, isScalar } from 'yaml';

export interface SourceLocation {
  line: number;
  col: number;
}

export interface SyntaxProblem {
  message: string;
  loc: SourceLocation;
}

export interface ParsedSource {
  value: unknown;
  syntaxErrors: SyntaxProblem[];
  /**
   * Map a path into the document to a source position. Walks up the path
   * until something resolves, so a complaint about a key that is absent
   * points at the object that should have contained it.
   */
  locate(path: ReadonlyArray<string | number>): SourceLocation;
}

const START: SourceLocation = { line: 1, col: 1 };

export function parseSource(text: string): ParsedSource {
  const lineCounter = new LineCounter();
  const doc = parseDocument(text, { lineCounter });

  const at = (offset: number): SourceLocation => {
    const pos = lineCounter.linePos(offset);
    return { line: pos.line, col: pos.col };
  };

  const syntaxErrors: SyntaxProblem[] = doc.errors.map((e) => ({
    message: e.message,
    loc: e.pos.length > 0 ? at(e.pos[0]!) : START,
  }));

  /**
   * The key node that introduced whatever lives at `walk`, when there is
   * one. Returns null for sequence entries, which have no key.
   */
  const keyNodeFor = (walk: ReadonlyArray<string | number>): unknown => {
    const last = walk[walk.length - 1];
    if (typeof last !== 'string') return null;
    const parent: unknown =
      walk.length === 1 ? doc.contents : doc.getIn(walk.slice(0, -1), true);
    if (!isMap(parent)) return null;
    for (const pair of parent.items) {
      if (isScalar(pair.key) && pair.key.value === last) return pair.key;
    }
    return null;
  };

  const locate = (path: ReadonlyArray<string | number>): SourceLocation => {
    const walk = [...path];
    while (walk.length > 0) {
      const node: unknown = doc.getIn(walk, true);
      if (isNode(node) && node.range) {
        // A scalar IS the interesting text, so point at it. A collection's
        // first child is not — the key that introduced it reads far better
        // in a diagnostic, so prefer that when one exists.
        if (!isScalar(node)) {
          const key = keyNodeFor(walk);
          if (isNode(key) && key.range) return at(key.range[0]);
        }
        return at(node.range[0]);
      }
      walk.pop();
    }
    return START;
  };

  return {
    value: doc.errors.length > 0 ? undefined : doc.toJS({ maxAliasCount: 100 }),
    syntaxErrors,
    locate,
  };
}
