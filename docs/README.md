# SignKit documentation

Choose the task below. There is no required reading sequence and no need to load every architecture
document or decision record.

| Task                                                       | Start here                                       |
| ---------------------------------------------------------- | ------------------------------------------------ |
| Set up development, run checks, or find source directories | [Development](development.md)                    |
| Deploy or configure a server                               | [Deployment](deployment.md)                      |
| Install or upgrade through the Cloudflare deployment CLI   | [create-signkit](create-signkit.md)              |
| Integrate with the HTTP API                                | [API](api.md)                                    |
| Operate the Rust API CLI                                   | [signkit CLI](cli.md)                            |
| Change application behavior or persistence                 | [Architecture topic map](architecture/README.md) |
| Recover data, retry delivery, or monitor maintenance       | [Operations runbooks](operations/README.md)      |
| Prepare a release                                          | [Release checklist](release-checklist.md)        |

## Reading and maintenance

Search headings before reading a large reference. Follow links only when the linked contract is
needed for the task. Architecture files describe required behavior; guides describe how to use or
operate it. Code and tests must be checked before claiming a feature is implemented.

Current contracts belong in the architecture specifications, not in an ADR or a past implementation
report. [Decision records](architecture/decisions/README.md) are optional rationale. Superseded
designs and completed plans remain available through Git history rather than an archive copied into
the working tree.
