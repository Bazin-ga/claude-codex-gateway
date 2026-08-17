# AI onboarding guide

guide_revision: 1

This is the public, generic edition. It is documentation from the repository, not a
console page or an API. It contains no deployment address, account list, or secret.
Never invent a URL, account name, network membership, or credential value.

The goal is to help an AI assist with one member machine. The AI may explain the steps and
check local, non-secret prerequisites. It must stop and ask a human whenever a step needs an
invitation, browser sign-in, provider authorization, an account-owner decision, or execution of
an installer that contains a secret. After the human explicitly approves that local execution,
the AI may run the installer without printing, quoting, uploading, or copying its contents into chat.

## 1. Join the tailnet first

Do not open or guess the control-plane address before the machine is on the organization's
approved Tailscale tailnet.

1. Ask the human to confirm that this machine is allowed to join the tailnet.
2. If there is no invitation, approval, or supported sign-in path, stop and ask the human or
   administrator to complete that step.
3. The human must complete any browser sign-in or device approval. Do not automate or bypass it.
4. Continue only after the human confirms that the machine is connected to the tailnet.

## 2. Read the private, live instructions

After the machine is connected, ask the administrator for the full private console link ending
in `/onboarding.md`, if this deployment provides one. Open exactly the link the administrator
gives you; do not derive a hostname, port, account, or path. If the link is missing or cannot be
opened from the tailnet, stop and ask the administrator.

The private instructions may contain the current gateway address, available accounts, a
configuration revision, and commands generated for this deployment. Do not substitute a public
gateway address or a guessed console page. Do not treat any other path as an onboarding API.

## 3. Claude Code path

Use the private console's member page:

1. Choose Claude Code and select an account that the page lists as available.
2. Enter a device name supplied or approved by the human. Do not guess an account or a person's
   label.
3. Ask the console to generate its one-time installer or profile for this device.
4. If the page says that the account owner must authorize the account, stop and ask that owner to
   complete the browser authorization. Never ask for, copy, or paste the provider credential.
5. Ask the human to review and approve the generated installer or profile. After explicit approval,
   the AI may execute that local file, but must not print it, quote it, upload it, copy it into chat,
   or reuse it on another machine. Delete the installer after it succeeds. If safe local execution
   cannot be guaranteed, stop and ask the human to run it.
6. Have the human start Claude Code through the generated profile. If it fails, stop with the
   displayed non-secret error and ask the administrator; do not work around the generated setup
   by configuring a direct provider connection.

For background on the member flow, see [`credential-console/README.md`](credential-console/README.md#member-workflow).

## 4. Codex path

Use the private console's member page:

1. Choose Codex and select a platform supported by the page. Do not run administrator setup
   commands on the member machine.
2. Ask the console to generate exactly one one-time installer for this device and platform.
3. If Codex self-service is unavailable, or the page requires an administrator decision, stop and
   ask the administrator. Do not guess a dispenser address or enrollment setting.
4. Ask the human to review and approve the generated installer locally. After explicit approval,
   the AI may execute it without displaying, copying, or transmitting its contents, and must delete
   it after success. If safe local execution cannot be guaranteed, stop and ask the human to run it.
5. The installer creates an isolated profile and does not overwrite the person's default
   `~/.codex`. Start a new process with the generated `codex-gateway` or account-fixed launcher;
   profile changes do not hot-switch an existing session.
6. Verify only through the generated client setup and a real user-approved Codex operation. Do
   not run the `codex login` command as part of this onboarding flow.

For background on the installed client, see [`codex-credential/client-agent/README.md`](codex-credential/client-agent/README.md#what-it-does).

## 5. Stop conditions and safety boundary

Stop and ask a human when any of these is true:

- tailnet membership, an invitation, browser sign-in, or device approval is required;
- a Claude account owner must authorize an account;
- no available account is listed, or the administrator has not supplied the private link;
- a generated installer/profile contains a secret and the human has not yet approved local execution;
- a URL, account, platform, command, or error meaning is ambiguous;
- a setup step would require bypassing the console-generated configuration.

This public guide never supplies a secret and never authorizes a provider account. It is not a
replacement for a human approval, the private live instructions, or the one-time installer shown
by the console.
