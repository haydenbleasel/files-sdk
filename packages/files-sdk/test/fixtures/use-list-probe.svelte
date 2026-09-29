<!--
  Drives `useList` the way the docs recommend — re-created reactively from a
  prop (`$: ({ data, isLoading } = useList({ prefix }))`) and rendered through
  `$`-auto-subscription — so the test can prove that swapping or destroying the
  component unsubscribes the stores and aborts the in-flight request.
-->
<script>
  import { useList } from "../../src/svelte/use-files-query.js";

  export let config;
  export let prefix = "";

  $: ({ data, isLoading } = useList({ prefix }, config));
</script>

<output data-testid="loading">{$isLoading}</output>
<output data-testid="count">{$data?.items.length ?? "none"}</output>
