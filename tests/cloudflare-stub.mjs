// Lets Node load worker/index.js: "cloudflare:workers" becomes a tiny stand-in.
export function resolve(specifier, context, next) {
  if (specifier === 'cloudflare:workers') {
    return { url: new URL('./cloudflare-workers.mjs', import.meta.url).href, shortCircuit: true };
  }
  return next(specifier, context);
}
