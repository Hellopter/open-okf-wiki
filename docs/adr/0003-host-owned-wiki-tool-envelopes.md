# Host-owned Wiki tool envelopes

Model tools submit small envelopes: a WikiSpec is a Candidate page path list, and the host derives pageType and batch identity from those paths and the board. Format versions are not model inputs. Topology and identity stay in the host so Agents cannot invent page kinds, batch ids, or compatibility fields.

## Considered Options

- **spec.md parser** — rejected; a free-form Spec file would make topology a model-authored document the host must parse.
- **fat JSON spec as tool args** — rejected; pageType, reader questions, findings, and cross-links belong to pages and research artifacts, not the plan envelope.
- **version bumps as compatibility** — rejected; format versions are not model inputs.
