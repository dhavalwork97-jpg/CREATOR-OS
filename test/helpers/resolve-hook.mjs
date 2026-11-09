export async function resolve(specifier, context, nextResolve) {
  if (specifier === "@neondatabase/serverless") {
    return { url: new URL("./neon-stub.mjs", import.meta.url).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
