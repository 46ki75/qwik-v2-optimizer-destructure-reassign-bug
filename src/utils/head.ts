// The Qwik optimizer's `transform_props_destructuring` pass
// (packages/optimizer/core/src/props_destructuring.rs) treats this function
// as a Qwik inline component because the arrow has 1 destructured param and
// the body contains a `return`. It renames the param to `_rawProps` and
// rewrites identifier *reads* of `ogImage` to `_rawProps.ogImage`, but does
// not rewrite the LHS of the assignment below. The assignment ends up
// targeting a now-undeclared identifier, which throws `ReferenceError` at
// runtime (ESM is strict mode).
//
// See ISSUE.md for the root-cause walkthrough and file:line citations.

export const buildHead = ({ ogImage }: { ogImage?: string }) => {
  if (!ogImage) ogImage = `fallback-image-url`;
  return {
    title: "hang repro",
    meta: [{ property: "og:image", content: ogImage }],
  };
};
