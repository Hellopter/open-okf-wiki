# Cluster topology

WikiSpec `version` is `1`. Plan pages on these paths. The host will reject
illegal paths/pages. Host-owned `index.md` files are generated; never plan or
write them.

```text
wiki/
  index.md                 # host
  overview.md
  architecture.md          # optional
  <domain>/
    index.md               # host
    domain.md
    <concept>/             # only when evidence exists
      index.md
      concept.md
      models.md            # or models/<slug>.md
      flows.md             # processes; sequence diagrams live here by default
      sequences.md         # only if multiple interactions overflow flows.md
      states.md
      data.md
      modules.md
```

A **cluster** is one dispatch unit:

- Root: `overview.md` and optional `architecture.md`
- Domain: `<domain>/domain.md`
- Concept: the evidence-backed pages under `<domain>/<concept>/`

Add a concept directory only when source evidence supports that concept. Add
`sequences.md` only when multiple interactions overflow `flows.md`. Split
models into `models/<slug>.md` only when one `models.md` cannot hold the
verified models.

Page paths sit beside their concept. Do not use type buckets (`concepts/`,
`flows/` as directories of slugs).
