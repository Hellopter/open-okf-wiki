# Isolated full-generation runs

Every Run starts from an empty Candidate and plans a complete Wiki from Sources and settings pinned for that Run. Runs may execute only one at a time in a Workspace, and a Published Wiki or its final WikiSpec is provenance rather than generation input. This rejects incremental refresh because cross-run reuse makes evidence freshness, topology ownership, and crash recovery depend on hidden history; the cost is repeating work in exchange for deterministic isolation.
