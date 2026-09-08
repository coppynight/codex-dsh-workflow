# DSH-led exploration checkpoint

Updated: 2026-09-09, Asia/Shanghai. User authorized autonomous overnight exploration,
prototype implementation and real comparisons. Direction: cheap DSH controller,
optional Astra expert advice, near strong-model delivery at a target 10% task cost.
These are hypotheses, not measured claims. Product need not be a skill.

## Latest checkpoint — approximately 00:49 Asia/Shanghai

- Prototype files: prototype/{codex,runner,protocol,usage,dsh-accounting,consult-mcp,isolated-host,workspace}.mjs.
- Chosen candidate shape: standard DSH preset plus a native MCP consult_astra tool,
  with an isolated Host/home per task, original credentials injected only into the
  owned child environment, automatic titles disabled, no user defaults changed.
- Native Astra read/write/test probe passed. Policy bypass was not used.
- Freeze: .local-runs/dsh-led/pilot-01/freeze.json. Three small component engineering
  pilots, not representative application delivery. All three Astra arms finished
  and pass the corrected frozen acceptance; API-equivalent costs approximately
  $0.358182, $0.426678, $0.420338. Never rerun a completed arm under the same ID.
- Important disclosed acceptance erratum: incremental-observation initially
  required explicit failureSeen=false although the task did not. Corrected before
  either DSH run; original test/result preserved; Astra source/model run unchanged.
  Budget zero-reservation wording clarified before any budget arm; all arm prompts
  updated together. See pilot-01/erratum.json and budget-clarification.json.
- DSH-alone incremental-observation passed: 191.5s, $0.04680276, complete official
  per-turn usage fold, no descendants. Native Astra: 111.0s, $0.358182. This first
  sample is 13.1% cost and 1.73× execution time; it does not establish 90/10.
- Active: incremental-observation dsh-advisor, exec session 13442, isolated Host PID
  5028 on port 58808. No expert consultation seen at this checkpoint.
- Finished Host (not yet shut down): observation-alone PID 26260, port 64585.
- Prepared only, NO model run yet: usage-ledger dsh-alone Host PID 27036, port 60649.
- All records and private raw events are under ignored .local-runs; isolated homes
  live outside repo under LOCALAPPDATA/dsh-led-private. Do not publish reasoning,
  credentials, token-bearing URLs, whole private settings or account metadata.
- Current paid pilot/probe spend is well below the initial $15 equivalent / $2
  DeepSeek stop thresholds. Root development/research usage remains separate and
  must be disclosed as unallocated development, not claimed free.

## Remaining immediate work

1. Finish five remaining DSH arms sequentially. Prepare isolated hosts as needed;
   run-arm dynamically reads workflowConfig before importing the bridge.
2. Inspect actual MCP availability and model-owned consultation. A no-consult run
   is valid DSH behavior, not evidence of expert benefit.
3. Complete independent review/fix of prototype cancellation, ledger completeness,
   claims and subprocess cleanup. Some earlier completed arms ran an earlier harness
   revision; retain this provenance, don't imply one frozen production runtime.
4. If all cheap-alone results already match and consultant unused, add a small,
   explicitly new phase testing lower cheap-model effort and a harder realistic
   integration task. Record a revised budget/selection before any paid run.
5. Export sanitized evidence, replay acceptance, run repository tests, document and
   publish a truthful project update. Do not claim generic capability or quota multiples.

### Checkpoint around 01:02

- usage-ledger dsh-alone passed (321.3s, $0.071875584); no expert/descendants.
- observation dsh-advisor passed (211.5s, $0.0474186); ZERO consultations. Do not
  claim expert benefit from this equality.
- Native MCP adapter paid capability probe passed: one request cost $0.069834,
  same-ID replay returned cached advice, second ID rejected at configured cap.
  This is an explicit adapter probe, not DSH choosing to consult.
- Batch exec 70189 is running finish-pilot.mjs: usage-ledger dsh-advisor, then
  budget-reservations dsh-alone, then budget-reservations dsh-advisor. Do not duplicate.
- Prepared but NOT started: pilot-low-01, six cheap arms with low reasoning effort.
  Phase 2 rationale: first two high-effort DSH tasks have 22k–45k output/reasoning
  tokens and 1.7–2× native runtime. Compare low alone vs low+optional expert against
  the existing three Astra baselines. New low freeze written before these runs.
  This is exploratory reuse of cases, not new held-out confirmation. Aggregate
  monetary envelope remains $15 equivalent / $2 DeepSeek. At most 6 extra cheap
  runs have now been authorized by the bounded investigation, no new strong baselines.
- Run low only AFTER current high batch completes; budget.mjs now checks aggregate
  recorded spend and missing costs before each new batch trial.
- Prototype offline tests: 6 passed. Existing repo tests: 114 passed, 2 live checks
  skipped, zero failures. These are correctness checks, not model-performance evidence.

## Active work

- Root owns repository changes and experiment orchestration.
- Read-only architecture review: portable_skill_review.
- Read-only experiment-method review: evidence_method_review.
- Local DSH 0.1.2-rc.1 Host healthy; model catalog ready for V4 Flash high.
- Claude not invoked: no current-session network confirmation.
- Heartbeat automation id: dsh; hourly, at most eight wakes, stop by 2026-09-09 08:00 Asia/Shanghai.

## Boundaries and budget

- Reuse native authentication, never display/copy credentials or raw private logs.
- No subscriptions, credits, usage resets, or purchases.
- Initial paid experiment envelope: up to 3 task cases × 3 arms, plus 2 capability
  probes and at most 3 diagnostic expert consultations. Expand only after review
  of recorded results, with explicit checkpoint update; do not silently repeat runs.
- Stop new paid work if recorded experiment API-equivalent spend reaches USD 15
  or DeepSeek estimated external spend reaches USD 2. This is a stop-before-next-call
  threshold, not a hard billing cap; in-flight requests and missing usage can overshoot.
- Missing usage stops expansion and invalidates complete-cost claims.
- At most one live experiment per runtime initially; 10-minute task deadline,
  at most two expert consultations per mixed run, no automatic fallback to a
  complete Astra rewrite inside the cheap arm.
- A policy denial is recorded; do not retry the same action with bypass flags.
- No original-model tool restrictions introduced to manufacture savings.
- Isolated workspaces per attempt; save IDs before writes; no ambiguous resubmission.
- Public artifacts contain prompts, source snapshots, sanitized metrics, actual
  acceptance and caveats. Raw model reasoning/account data stay local.

## Next

1. Implement native Codex capture and verify read/write/test capability with a
   bounded probe. Prior experiments had CLI policy blocks: do not recycle their
   tool-free baseline as a native benchmark.
2. Implement a deterministic DSH session runner with optional structured expert
   requests; the program relays requests without model-based human orchestration.
3. Freeze tasks and acceptance before running the three arms. Preserve all failures.
4. Produce runnable artifact, replayable evidence, measured conclusion and product
   recommendation. Keep previous experiments intact.
