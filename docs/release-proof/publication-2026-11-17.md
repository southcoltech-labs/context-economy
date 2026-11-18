# Publication record: `southcoltech-labs/context-economy`

The staging repository `southcoltech-labs/context-economy-preview` (ID `1439225668`) was renamed to `southcoltech-labs/context-economy` and became the public release repository. It kept its ID, history, tags, releases, settings and integrations. `v0.1.2`, promoted to `release` at `b72867fd12ae562577f9bf96bcc0ee85362c1a33` before the rename, is its first public release. No new candidate, E1a run or promotion was made: the code, SHA and proof are the same, and the release tooling finds its repository through `GITHUB_REPOSITORY`, not by name.

The earlier records in this folder were made under the old name and are kept as they were.

| | |
| --- | --- |
| Repository | ID `1439225668`, now `southcoltech-labs/context-economy`, public |
| Name it replaced | the empty private repository ID `1439101314`, renamed aside to `southcoltech-labs/context-economy-unused` and kept private |
| Old name | `context-economy-preview` redirects to the new name. It is reserved: no repository may take it again, which would end the redirect |
| Release | `v0.1.2`, latest; `release` and `promoted-v0.1.2` at `b72867f…` |
| Dates (UTC) | 2026-11-17 22:39 (freeze) to 2026-11-18 04:28 (smoke install) |
| Result | complete, with one exception during the freeze (see Notes, 1) |

## Steps

| Step | Expected | Result |
| --- | --- | --- |
| Before: #18 merged | the last open pull request merged before the freeze | merged 22:38:34Z as `c9b9202`; its release run `44192037535` released nothing |
| C0. Freeze and inventory | no release or promotion run active; inventory of both repositories by ID | no active writer at 22:39:23Z and again at the end; inventory 22:39–22:40Z. The empty repository: private, no refs, releases, issues, pull requests, runs, environments, deployments, rulesets, webhooks, variables or secrets; access is the two organization owners as admins. The owner confirmed in the organization's settings that the candidate App, the promote App and DCO are installed on `1439225668`, and that neither repository has a linked project |
| C1. Rename aside | `1439101314` is `context-economy-unused`, private | as expected |
| C2. Rename | `1439225668` is `context-economy` | as expected |
| C3. Name and redirect | the new name resolves to `1439225668`, not to the holding repository; the old and new URLs list the same refs | `1439225668`; both URLs list the same 35 refs (22:52Z) |
| C4. Comparison with C0 | only the names differ | the names, and branch `e1-driver` (Notes, 1). Rulesets, effective rules on `main` and `release`, environments and their protections, variable values, secret names with their update times, access, Actions settings, releases, tags, `main` and `release` unchanged. The freeze ended here |
| C5. Acceptance pull request | CI, DCO, Code Owners and merge protection work under the new name; the release run after it releases nothing | #19: all checks passed, DCO passed, the review of `maintainers` was requested, merging was blocked until a maintainer approved; merged 2026-11-18 03:19:04Z as `47af00c`; release run `44229559590` released nothing |
| C6. Release notes | `v0.1.2` text replaced; still latest, not a prerelease, same tag | as expected |
| C7. Smoke install | in a new standard account, with the README's lines: both hosts install `b72867f`, rewrite a command and write a ledger row; uninstall leaves only the README's data | see below |

## C7 smoke install

macOS arm64, a new standard account, 2026-11-18. Claude Code 2.1.327, Pi 1.5.0, RTK 0.47.0 (installed with the README's block; checksum OK).

- **Install:** `claude plugin marketplace add southcoltech-labs/context-economy#release`, `claude plugin install tool-gateway@context-economy`, and `pi install git:github.com/southcoltech-labs/context-economy@release`. Both installed commits are `b72867f`.
- **Use:** `git status` in a clone of this repository, in each host. Claude Code's ledger row (`ce.claude-gateway.v1`, 04:28:03Z) and Pi's (`ce.pi-gateway.v1`, 04:28:44Z) both have `rewrite: applied` and `is_error: false`.
- **Uninstall:** with the README's commands. The Claude Code marketplace is gone, and Pi's `~/.pi/agent/git/` holds only its own `.gitignore`; `~/.claude/context-economy/` keeps `config.json`, `gateway-ledger` and `gateway-ledger-pi`, as the README says.

Claude Code 2.1.327 is later than the versions `v0.1.2` was tested with. The release notes list only the tested versions.

## Notes

1. **A push during the freeze.** Branch `e1-driver` moved by fast-forward from `10f3ff9` to `3efde00` at about 22:40:52Z, after the C0 inventory and before C3: one commit of maintainer scripts, made with the company identity. It started no workflow and did not touch `main`, `release`, a tag, a release or a setting. The owner accepted it and asked its author to hold further pushes until the rename was recorded. A freeze for a later operation is announced to everyone who pushes, not only checked.
2. **What the smoke install showed about the README.** The owner installed Claude Code first, which the README assumed; ran `git status` in a clone, since the hosts need a project to work in; and had to work out that the `rtk.path` example's `/Users/you/` stands for the owner's own home folder. This pull request makes the first and third explicit in the README, and replaces its outdated tested-versions row. It also replaces the README's "Status: pre-release" line, which #19 missed.
3. **The README customers install.** These README changes reach `main` with this pull request. The copy in the installed plugin comes from `release` and changes with the next promoted version; until then it still opens with the staging note, which names the old repository.
