# Hi-Fi Pi distribution identity

Hi-Fi Pi keeps the upstream Pi project contract while isolating mutable user state.

| Scope | Default | Purpose |
| --- | --- | --- |
| User | `~/.hifipi/agent` | settings, credentials, models, packages, sessions, attachments, logs |
| Project | `<project>/.pi` | Pi-compatible project settings, extensions, skills, prompts, themes |

Use `hifi-pi paths` to inspect both active roots or `hifi-pi paths --json` for machine-readable output.

## Overrides

`HIFI_PI_AGENT_DIR` overrides the user state directory. `--agent-dir <path>` is the process-local CLI equivalent and also applies to package/config commands. SDK callers continue to use the existing explicit `agentDir` option.

`HIFI_PI_SESSION_DIR` overrides only session storage. During migration, `PI_CODING_AGENT_DIR` and `PI_CODING_AGENT_SESSION_DIR` are accepted only when explicitly set; the Hi-Fi-specific variables take precedence.

## Explicit import from Pi

Hi-Fi Pi never reads or mutates `~/.pi/agent` by default. Selected non-session resources can be copied explicitly:

```bash
hifi-pi import-pi skills prompts themes --dry-run
hifi-pi import-pi skills prompts themes
```

The import command never exposes `auth.json`, sessions, logs or attachment state as importable resources. Existing destinations are not overwritten. `models` and `settings` are available only as explicit selections because users may have placed sensitive custom values in those files.
