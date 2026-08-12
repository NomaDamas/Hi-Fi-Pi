# Security Policy

Hi-Fi Pi is a local coding agent that runs with the permissions of the user who starts it. It does not provide a security boundary around the workspace, shell, extensions, skills, or provider credentials.

Files writable by the current account—including shell startup files, workspace instructions, `.pi` project resources, and `~/.hifipi` user state—are inside the same trust boundary as the Hi-Fi Pi process. Use a container, virtual machine, or operating-system sandbox when stronger isolation is required.

## Reporting a vulnerability

Report vulnerabilities privately through GitHub Security Advisories for this repository. Do not open a public issue for security-sensitive reports.

Include:

- impact and affected security boundary;
- exact reproduction steps or proof of concept;
- affected version or commit;
- relevant configuration with secrets removed;
- known mitigations.

## In scope

- vulnerabilities in Hi-Fi Pi's distributed binaries and packages;
- provider credential disclosure caused by Hi-Fi Pi;
- session, attachment, or package handling that crosses an operating-system privilege boundary;
- release artifact or update-channel integrity failures;
- vulnerabilities in fork-owned services when such services exist and are explicitly documented.

## Out of scope

- expected command execution requested by the user or model;
- prompt injection from untrusted content;
- behavior of a deliberately installed untrusted extension, skill, package, or tool;
- attacks that already require write access to the user's configuration, workspace, environment, or shell startup files;
- third-party provider, proxy, viewer, catalog, or telemetry services not operated by Hi-Fi Pi;
- exposed third-party credentials not owned by the project;
- denial-of-service claims requiring trusted local input or configuration.

The most useful report demonstrates a current, reproducible boundary crossing against the latest release or `main`.
