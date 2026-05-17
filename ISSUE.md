# [🐞] v2: Optimizer's `transform_props_destructuring` mis-rewrites plain helper arrows, breaking dev SSR and production

## Which component is affected?

`Qwik Optimizer (rust)`

(The bug reproduces with only `qwikVite()` in the Vite plugin list; the
router is not involved.)

---

## Describe the bug

The optimizer's `transform_props_destructuring` pass treats **any** arrow
function with a single destructured parameter and a `return` statement as a
Qwik inline component, regardless of whether the function actually is one.
The pass renames the parameter to `_rawProps` and rewrites identifier
**reads** of the destructured names to `_rawProps.<name>` — but it does not
rewrite the LHS of assignments. When the function body reassigns the
destructured binding (a common pattern in plain helpers that default an
optional argument, e.g. `if (!ogImage) ogImage = …`), the rewritten code
ends up writing to a now-undeclared identifier.

User-visible failure modes (all empirically observed, see Additional
Information):

- **Dev SSR (`vite --mode ssr`)**: throws `ReferenceError: <name> is not
defined` inside the SSR render path. The error is swallowed by Qwik's
  component SSR pipeline and the request hangs forever with no log output.
- **Production (`pnpm build` + any SSR adapter or `vite preview`)**: ships
  the same broken code. Depending on the RHS shape and downstream
  simplification, either the broken assignment is preserved (template
  literal RHS → 500 with the same `ReferenceError` at runtime) or the
  entire conditional is eliminated as dead code (string literal RHS →
  silent miscompilation: the default value is never applied).

**I intend to submit a PR for this issue.** Candidate fix (refusing the
transform when the body reassigns a destructured binding) is on the branch
`fix/props-destructuring-reassign-bug` against `build/v2` — see Additional
Information for the change summary.

---

## Reproduction

<https://github.com/46ki75/qwik-v2-optimizer-destructure-reassign-bug>

The repo contains the minimal trigger (3 files: `src/routes/index.tsx`,
`src/utils/head.ts`, `src/root.tsx`), the vanilla v2 starter shell, and a
README with a verified variant matrix (11 probes characterising the
trigger surface).

---

## Steps to reproduce

```bash
pnpm install
pnpm dev      # vite --mode ssr ; serves http://localhost:5173/
curl --max-time 15 http://localhost:5173/
```

Expected (broken) result: `curl` exits with timeout (exit code 28). Vite
logs no error.

To see the actual error rather than a hang, switch the invocation in
`src/routes/index.tsx` to eager (module top-level) form:

```ts
import { buildHead } from "~/utils/head";
const _eager = buildHead({});
void _eager;
```

`curl http://localhost:5173/` then returns a 500 with:

```sh
"message":"ogImage is not defined"
"stack":"    at buildHead (src/utils/head.ts:N:M)
         at eval (src/routes/index.tsx:N:M)
         at async ESModulesEvaluator.runInlinedModule (vite/.../module-runner.js)
         …"
```

To inspect the Vite-transformed output directly (post-optimizer SSR
module the runtime actually executes):

```bash
curl http://localhost:5173/src/utils/head.ts?import
```

To verify production is also affected:

```bash
pnpm build
# Then grep dist/build/q-*.js for the chunk containing "hang repro";
# the body is `const r = e => (e.ogImage || (ogImage = "fallback-image-url"), …)`
# — a write to an undeclared `ogImage` that throws in strict mode at runtime.
```

---

## System Info

```shell
  System:
    OS: Linux 6.6 Ubuntu 24.04.4 LTS 24.04.4 LTS (Noble Numbat)
    CPU: (16) x64 Intel(R) Core(TM) Ultra 7 255H
    Memory: 6.53 GB / 15.31 GB
    Container: Yes
    Shell: 5.2.21 - /bin/bash
  Binaries:
    Node: 24.15.0 - /home/ikuma/.vite-plus/js_runtime/node/24.15.0/bin/node
    npm: 11.12.1 - /home/ikuma/.vite-plus/js_runtime/node/24.15.0/bin/npm
    pnpm: 10.33.0 - /home/ikuma/.volta/bin/pnpm
  Browsers:
    Chrome: 148.0.7778.167
  npmPackages:
    @qwik.dev/core: 2.0.0-beta.35 => 2.0.0-beta.35
    @qwik.dev/router: 2.0.0-beta.35 => 2.0.0-beta.35
    typescript: 5.8 => 5.8.3
    vite: 7.3.2 => 7.3.2
```

---

## Additional Information

### Minimal trigger

```ts
// src/utils/head.ts
export const buildHead = ({ ogImage }: { ogImage?: string }) => {
  if (!ogImage) ogImage = `fallback-image-url`;
  return {
    title: "x",
    meta: [{ property: "og:image", content: ogImage }],
  };
};
```

```ts
// src/routes/index.tsx
import { component$ } from "@qwik.dev/core";
import { type DocumentHead } from "@qwik.dev/router";
import { buildHead } from "~/utils/head";

export default component$(() => <h1>hi</h1>);
export const head: DocumentHead = () => buildHead({});
```

`head: DocumentHead` is one realistic invocation path; any invocation
reachable during SSR is sufficient. The repo's `README.md` documents 11
verified variants — invocation from a component body or eager top-level
call also triggers the bug; mere import without invocation does not. The
bug reproduces with only `qwikVite()` in the Vite plugin list, confirming
it's core-optimizer and not router-related.

### Empirical evidence

All output below was captured live. The dev-mode samples come from Vite's
transform endpoint (`http://localhost:5173/src/utils/head.ts?import`); the
production samples come from the matching chunk in `dist/build/q-*.js`
after `pnpm build`.

**Dev SSR, template-literal RHS** (`if (!ogImage) ogImage = \`fallback-image-url\``):

```js
export const buildHead = (_rawProps) => {
  if (!_rawProps.ogImage) ogImage = `fallback-image-url`;
  return {
    title: "hang repro",
    meta: [{ property: "og:image", content: _rawProps.ogImage }],
  };
};
```

The reads (both the `if` test and the returned object) are correctly
rewritten to `_rawProps.ogImage`. The assignment LHS is the undeclared
`ogImage`. ESM is strict mode → `ReferenceError` when `_rawProps.ogImage`
is falsy.

**Dev SSR, string-literal RHS** (`if (!ogImage) ogImage = "fallback-image-url"`):

```js
export const buildHead = (_rawProps) => {
  if (!_rawProps.ogImage) "fallback-image-url";
  return {
    title: "hang repro",
    meta: [{ property: "og:image", content: _rawProps.ogImage }],
  };
};
```

The assignment statement is reduced to just the RHS expression. I did not
pinpoint which downstream pass eliminates it (see Open Questions). End
result: function executes without error and returns `og:image: undefined`.

**Production, template-literal RHS**:

```js
const r = (e) => (
  e.ogImage || (ogImage = "fallback-image-url"),
  { title: "hang repro", meta: [{ property: "og:image", content: e.ogImage }] }
);
```

The `if` was rewritten to a `||` short-circuit, but the assignment LHS is
still the undeclared `ogImage`. Same strict-mode `ReferenceError` at
runtime. Surfaces as a 500 in `vite preview` and any SSR adapter (Node,
Cloudflare, AWS Lambda, etc.).

**Production, string-literal RHS**:

```js
const a = (t) => ({
  title: "hang repro",
  meta: [{ property: "og:image", content: t.ogImage }],
});
```

The entire `if (...)` clause is eliminated as dead code. No error; silent
miscompilation. Arguably the more dangerous case because it ships broken
behaviour with no log, no error, and no test failure unless something
downstream notices the missing default.

**Strict-mode behaviour confirmed in isolation** (the compiled body,
executed in plain Node — no Qwik or Vite involved):

```bash
node --input-type=module -e '
  const r = (e) => (
    e.ogImage || (ogImage = "fallback-image-url"),
    { title: "x", meta: [{ property: "og:image", content: e.ogImage }] }
  );
  try { console.log(r({ ogImage: "x" })); } catch (err) { console.log("ERR:", err.message); }
  try { console.log(r({})); } catch (err) { console.log("ERR:", err.message); }
'
# { title: "x", meta: [ { property: "og:image", content: "x" } ] }
# ERR: ogImage is not defined
```

### Root cause (verified by reading source)

File paths below are relative to the `qwik` repo root, branch `build/v2`,
commit `ddb8095da`.

**1. The pass runs unconditionally on every module.**
`packages/optimizer/core/src/parse.rs:295–303`:

```rust
// Reconstruct destructured props for signal forwarding.
// Runs for all modes including Lib, ...
transform_props_destructuring(
    &mut program,
    &mut collect,
    &config.core_module,
);
```

**2. The arrow-detection gate is over-broad.**
`packages/optimizer/core/src/props_destructuring.rs:287–307`:

```rust
fn visit_mut_arrow_expr(&mut self, node: &mut ast::ArrowExpr) {
    if node.params.len() == 1 {
        // probably an inline component
        if matches!(
            &node.body,
            box ast::BlockStmtOrExpr::Expr(box ast::Expr::Call(_))
        ) {
            self.transform_component_props(node);
        } else if matches!(
            &node.body,
            box ast::BlockStmtOrExpr::BlockStmt(ast::BlockStmt { stmts, .. })
            if stmts.iter().any(|stmt| matches!(stmt, ast::Stmt::Return(_)))
        ) {
            self.transform_component_props(node);
        }
    }
    node.visit_mut_children_with(self);
}
```

The conditions are: arrow has exactly one parameter AND either (a) its
expression body is a `CallExpr` or (b) its block body contains any `Return`
statement. There is no check that the parameter is destructured into
JSX-prop-shaped names, that the body actually returns JSX, or that the
surrounding context indicates a Qwik component.

`buildHead` matches: one parameter, block body, contains a `return`. So
`transform_component_props` is invoked on it.

**3. `transform_component_props` renames the parameter and indexes reads.**
`packages/optimizer/core/src/props_destructuring.rs:62–88`. The
destructured `{ ogImage }` is replaced with `_rawProps`. For each
destructured local, the pass records `ogImage → _rawProps.ogImage` in
`self.identifiers` (line 80). The parameter binding for `ogImage` no
longer exists in the rewritten function.

**4. Only `Expr::Ident` reads are rewritten — not assignment LHS.**
`packages/optimizer/core/src/props_destructuring.rs:334–344`:

```rust
fn visit_mut_expr(&mut self, node: &mut ast::Expr) {
    match node {
        ast::Expr::Ident(ident) => {
            if let Some(expr) = self.identifiers.get(&id!(ident)) {
                *node = expr.clone();
            }
        }
        _ => {
            node.visit_mut_children_with(self);
        }
    }
}
```

This is the only identifier-rewriting override the `PropsDestructuring`
visitor provides. In SWC's AST, the LHS of `AssignExpr` is `AssignTarget`
/ `SimpleAssignTarget`, **not** `Expr`. The default visitor for
`AssignExpr` dispatches the target through `visit_mut_assign_target`,
which this pass does not override. A grep across the entire optimizer
crate (`grep -n 'visit_mut_assign\|visit_mut_simple_assign\|AssignTarget'`)
returns no overrides — nothing in the pipeline rewrites assignment LHS
identifiers.

**5. Existing fixtures don't exercise this case.**
The relevant tests in `packages/optimizer/core/src/test.rs` are
`destructure_args_inline_cmp_block_stmt` (line 3649),
`destructure_args_inline_cmp_block_stmt2` (3671),
`destructure_args_inline_cmp_expr_stmt` (3694),
`destructure_args_colon_props` (3713), `destructure_args_colon_props2`
(3734), `destructure_args_colon_props3` (3756), and `should_destructure_args`.
All six destructure*args*\*:

- Return JSX (`return ( <div/> )` or `<div/>` expression body).
- Do not reassign any destructured parameter.

None test a destructured arrow returning a non-JSX value, and none test
parameter reassignment.

### Things I have not pinned down

Worth checking before merging a fix:

1. **Which pass eliminates the string-literal assignment.** After
   `transform_props_destructuring` produces the broken AST, something
   downstream reduces `ogImage = "..."` to either a bare expression
   statement (dev) or removes the surrounding `if` entirely (prod).
   `simplify::simplifier` runs at `parse.rs:360–369` only when
   `config.minify != MinifyMode::None`, which explains the production
   case but not the dev case (unless dev mode also sets a non-`None`
   minify mode in the qwikVite plugin — I have not confirmed). The
   candidate fix prevents the malformed AST in the first place, so this
   becomes academic, but the maintainer may want to know.

2. **Whether the transform is also applied at module top level.** The
   variant matrix in the repro's `README.md` shows that invocation from
   `head`, a component body, or at module top level all trigger the same
   error. I have not read the source carefully enough to confirm that
   the same rewrite applies to top-level arrows vs only to those inside
   a component context.

3. **Why the transform is unconditional even for `Lib` mode** (per the
   comment at `parse.rs:295–298`). May be intentional, but worth checking
   that the fix doesn't regress library builds.

### Candidate fix

Branch: `fix/props-destructuring-reassign-bug` against `build/v2`.

The pre-check at the top of `transform_component_props`
(`packages/optimizer/core/src/props_destructuring.rs`) collects the
destructured parameter names and walks the body looking for `AssignExpr`
(covers `=`, `??=`, `||=`, `&&=`, `+=`, …) or `UpdateExpr` (`x++`, `++x`,
…) targeting any of them. If found, the function returns early and the
arrow is left untouched. Reassigning a Qwik component prop is semantically
meaningless (props are read-only), so refusing is safe even for real
components — the pre-fix behaviour was already broken in those cases.

Diff: +90/-1 in `props_destructuring.rs`, +83 in `test.rs`, plus 4 new
snapshots covering the previously-untested cases (template literal RHS,
string literal RHS, `??=` form, `++` update expression). All 4 snapshots
show the arrow returned **unchanged** (destructure intact, body verbatim).

Test results: 243 / 243 pass after the fix. Zero regressions in the 7
existing `destructure_args_*` / `should_destructure_args` tests.

The fix is intentionally conservative — it disables the optimization for
exactly the cases that were producing broken code, without changing the
gate semantics for any other arrow shape. A more principled fix that
tightens the arrow-detection gate (`visit_mut_arrow_expr`) to require an
actual JSX return would be larger and harder to evaluate; JSX has already
been transpiled to factory-call expressions at this point in the
pipeline (`parse.rs:259`), so detecting "returns JSX" would require
recognising the post-transpile factory ident, which is non-trivial.

### Real-world impact

Common pattern that hits this:

```ts
export const generateHead = ({ url, title, ogImage }: { ... }) => {
  if (!ogImage) ogImage = `${origin}${DEFAULT_OG}`;
  return { title, meta: [{ property: "og:image", content: ogImage }, ...] };
};
```

Routes wire it up via `head: DocumentHead = ({ resolveValue }) =>
generateHead({...})`. After upgrading to v2, every page hangs in
`pnpm dev` with no error. `pnpm build` succeeds but ships pages with
`og:image: undefined` (string-literal case) or 500s in production
(template-literal case).
