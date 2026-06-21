<!--
  A real Svelte component that drives the `useFiles` binding and renders its
  ambient stores via `$`-auto-subscription. Compiled through the actual Svelte 5
  compiler at test time (see use-files-svelte-component.test.ts), so mounting it
  proves the hand-rolled `writable` satisfies Svelte's store contract inside a
  component — something the store-level svelte tests can't, since they never
  touch the runtime. `onReady` hands the live binding back to the test driver.
-->
<script>
  import { useFiles } from "../../src/svelte/use-files.js";

  export let config;
  export let onReady;

  const files = useFiles(config);
  const { error, isUploading, progress } = files;

  onReady(files);
</script>

<output data-testid="uploading">{$isUploading}</output>
<output data-testid="fraction">{$progress.fraction}</output>
<output data-testid="error">{$error?.code ?? "none"}</output>
