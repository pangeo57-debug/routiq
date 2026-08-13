# Temporary staging location

This `dropoff/` folder is **not** where DropOff belongs long-term. It's staged
here, inside the `routiq` repo, only because:

1. DropOff was designed from the start as its own separate repository
   (`pangeo57-debug/dropoff`) — same spirit as RoutePal, but a different app.
2. That repository wasn't reachable/accessible from the build session yet
   (not found, or the Claude GitHub App hasn't been granted access to it).
3. The build session's container is ephemeral — pushing this here, to a repo
   we already had write access to, was the safe way to not lose the work
   while waiting on repo access.

**Once `pangeo57-debug/dropoff` is reachable**, this folder should be moved
there (as the repo root — `dropoff.html`, `manifest.json`, `test/`, etc. all
belong at the top level of that repo, not nested under `dropoff/`) and this
note, along with this whole folder, should be deleted from `routiq`.

Nothing in RoutePal's own files (`routiq.html`, `manifest.json`, icons at the
repo root) was touched to do this.
