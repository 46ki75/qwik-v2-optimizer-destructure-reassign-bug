import { component$ } from "@qwik.dev/core";
import { type DocumentHead } from "@qwik.dev/router";
import { buildHead } from "~/utils/head";

export default component$(() => {
  return <h1>If you can read this, the bug did NOT reproduce.</h1>;
});

// Any invocation reachable during SSR rendering is enough. `head: DocumentHead`
// is a realistic call site (this is how SEO helpers are typically wired) but
// not required — calling buildHead() from inside the component body, or even
// eagerly at module top level, also triggers the underlying transform bug.
export const head: DocumentHead = () => buildHead({});
