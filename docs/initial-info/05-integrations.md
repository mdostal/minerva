# Q — Integrations (v1 vs v2)
**ALL of Delphi / Auriga / Vulcan / Multica / votem are v2** — each behind a contract/ABI so it
swaps in cleanly as the other gods come online. **v1 is STANDALONE** (local, human-invoked,
file-gated). This is deliberate: it avoids the chicken-and-egg of blocking Minerva on Delphi,
Auriga, Vulcan, and votem all existing first. v1 proves the idea→spec loop (async, parallel,
human-gated); v2 wires the real integrations.

| Integration | v1 | v2 |
|---|---|---|
| Question surface | file/stopgap | **Delphi** |
| Idea-in / spec-out routing | human-invoked | **Auriga** |
| Repo provisioning | repo already exists | **Vulcan** |
| Compute/dispatch | local (SSH) | **Multica** remote |
| Approval gate | manual yes/proceed | **votem** |
