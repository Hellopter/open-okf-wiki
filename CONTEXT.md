# Repository Wiki Production

This context turns one or more declared repository sources into an independently reviewed repository Wiki.

## Language

**Workspace**:
The repository root that owns Wiki configuration, Sources, Runs, and one Published Wiki.
_Avoid_: Project, working directory

**Source**:
A declared Git repository whose pinned content is admissible evidence for a Run.
_Avoid_: Input repository, codebase

**Run**:
One isolated, full generation of a Wiki from pinned Sources and settings. A Run never derives content or topology from another Run.
_Avoid_: Update, refresh, regeneration

**Focus**:
Optional reader intent that prioritizes part of a Run without narrowing its required source coverage.
_Avoid_: Filter, partial generation

**Candidate**:
The private Wiki assembled and reviewed by one Run before publication.
_Avoid_: Draft shared across runs, staging Wiki

**Published Wiki**:
The last successfully validated Candidate installed for a Workspace.
_Avoid_: Current Candidate, mutable Wiki

**WikiSpec**:
A Run's versioned declaration of Candidate page topology, evidence goals, reader questions, and cross-links.
_Avoid_: Workflow manifest, prior topology

**Page Revision**:
The identity of accepted Candidate content used to decide whether a Review remains current.
_Avoid_: File timestamp

**Review Assignment**:
A durable claim binding an independent Reviewer to exact Candidate paths and their Page Revisions.
_Avoid_: Review request without revision identity

**Task Receipt**:
A compact durable outcome for one delegated task, including artifact references, gaps, and failure details.
_Avoid_: Agent transcript, handoff prose

**Publication Seal**:
An opaque Run-bound proof that the Candidate's exact final tree, WikiSpec, and independent review coverage passed governance and remain unchanged at installation.
_Avoid_: Publish flag, mutable approval metadata

**Cluster**:
A dispatch unit of related Candidate pages: the root overview and optional architecture, one domain page, or the evidence-backed pages under one concept directory.
_Avoid_: Type bucket, category folder

**Board**:
The host-owned, read-only Markdown projection of remaining Run work at `.okf-wiki/runs/<id>/board.md`.
_Avoid_: Lead notes, mutable plan
