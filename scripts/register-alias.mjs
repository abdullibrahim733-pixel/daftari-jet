/**
 * Minimal `@/` path-alias resolver for scripts and tests.
 *
 * The bundler alias from tsconfig.json is not available when Node runs TypeScript
 * directly, and this machine's Application Control policy blocks the native
 * bindings that Vite/Vitest need. Node's own type stripping plus this resolver
 * is enough to run the server modules, scripts and tests without a bundler.
 *
 * Only `.ts`/`.tsx` files are resolvable here; JSX is not supported because Node
 * strips types rather than compiling them, so tests must target server code.
 */

import { registerHooks } from 'node:module';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const projectRoot = process.env.DAFTARI_PROJECT_ROOT
  ? path.resolve(process.env.DAFTARI_PROJECT_ROOT)
  : process.cwd();
const srcRoot = path.join(projectRoot, 'src');

const CANDIDATES = ['.ts', '.tsx', '.mts', '/index.ts', '/index.tsx'];

function firstExistingFile(basePath) {
  if (existsSync(basePath) && statSync(basePath).isFile()) return basePath;
  for (const candidate of CANDIDATES) {
    const candidatePath = `${basePath}${candidate}`;
    if (existsSync(candidatePath) && statSync(candidatePath).isFile()) return candidatePath;
  }
  return null;
}

function resolveAlias(specifier) {
  return firstExistingFile(path.join(srcRoot, specifier.slice(2)));
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@/')) {
      const resolved = resolveAlias(specifier);
      if (!resolved) {
        throw new Error(`Cannot resolve "${specifier}" under ${srcRoot}`);
      }
      return { url: pathToFileURL(resolved).href, shortCircuit: true };
    }
    // The codebase uses bundler-style extensionless relative imports, which Node
    // ESM does not resolve on its own.
    if ((specifier.startsWith('./') || specifier.startsWith('../')) && context.parentURL?.startsWith('file:')) {
      const parentDir = path.dirname(fileURLToPath(context.parentURL));
      const resolved = firstExistingFile(path.resolve(parentDir, specifier));
      if (resolved) {
        return { url: pathToFileURL(resolved).href, shortCircuit: true };
      }
    }
    return nextResolve(specifier, context);
  },
});