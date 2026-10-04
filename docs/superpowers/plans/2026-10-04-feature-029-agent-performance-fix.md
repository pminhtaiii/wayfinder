# T066: Agent security performance gate

> For agentic workers: complete this plan once, preserve existing benchmark and security assertions, and record the exact gate evidence before committing. Do not edit guardrail or test source unless a new source-level regression is established and root approves a revised plan.

## Goal

Complete the guarded non-Redis agent gate with its existing SC-004 ceilings and security coverage. Record the Windows process setup that produced a clean pass. This task ends with documentation and verification evidence; it does not change runtime behavior, benchmark logic, sample counts, or thresholds.

## Architecture

No application path changes. The only verification adjustment applies Windows ABOVE_NORMAL_PRIORITY_CLASS (0x8000) to the owned Python process executing pytest. The process records its original class, verifies the temporary class, and restores the original class in a finally block. The shell and machine-wide settings remain untouched.

## Tech Stack

Windows PowerShell, Python 3.11, uv, pytest, the CI sitecustomize network guard, and the existing agent security-performance fixtures.

## Spec

Feature 029 task T066 in specs/029-duffel-provider-narrowing/tasks.md. Preserve every injection signature and reason, encoded and Unicode attack detection, byte bounds, the 50-sample percentile calculations, and all existing performance ceilings.

## Constraints

- Do not edit production or test source, test selection, tolerance variables, thresholds, or CI configuration.
- Run the full guarded suite once under the process-local setup below. If it fails, stop and return the log; do not retry or change code.
- Verify the network guard blocks a synthetic external address before the suite.
- Keep the 12 redis_integration exclusions and existing four skips visible in the report.
- Restore and verify the original Python process priority before exit. Never use realtime or machine-wide priority changes.

## RED evidence and diagnosis

The three current full guarded failures are recorded in:

- task-2-agent-full-guarded.log: input.injection p95 2.4164 ms against 2.000 ms.
- task-2-agent-full-guarded-retry.log: cjk_8400_bytes p95 351.6747 ms against 100.000 ms.
- task-2-agent-full-guarded-user-retry.log: input.injection p95 2.2666 ms against 2.000 ms.

The earlier 3.0562 ms result belongs to the separate T050 diagnostic in .superpowers/sdd/2026-10-03-feature-029-neutral-identifiers/benchmark-diagnosis-2.md; it is not a fourth T066 run.

The unchanged focused public gateway test passes in isolation. A prefix replay ran the same 343 selected tests preceding the benchmark, then the benchmark: 343 passed, one existing skip, 12 marker deselections; input.injection p95 0.4011 ms and turn p95 1.3896 ms. The pre-benchmark snapshot showed tracemalloc inactive, GC enabled, no trace/profile hooks, no asyncio debug override or active loop, and one thread. A separate exact-input timing probe measured injection wall p95 0.4023 ms; batched thread CPU was roughly 0.31 ms/call but too coarsely quantized for a replacement per-call metric. These probes found no persistent scanner or suite-prefix cause. They do not prove the OS scheduling cause.

## Exact launch and guard

From C:\Booking Systems, set the same guarded agent environment and confirm sitecustomize rejects the synthetic external connection before network activity:

    $env:UV_CACHE_DIR = 'C:\Booking Systems\.uv-cache'
    $env:PYTHONPATH = 'C:\Booking Systems\tests\ci\python;C:\Booking Systems\apps\agent\src'
    @'
    import socket
    import sitecustomize

    print(sitecustomize.__file__)
    try:
        socket.create_connection(('api.duffel.com', 443), 0.01)
    except RuntimeError as error:
        if '[ci-network-guard]' not in str(error):
            raise
        print(str(error))
    else:
        raise SystemExit('network guard did not reject the external destination')
    '@ | uv run --no-sync --package agent python -

Run the unchanged suite in one Python process. The runner prints the previous, active, and restored priority classes; it uses pytest's existing tests and thresholds:

    $runner = @'
    import ctypes
    import runpy
    import sys
    from ctypes import wintypes

    kernel32 = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel32.GetCurrentProcess.restype = wintypes.HANDLE
    kernel32.GetPriorityClass.argtypes = [wintypes.HANDLE]
    kernel32.GetPriorityClass.restype = wintypes.DWORD
    kernel32.SetPriorityClass.argtypes = [wintypes.HANDLE, wintypes.DWORD]
    kernel32.SetPriorityClass.restype = wintypes.BOOL

    process = kernel32.GetCurrentProcess()
    original = kernel32.GetPriorityClass(process)
    if not original:
        raise ctypes.WinError(ctypes.get_last_error())
    print(f'[AGENT-PRIORITY] prior_class=0x{original:04X}')
    if not kernel32.SetPriorityClass(process, 0x8000):
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        active = kernel32.GetPriorityClass(process)
        print(f'[AGENT-PRIORITY] active_class=0x{active:04X}')
        if active != 0x8000:
            raise RuntimeError('pytest process priority did not become AboveNormal')

        sys.argv = [
            'pytest', '-p', 'no:cacheprovider', '--capture=tee-sys', '-m',
            'not redis_integration', 'apps/agent/tests',
        ]
        runpy.run_module('pytest', run_name='__main__')
    finally:
        if not kernel32.SetPriorityClass(process, original):
            raise ctypes.WinError(ctypes.get_last_error())
        restored = kernel32.GetPriorityClass(process)
        print(f'[AGENT-PRIORITY] restored_class=0x{restored:04X}')
        if restored != original:
            raise RuntimeError('pytest process priority was not restored')
    '@
    $runner | uv run --no-sync --package agent python - 2>&1 | Tee-Object -LiteralPath '.superpowers\sdd\2026-10-04-feature-029-final-verification\task-3-agent-full-guarded-priority.log'
    $agentExitCode = $LASTEXITCODE
    exit $agentExitCode

## Launch gate and completion checklist

- [x] Guard preflight loaded sitecustomize and blocked api.duffel.com:443.
- [x] Full guarded suite exited 0; 1302 passed, 4 skipped, 12 deselected.
- [x] input.injection p95 stayed below the unchanged 2.000 ms limit; Unicode and hostile-input gates passed.
- [x] The Python process changed 0x0020 to 0x8000 and restored 0x0020.
- [x] Ruff check and format passed; no Python typecheck applies because source did not change.
- [x] context/testing.md records the verified process-local Windows instruction.
- [x] Save the plan and T066 report, review the diff, and stage only the T066 documentation.

Commit only this plan and context/testing.md after the checks above pass; leave all other worktree changes untouched.
