# Qwik v2 optimizer bug: destructured parameter reassignment is mis-rewritten

Minimal reproduction of a bug in `@qwik.dev/core@2.0.0-beta.35`'s optimizer (the
plugin produced by `@qwik.dev/core/optimizer`). When an arrow function
destructures one of its parameters and then reassigns the destructured binding,
the optimizer's rewrite pass:

- Correctly rewrites **read** references of `paramName` to `_rawProps.paramName`.
- **Incorrectly handles the assignment LHS.** Depending on the RHS shape, it
  either silently drops the entire assignment or leaves the LHS as a now
  undeclared identifier, which throws `ReferenceError` at runtime.

The dev SSR "hang" experienced in real apps is just the visible symptom of that
ReferenceError being swallowed by Qwik's component SSR pipeline. The silent
miscompilation (string-literal RHS) is arguably the more dangerous case because
it produces wrong output with no error.

The bug fires for any arrow function called during SSR — `head: DocumentHead`
is one common entry point but not required.

## TL;DR

Source:

```ts
export const buildHead = ({ ogImage }: { ogImage?: string }) => {
  if (!ogImage) ogImage = `fallback-image-url`;
  return { title: "x", meta: [{ property: "og:image", content: ogImage }] };
};
```

Vite-transformed output (live, fetched via `/src/utils/head.ts?import`):

```js
export const buildHead = (_rawProps) => {
  if (!_rawProps.ogImage) ogImage = `fallback-image-url`; // ← LHS not rewritten; ogImage undeclared
  return {
    title: "hang repro",
    meta: [{ property: "og:image", content: _rawProps.ogImage }],
  };
};
```

The body's reads of `ogImage` were rewritten to `_rawProps.ogImage` (both in
the `if` test and in the returned object), but the assignment LHS was left as
the undeclared identifier `ogImage`.

Now compare against the same source with a **string literal** RHS:

```ts
export const buildHead = ({ ogImage }: { ogImage?: string }) => {
  if (!ogImage) ogImage = "string-literal";
  return { title: "x", meta: [{ property: "og:image", content: ogImage }] };
};
```

Transformed:

```js
export const buildHead = (_rawProps) => {
  if (!_rawProps.ogImage) "string-literal"; // ← assignment dropped to bare expression
  return {
    title: "x",
    meta: [{ property: "og:image", content: _rawProps.ogImage }],
  };
};
```

The entire assignment is gone. The condition runs and discards a useless
expression statement; the parameter is never actually defaulted. This compiles
cleanly, runs without error, and just silently produces `og:image:
undefined`.

## Repro

```bash
pnpm install
pnpm dev    # vite --mode ssr ; serves http://localhost:5173/
```

In the default state of this repo, `curl http://localhost:5173/` hangs and
exits with timeout (code 28). Vite logs no error — the ReferenceError is
thrown inside the SSR render path and swallowed by Qwik's component pipeline.

### See the actual error

Switch the invocation in `src/routes/index.tsx` to eager (module top-level)
form, which Vite's request handler will surface as a 500 instead of a hang:

```ts
import { buildHead } from "~/utils/head";

const _eager = buildHead({}); // run at module load time
void _eager;
```

`curl http://localhost:5173/` then returns the actual stack:

```sh
"message":"ogImage is not defined"
"stack":"    at buildHead (src/utils/head.ts:N:M)
         at eval (src/routes/index.tsx:N:M)
         at async ESModulesEvaluator.runInlinedModule (vite/.../module-runner.js)
         …
         at async loadRoute (@qwik.dev/router/.../routing.qwik.mjs)"
```

### Inspect the transformed source directly

With `pnpm dev` running:

```bash
curl http://localhost:5173/src/utils/head.ts?import
```

Vite returns the post-optimizer JS that the SSR runtime actually executes,
showing the rewrite mistake without needing to dig through bundler internals.

## Trigger surface (verified)

I ran ten variants in this repo to characterise the surface. Results:

| #   | Variant                                                                                    | Result | Notes                                                 |
| --- | ------------------------------------------------------------------------------------------ | ------ | ----------------------------------------------------- |
| 0   | Baseline (template-literal RHS, arrow + destructured param + reassign, called from `head`) | HANG   | ReferenceError swallowed                              |
| 1   | RHS is empty backticks ` ` ``                                                              | HANG   | Content of the template literal is irrelevant         |
| 2   | Template literal at module top scope, reassignment uses a string                           | WORKS  | Trigger is per-function, not per-module               |
| 3   | `function buildHead(...)` declaration instead of `const buildHead = (...) =>`              | WORKS  | Rewrite pass appears to target arrow expressions only |
| 4   | Dead arrow with the pattern, exported one is clean                                         | WORKS  | Unreachable code is not transformed/executed          |
| 5   | `head` calls exported arrow which calls private arrow with the pattern                     | HANG   | Call-graph reachability propagates                    |
| 6   | Same arrow pattern inlined directly into `routes/index.tsx`                                | HANG   | Cross-module structure is NOT required                |
| 7   | Module imported and reference taken (`void buildHead`), never called                       | WORKS  | Pass cares about invocation, not just presence        |
| 8   | No `head: DocumentHead` export at all; component body calls `buildHead`                    | HANG   | `head` is NOT a precondition                          |
| 9   | `void buildHead` only, never invoked                                                       | WORKS  | Confirms (7)                                          |
| 10  | Eager top-level invocation                                                                 | 500    | Reveals `ogImage is not defined`                      |
| 11  | `ogImage ??= \`…\``instead of`if (!ogImage) ogImage = \`…\``                               | 500    | Confirms it's not specific to the `if` form           |

### What is and isn't part of the trigger

**Required:**

- An **arrow function expression** assigned to a `const` (or otherwise used as
  a callable value).
- That function **destructures one of its parameters**.
- The body **reassigns** the destructured binding.
- The function is **actually invoked** during SSR (any invocation path counts).

**Not required:**

- Cross-module structure. Inlining into the route file still triggers it.
- A `head: DocumentHead` export. Invocation from the component body or from
  module-top-level evaluation also triggers it.
- Any particular RHS content. Empty backticks suffice for the hang case; any
  string literal triggers the silent-drop case.

**Splits the behaviour:**

- RHS is a **template literal** (with or without interpolation) → ReferenceError
  → hang inside SSR / 500 at module level.
- RHS is a **plain string literal** → assignment silently dropped → no error,
  wrong output.
- RHS is some other expression (e.g. another variable, function call,
  concatenation) → not yet tested in this repo, but worth investigating.

## Router is not part of the trigger

Confirmed by removing `qwikRouter()` from the Vite plugin list entirely — i.e.
running with only `qwikVite()` from `@qwik.dev/core/optimizer`. The same
mis-rewrite still appears in `/src/utils/head.ts?import`:

```js
export const buildHead = (_rawProps) => {
  if (!_rawProps.ogImage) ogImage = `fallback-image-url`; // ← LHS still broken
  return {
    title: "hang repro",
    meta: [{ property: "og:image", content: _rawProps.ogImage }],
  };
};
```

The router and `DocumentHead` are not part of the trigger. The bug lives
entirely in `@qwik.dev/core/optimizer`. The `head: DocumentHead` export was
just the realistic invocation path that surfaced it in the original app.

(Interesting nuance: with `qwikRouter()` enabled, a later pass also collapsed
`if (!ogImage) ogImage = …` into `ogImage ??= …` — semantically equivalent
when correct, but here both pre- and post-collapse versions reference the same
undeclared `ogImage`. The collapse is cosmetic; the broken LHS is set by
`qwikVite()`.)

## What I think is happening

The optimizer pass that rewrites destructured-parameter components has a
case-by-case handler for assignment expressions whose target is a destructured
binding. That handler appears to be:

- Reading the assignment expression's RHS to decide whether to rewrite or
  drop the statement.
- Rewriting the LHS only on some code paths, dropping the whole statement
  on others, and leaving the LHS untouched on still others.

This is consistent with the optimizer normally targeting Qwik _component
props_ (where reassignment of a prop is nonsense and could reasonably be
treated as dead code), but here the same rewrite is being applied to **any**
arrow function with a destructured parameter — not just components. The
function in `src/utils/head.ts` is a plain helper, not a `component$()`, and
its parameter is just a regular options object.

That over-broad application is probably the root cause: the destructure
rewrite should be gated to actual Qwik components (or to functions where the
optimizer can prove the rewrite is safe), not applied to every arrow with a
destructured parameter.

## Tested versions

| Package            | Version         |
| ------------------ | --------------- |
| `@qwik.dev/core`   | `2.0.0-beta.35` |
| `@qwik.dev/router` | `2.0.0-beta.35` |
| `vite`             | `7.3.2`         |
| Node               | `>=20`          |
| OS                 | Linux (WSL2)    |

**Production builds are affected too.** `pnpm build` completes silently and
ships the same miscompilation. The post-build chunk that contains `buildHead`
(in `dist/build/q-*.js`) compiles to:

```js
const r = (e) => (
  e.ogImage || (ogImage = "fallback-image-url"),
  { title: "hang repro", meta: [{ property: "og:image", content: e.ogImage }] }
);
```

The destructured read is rewritten to `e.ogImage` correctly, but the
assignment LHS stays as the bare (undeclared) `ogImage`. ESM is strict mode by
default, so when `e.ogImage` is falsy this throws `ReferenceError: ogImage is
not defined` in production — surfacing as a 500 from `vite preview` or any
adapter (Node, Cloudflare, AWS Lambda, etc.) serving the SSR build.

Confirmed empirically (just the function body, no Qwik runtime involved):

```bash
$ node --input-type=module -e '
  const r = (e) => (
    e.ogImage || (ogImage = "fallback-image-url"),
    { title: "x", meta: [{ property: "og:image", content: e.ogImage }] }
  );
  try { console.log(r({ ogImage: "x" })); } catch (err) { console.log("ERR:", err.message); }
  try { console.log(r({})); } catch (err) { console.log("ERR:", err.message); }
'
# { title: 'x', meta: [ { property: 'og:image', content: 'x' } ] }
# ERR: ogImage is not defined
```

## Files of interest

- `src/utils/head.ts` — the function with the trigger.
- `src/routes/index.tsx` — exports `head: DocumentHead` that calls it.
- `src/root.tsx`, `src/entry.ssr.tsx`, `vite.config.ts` — vanilla v2 starter.

## Real-world impact

This shows up immediately when migrating a v1 project that has a typical SEO
helper:

```ts
export const generateHead = ({ url, title, ogImage }: { ... }) => {
  if (!ogImage) ogImage = `${origin}${DEFAULT_OG}`;
  return { title, meta: [{ property: "og:image", content: ogImage }, ...] };
};
```

Routes wire it up via `head: DocumentHead = ({ resolveValue }) =>
generateHead({...})`. After upgrading to v2, every page hangs in `pnpm dev`
with no error. `pnpm build` succeeds but ships pages with `og:image:
undefined`. The dev-mode hang is the loudest symptom, but the production
miscompilation is the more dangerous one.
