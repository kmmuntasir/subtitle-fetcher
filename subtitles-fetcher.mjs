// Back-compat shim: the monolith became cli.mjs + lib/. Everything the daily
// task and old muscle memory use still works exactly the same:
//   node subtitles-fetcher.mjs run --limit 5
await import("./cli.mjs");
