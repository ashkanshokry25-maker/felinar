<script>
  import { resolve } from '$app/paths';
  import { onMount } from 'svelte';
  onMount(() => { fetch('/data.json').then((r) => r.json()).then((j) => { window.__data = j; }); });
</script>
<nav><a href={resolve('/')}>home</a> <a id="to-about" href={resolve('/about')}>about</a></nav>
<h1 id="marker">HELLO-HOME-sveltekit</h1>
<style>:global(body){background:url(/bg.png)}</style>
