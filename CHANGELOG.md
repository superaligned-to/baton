# Changelog

## 0.2.0 - 2026-10-28

- Add challenges. `challenge()` locks a tool until the agent calls a tool, completes a flow, or an application check passes. Attach one to a step with `withChallenge()`, or wrap any handler with `.func()`.
- A step with challenges accepts proof from other flows in its `proof_token` array.
- Add the `challenge_required` error code and the `Tool`, `FlowRef`, `Challenge`, `ChallengeConfig` and `Locked` types.
- Support Node 22.9 and later.

## 0.1.0 - 2026-10-23

- Initial release.
