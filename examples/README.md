# Example policies

Copy one to your project as `belayd.yaml`, then check it with `belayd check --policy belayd.yaml '<command>'`.

| File | For |
|---|---|
| [`team.yaml`](team.yaml) | A shared policy committed to the repository, so the whole team's agents follow the same rules |
| [`ci.yaml`](ci.yaml) | Unattended agent runs in CI, where nobody can answer a question |
| [`monorepo.yaml`](monorepo.yaml) | A large repository with generated code, a production database and deploy scripts |
| [`relaxed.yaml`](relaxed.yaml) | Fewer interruptions for a personal side project, with undo as the safety net |

The presets in [`../presets`](../presets) are full policies too, with comments on every rule.
