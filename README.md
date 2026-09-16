# pi-relay

Durable, model-selectable session handoffs for the [Pi coding agent](https://github.com/earendil-works/pi).

`/relay` asks the current agent to record the practical state of long-running work, starts a fresh parent-linked session on a model you select, and requires the destination agent to verify the handoff before continuing.

## Install

Install the tagged release from GitHub:

```sh
pi install git:github.com/jpowersdev/pi-relay@v0.1.0
```

Restart Pi after installation. To move an existing installation to a newer tag, install that tag explicitly:

```sh
pi install git:github.com/jpowersdev/pi-relay@v0.1.1
```

To try the current checkout without installing it permanently:

```sh
pi -e git:github.com/jpowersdev/pi-relay
```

## Usage

Run the command while Pi is idle:

```text
/relay
/relay optional focus for the replacement session
```

Pi presents an interactive selector containing the models currently available to the local installation. Command text is treated only as additional focus for the handoff; it is not parsed as a model name.

The relay then:

1. asks the current agent to inspect the workspace and write a structured handoff;
2. validates and seals that handoff;
3. creates a fresh session linked to the source session;
4. restores the selected model and current thinking level; and
5. asks the destination agent to verify repository state in a read-only first turn.

The destination waits for your response before resuming implementation.

## Requirements

- Pi `0.82.1` or newer
- Node.js `22.19.0` or newer, as required by Pi
- Interactive TUI mode
- An active `write` or `bash` tool for creating the handoff
- An active `read` or `bash` tool for verifying it

The initial release is tested with Pi `0.82.1`. Pi extension APIs can evolve, so pinning a release tag is recommended.

## Storage and privacy

Handoffs are stored outside project repositories under:

```text
~/.pi/agent/handoffs/
```

The directory is set to mode `0700` and sealed handoff files to `0600` on platforms that support Unix permissions. Files are limited to 128 KiB and remain on disk until you remove them.

A handoff can contain repository status, file paths, implementation summaries, decisions, and a path to the source Pi session. Treat it as private development data. The full source transcript is not copied into the handoff and remains available locally as a recovery path.

The extension itself does not add network requests. The normal Pi model turn used to write and verify a handoff still sends context through the configured model provider.

## Failure behavior

The source session remains intact. If handoff creation or validation fails, relay stops without replacing the current session. A validated handoff is retained if a later session switch is cancelled.

## Security

Pi extensions execute with the permissions of the Pi process and can access local files or run commands. Review extension source before installation and follow your organization's policy for third-party developer tools.

Relay instructs an agent to inspect a workspace and write a local summary; it is not a sandbox or a secret scanner. Do not use it to process repositories or prompts you do not trust.

## Development

```sh
npm ci
npm run check
npm pack --dry-run
```

The extension is distributed as TypeScript and loaded directly by Pi. No build output is required.

## License

[MIT](LICENSE)
