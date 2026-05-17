import { component$ } from "@qwik.dev/core";
import { RouterOutlet, useQwikRouter } from "@qwik.dev/router";

export default component$(() => {
  useQwikRouter();
  return (
    <>
      <head>
        <meta charset="utf-8" />
        <title>qwik-v2 optimizer destructure-reassign bug repro</title>
      </head>
      <body>
        <RouterOutlet />
      </body>
    </>
  );
});
