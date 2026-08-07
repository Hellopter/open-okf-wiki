# Open OKF Wiki

Source-grounded repository Wiki generation for Pi. It freezes repository inputs,
uses a persistent primary agent session to build a Markdown plan, and delivers a
self-contained [OKF v0.2](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md) bundle.

The system is deliberately small:

- deterministic inventory prevents source-domain omissions;
- optional parallel discovery and independent review add breadth without
  fragmenting the writing context;
- `analysis/*.md` is the agent's reviewable working memory;
- host JSON is limited to run, lock, approval, digest, and session control;
- the final delivery is `bundle/`, not a graph of JSON receipts.

Configure approval in `workspace.yaml`:

```yaml
version: 4
workflow:
  approval: propose # or auto
```

`propose` stops after `analysis/plan.md` and coverage review. Approving the run
resumes the same persisted agent session after verifying that the frozen input
and plan digest did not change. `auto` continues directly to generation,
independent review, validation, and bundle sealing.

See the package READMEs for installation and command details.
