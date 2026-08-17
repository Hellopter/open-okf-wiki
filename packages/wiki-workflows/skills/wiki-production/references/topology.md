# Cluster topology

Plan a source-aware Wiki with the shape **Source -> Domain -> Concept**. The
host derives `pageType` from the path and owns every `index.md`; never plan or
write an index. Root pages are the cross-source synthesis. A source page owns
the overview of that source.

```text
wiki/
  index.md                         # host
  overview.md                      # cross-source synthesis
  architecture.md                  # optional cross-source architecture
  <source>/
    index.md                       # host
    source.md                      # source overview
    <domain>/
      index.md                     # host
      domain.md                     # domain overview within this source
      <concept>/
        index.md                   # host
        concept.md
        models.md                  # or models/<slug>.md
        flows.md                   # processes; sequence diagrams live here
        sequences.md               # only when interactions overflow flows.md
        states.md
        data.md
        modules.md
```

Legal authored paths are exactly `overview.md`, optional `architecture.md`,
`<source>/source.md`, `<source>/<domain>/domain.md`, and the supported concept
pages shown above. Source, domain, and concept directory names are lowercase
ASCII slugs. A domain slug may occur under more than one source: those are
distinct clusters and must retain their source-qualified paths.

The implicit single-source workspace uses the same source tier. Its folder is
`source`. Keep every taxonomy `sourceScopeId` equal to that folder name.

Only add a source, domain, or concept when source evidence supports it. Split
models into `models/<slug>.md` only when one `models.md` cannot hold the
verified models.
