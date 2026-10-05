# Dependency Security Advisories & Upstream Deferral Register

> **Policy-Version**: `1.0.0`  
> **Policy-Expires-At**: `2026-10-12T00:00:00.000Z`  
> **Policy Review Window**: 30 days  
> **Target Milestone**: Next.js 15 migration milestone  

## 1. Executive Summary & Policy Context

In accordance with **Feature 023 — Security Systems**, the repository enforces zero critical/high/moderate security vulnerabilities in automated supply-chain pipelines (`pnpm audit`, `pip-audit`, and `gitleaks`).

This register catalogs 102 unique GitHub Security Advisories (GHSAs) across transitive dependencies, including the verified local braces patch. It records the architectural justification for deferring major upstream upgrades, specifies compensating controls, and catalogs all ignored advisory identifiers configured in `package.json` (`pnpm.auditConfig.ignoreGhas`) and `pnpm-workspace.yaml` (`auditConfig.ignoreGhas`).

## 2. Upstream Blocker Rationale (Next.js 14 -> 15 Deferral)

- **Major Breaking Changes**: Upgrading to Next.js 15 requires extensive refactoring of synchronous route parameters (`params` and `searchParams` become Promises), fetch request caching defaults (`no-store` by default), Server Actions cookies mutations, and React 19 RC dependencies across `@web/frontend`.
- **Handoff Decision & Scope Boundary**: Per engineering handoff guidelines, upgrading Next.js across the frontend application is isolated to a dedicated framework migration milestone. Introducing breaking framework changes during Security Pipeline Remediation would invalidate existing Playwright E2E suites and disrupt active chat handoff contracts.
- **Transitive Lockfile Churn**: Forcing artificial version overrides across deeply nested dependencies (`tar`, `multer`, `qs`, `fast-uri`) risks introducing subtle runtime regressions in build tools (`@nestjs/cli`, `webpack`, `next`, `jest`).

## 3. Compensating Controls & Defense-in-Depth

| Threat / Vulnerability Vector | Affected Packages | Compensating Control in Flight Booking System |
|---|---|---|
| **Denial of Service (ReDoS / OOM)** | `brace-expansion`, `picomatch`, `minimatch`, `js-yaml`, `multer`, `qs`, `browserslist` | **Input Length Limits & In-Memory Guards**: The NestJS API enforces strict payload size limits via `ValidationPipe` and body-parser ceilings (max 100KB for chat and bookings). Query parameters are strictly parsed via type-safe DTOs. Build tools (`webpack`, `browserslist`) run strictly at build time in ephemeral CI containers, completely decoupled from runtime request processing. |
| **Path Traversal & Arbitrary File Overwrite** | `tar`, `tmp` | **Static & Isolated File Operations**: No user-uploaded archives are unpacked at runtime. Tar operations are restricted to build scripts and container image generation. File handling in `@api/backend` uses memory buffers without direct filesystem extraction. |
| **Server-Side Request Forgery (SSRF) / Host Confusion** | `fast-uri`, `next` | **Strict Loopback Isolation & Network Guards**: Backend microservices communicate exclusively over loopback (`127.0.0.1`). Next.js server actions validate target URLs against a pinned allowlist. Outbound HTTP calls in `@agent` and `@api` pass through centralized client proxies (`HttpService`, Duffel/Stripe SDKs). |
| **Authentication & Header Injection** | `next-auth`, `@nestjs/core` | **Centralized Auth Guards & Attestation**: User authentication uses pinned JWT tokens with rotating secrets (`JWT_SECRET`, `CLAIM_TOKEN_SECRET`). Session state is validated on the backend via NestJS guards rather than relying on client-side cookie decoding alone. |
| **DOM-based XSS** | `maplibre-gl`, `postcss` | **Strict Content Escaping & SAST Enforcement**: React DOM escaping handles all client-rendered variables. SAST rule `safe-html-interpolation` forbids raw `dangerouslySetInnerHTML`. MapLibre GL is restricted to static airport and route GeoJSON coordinates without user-controlled HTML popups. |
| **AI Agent Prompt / Tool Injection** | `langchain`, `@langchain/core`, `langsmith` | **GuardrailGateways & Sealed Capabilities**: AI tool execution is mediated by zero-authority `AdmissionContext`, sealed `TurnCapabilities`, and deterministic regex guardrails. Direct tool dispatch and raw payload logging are strictly prohibited and verified by custom Semgrep AST rules. |

## 4. Workspace Inventory of Deferred Advisories

Total unique advisories registered: **102**

Version ranges below cover the release lines represented in this workspace dependency audit; they are not exhaustive upstream affected or patched ranges. For example, `pnpm-lock.yaml` resolves `brace-expansion` 1.1.15 and 2.1.1, so its rows cover the relevant 1.x and 2.x ranges. Consult each linked advisory for other release lines, including 3.x, 4.x, and 5.x.

| GHSA ID | Package | Severity | Advisory Summary | Vulnerable Range | Patched Range |
|---|---|---|---|---|---|
| [GHSA-36xv-jgw5-4q75](https://github.com/advisories/GHSA-36xv-jgw5-4q75) | `@nestjs/core` | **MODERATE** | @nestjs/core Improperly Neutralizes Special Elements in Output Used by a Downstream Component ('Injection') | `<=11.1.17` | `>=11.1.18` |
| [GHSA-2g4f-4pwh-qvx6](https://github.com/advisories/GHSA-2g4f-4pwh-qvx6) | `ajv` | **MODERATE** | ajv has ReDoS when using `$data` option | `>=7.0.0-alpha.0 <8.18.0` | `>=8.18.0` |
| [GHSA-w5vr-8v7q-w6rv](https://github.com/advisories/GHSA-w5vr-8v7q-w6rv) | `baseline-browser-mapping` | **MODERATE** | baseline-browser-mapping process termination on invalid input causes denial of service | `>=2.0.0 <2.11.0` | `>=2.11.0` |
| [GHSA-3jxr-9vmj-r5cp](https://github.com/advisories/GHSA-3jxr-9vmj-r5cp) | `brace-expansion` | **HIGH** | brace-expansion: DoS via exponential-time expansion of consecutive non-expanding {} groups | `>=2.0.0 <2.1.2` | `>=2.1.2` |
| [GHSA-6j4f-fj2g-mc7p](https://github.com/advisories/GHSA-6j4f-fj2g-mc7p) | `brace-expansion` | **HIGH** | brace-expansion: DoS via uncontrolled recursion in parseCommaParts causing stack exhaustion | `<1.1.19, >=2.0.0 <2.1.5` | `>=1.1.19, >=2.1.5` |
| [GHSA-mh99-v99m-4gvg](https://github.com/advisories/GHSA-mh99-v99m-4gvg) | `brace-expansion` | **HIGH** | brace-expansion: DoS via unbounded expansion length causing an out-of-memory process crash | `<1.1.17` | `>=1.1.17` |
| [GHSA-q2hr-2g5m-vwhr](https://github.com/advisories/GHSA-q2hr-2g5m-vwhr) | `brace-expansion` | **MODERATE** | brace-expansion: Quadratic-time expansion of the `{a},b}` rewrite causes CPU denial of service | `<1.1.21, >=2.0.0 <2.1.7` | `>=1.1.21, >=2.1.7` |
| [GHSA-qhr7-859c-m2p7](https://github.com/advisories/GHSA-qhr7-859c-m2p7) | `brace-expansion` | **HIGH** | brace-expansion: DoS via uncontrolled recursion on nested brace groups causing stack exhaustion | `<1.1.20, >=2.0.0 <2.1.6` | `>=1.1.20, >=2.1.6` |
| [GHSA-rgw5-rvv9-x895](https://github.com/advisories/GHSA-rgw5-rvv9-x895) | `brace-expansion` | **HIGH** | brace-expansion: DoS via unbounded intermediate arrays, bypassing the CVE-2026-14257 mitigation | `>=2.0.0 <2.1.4` | `>=2.1.4` |
| [GHSA-73wf-gq98-2v4g](https://github.com/advisories/GHSA-73wf-gq98-2v4g) | `browserslist` | **HIGH** | Browserslist: Uncaught crash / prototype write via untrusted browserslist-stats.json custom stats (normalizeStats) | `<=4.28.6` | `>=4.28.7` |
| [GHSA-c83g-rgw3-j3cx](https://github.com/advisories/GHSA-c83g-rgw3-j3cx) | `browserslist` | **HIGH** | Browserslist: Unbounded memory growth (no cache eviction) via distinct query results, leading to eventual OOM | `<=4.28.6` | `>=4.28.7` |
| [GHSA-4c8g-83qw-93j6](https://github.com/advisories/GHSA-4c8g-83qw-93j6) | `fast-uri` | **HIGH** | fast-uri vulnerable to host confusion via failed IDN canonicalization | `>=3.0.0 <3.1.3` | `>=3.1.3` |
| [GHSA-7p8r-x3mc-p8w7](https://github.com/advisories/GHSA-7p8r-x3mc-p8w7) | `fast-uri` | **HIGH** | fast-uri vulnerable to host confusion via backslash authority introducer | `>=3.0.0 <3.1.5` | `>=3.1.5` |
| [GHSA-f65p-4m7j-42xc](https://github.com/advisories/GHSA-f65p-4m7j-42xc) | `fast-uri` | **HIGH** | fast-uri vulnerable to server-side request forgery via malformed IPv6 normalization | `>=3.0.0 <3.1.6` | `>=3.1.6` |
| [GHSA-fph4-wmhf-6fwf](https://github.com/advisories/GHSA-fph4-wmhf-6fwf) | `fast-uri` | **HIGH** | fast-uri vulnerable to server-side request forgery via repeated hostname percent-decoding | `>=3.1.2 <3.1.6` | `>=3.1.6` |
| [GHSA-jqff-g426-hqxp](https://github.com/advisories/GHSA-jqff-g426-hqxp) | `fast-uri` | **HIGH** | fast-uri vulnerable to host confusion via percent-encoded scheme normalization | `>=3.0.0 <3.1.6` | `>=3.1.6` |
| [GHSA-v2hh-gcrm-f6hx](https://github.com/advisories/GHSA-v2hh-gcrm-f6hx) | `fast-uri` | **HIGH** | fast-uri vulnerable to host confusion via literal backslash authority delimiter | `>=3.0.0 <=3.1.3` | `>=3.1.4` |
| [GHSA-5v7r-6r5c-r473](https://github.com/advisories/GHSA-5v7r-6r5c-r473) | `file-type` | **MODERATE** | file-type affected by infinite loop in ASF parser on malformed input with zero-size sub-header | `>=13.0.0 <21.3.1` | `>=21.3.1` |
| [GHSA-j47w-4g3g-c36v](https://github.com/advisories/GHSA-j47w-4g3g-c36v) | `file-type` | **MODERATE** | file-type: ZIP Decompression Bomb DoS via [Content_Types].xml entry | `>=20.0.0 <=21.3.1` | `>=21.3.2` |
| [GHSA-5j98-mcp5-4vw2](https://github.com/advisories/GHSA-5j98-mcp5-4vw2) | `glob` | **HIGH** | glob CLI: Command injection via -c/--cmd executes matches with shell:true | `>=10.2.0 <10.5.0` | `>=10.5.0` |
| [GHSA-2883-xcg3-v3hh](https://github.com/advisories/GHSA-2883-xcg3-v3hh) | `js-yaml` | **HIGH** | js-yaml: maxTotalMergeKeys does not limit CPU use for empty merge sources | `>=3.0.0 <3.15.2` | `>=3.15.2` |
| [GHSA-52cp-r559-cp3m](https://github.com/advisories/GHSA-52cp-r559-cp3m) | `js-yaml` | **HIGH** | js-yaml: YAML merge-key chains can force quadratic CPU consumption | `>=4.0.0 <4.3.0` | `>=4.3.0` |
| [GHSA-5p4m-2wfm-xmqj](https://github.com/advisories/GHSA-5p4m-2wfm-xmqj) | `js-yaml` | **HIGH** | JS-YAML: Quadratic CPU consumption in !!omap resolution (3.x and 4.x) — CVE-2026-59870 fix not backported | `>=3.0.0 <3.15.1` | `>=3.15.1` |
| [GHSA-h67p-54hq-rp68](https://github.com/advisories/GHSA-h67p-54hq-rp68) | `js-yaml` | **MODERATE** | JS-YAML: Quadratic-complexity DoS in merge key handling via repeated aliases | `<3.15.0` | `>=3.15.0` |
| [GHSA-r399-636x-v7f6](https://github.com/advisories/GHSA-r399-636x-v7f6) | `langchain` | **HIGH** | LangChain serialization injection vulnerability enables secret extraction | `<0.3.37` | `>=0.3.37` |
| [GHSA-3644-q5cj-c5c7](https://github.com/advisories/GHSA-3644-q5cj-c5c7) | `langsmith` | **HIGH** | LangSmith SDK: Public prompt pull deserializes untrusted manifests without trust boundary warning | `<0.6.0` | `>=0.6.0` |
| [GHSA-fw9q-39r9-c252](https://github.com/advisories/GHSA-fw9q-39r9-c252) | `langsmith` | **MODERATE** | LangSmith Client SDKs has Prototype Pollution in langsmith-sdk via Incomplete `__proto__` Guard in Internal lodash `set()` | `<=0.5.17` | `>=0.5.18` |
| [GHSA-rr7j-v2q5-chgv](https://github.com/advisories/GHSA-rr7j-v2q5-chgv) | `langsmith` | **MODERATE** | LangSmith SDK: Streaming token events bypass output redaction | `<=0.5.18` | `>=0.5.19` |
| [GHSA-f23m-r3pf-42rh](https://github.com/advisories/GHSA-f23m-r3pf-42rh) | `lodash` | **MODERATE** | lodash vulnerable to Prototype Pollution via array path bypass in `_.unset` and `_.omit` | `<=4.17.23` | `>=4.17.24` |
| [GHSA-r5fr-rjxr-66jc](https://github.com/advisories/GHSA-r5fr-rjxr-66jc) | `lodash` | **HIGH** | lodash vulnerable to Code Injection via `_.template` imports key names | `>=4.0.0 <=4.17.23` | `>=4.17.24` |
| [GHSA-xxjr-mmjv-4gpg](https://github.com/advisories/GHSA-xxjr-mmjv-4gpg) | `lodash` | **MODERATE** | Lodash has Prototype Pollution Vulnerability in `_.unset` and `_.omit` functions | `>=4.0.0 <=4.17.22` | `>=4.17.23` |
| [GHSA-jrc7-96c5-q579](https://github.com/advisories/GHSA-jrc7-96c5-q579) | `maplibre-gl` | **CRITICAL** | MapLibre GL JS: XSS Sanitizer Bypass in DOM.sanitize() via Live NamedNodeMap Removal Skip | `<=6.4.0` | `>=6.4.1` |
| [GHSA-23c5-xmqv-rm74](https://github.com/advisories/GHSA-23c5-xmqv-rm74) | `minimatch` | **HIGH** | minimatch ReDoS: nested *() extglobs generate catastrophically backtracking regular expressions | `>=9.0.0 <9.0.7` | `>=9.0.7` |
| [GHSA-3ppc-4f35-3m26](https://github.com/advisories/GHSA-3ppc-4f35-3m26) | `minimatch` | **HIGH** | minimatch has a ReDoS via repeated wildcards with non-matching literal in pattern | `>=9.0.0 <9.0.6` | `>=9.0.6` |
| [GHSA-7r86-cg39-jmmj](https://github.com/advisories/GHSA-7r86-cg39-jmmj) | `minimatch` | **HIGH** | minimatch has ReDoS: matchOne() combinatorial backtracking via multiple non-adjacent GLOBSTAR segments | `>=9.0.0 <9.0.7` | `>=9.0.7` |
| [GHSA-3p4h-7m6x-2hcm](https://github.com/advisories/GHSA-3p4h-7m6x-2hcm) | `multer` | **MODERATE** | Multer vulnerable to Denial of Service via incomplete cleanup of aborted uploads | `>=2.0.0-alpha.1 <2.2.0` | `>=2.2.0` |
| [GHSA-535w-7cp7-47q4](https://github.com/advisories/GHSA-535w-7cp7-47q4) | `multer` | **HIGH** | multer vulnerable to Denial of Service via oversized array index in field names | `<2.3.0` | `>=2.3.0` |
| [GHSA-5528-5vmv-3xc2](https://github.com/advisories/GHSA-5528-5vmv-3xc2) | `multer` | **HIGH** | Multer Vulnerable to Denial of Service via Uncontrolled Recursion | `<2.1.1` | `>=2.1.1` |
| [GHSA-72gw-mp4g-v24j](https://github.com/advisories/GHSA-72gw-mp4g-v24j) | `multer` | **HIGH** | Multer vulnerable to Denial of Service via deeply nested field names | `>=1.0.0 <2.2.0` | `>=2.2.0` |
| [GHSA-v52c-386h-88mc](https://github.com/advisories/GHSA-v52c-386h-88mc) | `multer` | **HIGH** | Multer vulnerable to Denial of Service via resource exhaustion | `<2.1.0` | `>=2.1.0` |
| [GHSA-wc9g-mqfw-jrwm](https://github.com/advisories/GHSA-wc9g-mqfw-jrwm) | `multer` | **HIGH** | multer vulnerable to Denial of Service via crafted multipart field names | `<2.3.0` | `>=2.3.0` |
| [GHSA-xf7r-hgr6-v32p](https://github.com/advisories/GHSA-xf7r-hgr6-v32p) | `multer` | **HIGH** | Multer vulnerable to Denial of Service via incomplete cleanup | `<2.1.0` | `>=2.1.0` |
| [GHSA-28wg-ghj8-5hjv](https://github.com/advisories/GHSA-28wg-ghj8-5hjv) | `nanoid` | **HIGH** | nanoid: non-secure generators can loop indefinitely with negative size | `<3.3.16` | `>=3.3.16` |
| [GHSA-2v37-7h3g-55p8](https://github.com/advisories/GHSA-2v37-7h3g-55p8) | `nanoid` | **HIGH** | nanoid: custom generators can loop indefinitely when size is zero | `<3.3.18` | `>=3.3.18` |
| [GHSA-2xp9-vwfh-vxw4](https://github.com/advisories/GHSA-2xp9-vwfh-vxw4) | `next` | **CRITICAL** | Next.js: Unauthenticated Remote Code Execution in Image Optimization API when AVIF files are used | `>=10.0.0 <15.5.24` | `>=15.5.24` |
| [GHSA-36qx-fr4f-26g5](https://github.com/advisories/GHSA-36qx-fr4f-26g5) | `next` | **HIGH** | Next.js has a Middleware / Proxy bypass in Pages Router applications using i18n | `>=12.2.0 <15.5.16` | `>=15.5.16` |
| [GHSA-3x4c-7xq6-9pq8](https://github.com/advisories/GHSA-3x4c-7xq6-9pq8) | `next` | **MODERATE** | Next.js: Unbounded next/image disk cache growth can exhaust storage | `>=10.0.0 <15.5.14` | `>=15.5.14` |
| [GHSA-4342-x723-ch2f](https://github.com/advisories/GHSA-4342-x723-ch2f) | `next` | **MODERATE** | Next.js Improper Middleware Redirect Handling Leads to SSRF | `>=0.9.9 <14.2.32` | `>=14.2.32` |
| [GHSA-4633-3j49-mh5q](https://github.com/advisories/GHSA-4633-3j49-mh5q) | `next` | **MODERATE** | Next.js: Cache confusion of response bodies for requests with bodies containing invalid UTF-8 byte sequences | `>=13.0.0 <15.5.21` | `>=15.5.21` |
| [GHSA-4c39-4ccg-62r3](https://github.com/advisories/GHSA-4c39-4ccg-62r3) | `next` | **MODERATE** | Next.js: Unbounded Server Action payload in Edge runtime | `>=13.0.0 <15.5.21` | `>=15.5.21` |
| [GHSA-5j59-xgg2-r9c4](https://github.com/advisories/GHSA-5j59-xgg2-r9c4) | `next` | **HIGH** | Next has a Denial of Service with Server Components - Incomplete Fix Follow-Up | `>=13.3.1-canary.0 <14.2.35` | `>=14.2.35` |
| [GHSA-68g3-v927-f742](https://github.com/advisories/GHSA-68g3-v927-f742) | `next` | **MODERATE** | Next.js: Cache confusion of response bodies for requests with bodies | `>=13.0.0 <15.5.21` | `>=15.5.21` |
| [GHSA-7gfc-8cq8-jh5f](https://github.com/advisories/GHSA-7gfc-8cq8-jh5f) | `next` | **HIGH** | Next.js authorization bypass vulnerability | `>=9.5.5 <14.2.15` | `>=14.2.15` |
| [GHSA-7m27-7ghc-44w9](https://github.com/advisories/GHSA-7m27-7ghc-44w9) | `next` | **MODERATE** | Next.js Allows a Denial of Service (DoS) with Server Actions | `>=14.0.0 <14.2.21` | `>=14.2.21` |
| [GHSA-89xv-2m56-2m9x](https://github.com/advisories/GHSA-89xv-2m56-2m9x) | `next` | **HIGH** | Next.js: Server-Side Request Forgery in Server Actions on custom servers | `>=14.1.1 <15.5.21` | `>=15.5.21` |
| [GHSA-8h8q-6873-q5fj](https://github.com/advisories/GHSA-8h8q-6873-q5fj) | `next` | **HIGH** | Next.js Vulnerable to Denial of Service with Server Components | `>=13.0.0 <15.5.16` | `>=15.5.16` |
| [GHSA-955p-x3mx-jcvp](https://github.com/advisories/GHSA-955p-x3mx-jcvp) | `next` | **MODERATE** | Next.js: Unauthenticated disclosure of internal Server Function endpoints | `>=13.0.0 <15.5.21` | `>=15.5.21` |
| [GHSA-9g9p-9gw9-jx7f](https://github.com/advisories/GHSA-9g9p-9gw9-jx7f) | `next` | **MODERATE** | Next.js self-hosted applications vulnerable to DoS via Image Optimizer remotePatterns configuration | `>=10.0.0 <15.5.10` | `>=15.5.10` |
| [GHSA-c4j6-fc7j-m34r](https://github.com/advisories/GHSA-c4j6-fc7j-m34r) | `next` | **HIGH** | Next.js vulnerable to server-side request forgery in applications using WebSocket upgrades | `>=13.4.13 <15.5.16` | `>=15.5.16` |
| [GHSA-f82v-jwr5-mffw](https://github.com/advisories/GHSA-f82v-jwr5-mffw) | `next` | **CRITICAL** | Authorization Bypass in Next.js Middleware | `>=14.0.0 <14.2.25` | `>=14.2.25` |
| [GHSA-ffhc-5mcf-pf4q](https://github.com/advisories/GHSA-ffhc-5mcf-pf4q) | `next` | **MODERATE** | Next.js vulnerable to cross-site scripting in App Router applications using CSP nonces | `>=13.4.0 <15.5.16` | `>=15.5.16` |
| [GHSA-g5qg-72qw-gw5v](https://github.com/advisories/GHSA-g5qg-72qw-gw5v) | `next` | **MODERATE** | Next.js Affected by Cache Key Confusion for Image Optimization API Routes | `>=0.9.9 <14.2.31` | `>=14.2.31` |
| [GHSA-g77x-44xx-532m](https://github.com/advisories/GHSA-g77x-44xx-532m) | `next` | **MODERATE** | Denial of Service condition in Next.js image optimization | `>=10.0.0 <14.2.7` | `>=14.2.7` |
| [GHSA-ggv3-7p47-pfv8](https://github.com/advisories/GHSA-ggv3-7p47-pfv8) | `next` | **MODERATE** | Next.js: HTTP request smuggling in rewrites | `>=9.5.0 <15.5.13` | `>=15.5.13` |
| [GHSA-gp8f-8m3g-qvj9](https://github.com/advisories/GHSA-gp8f-8m3g-qvj9) | `next` | **HIGH** | Next.js Cache Poisoning | `>=14.0.0 <14.2.10` | `>=14.2.10` |
| [GHSA-gx5p-jg67-6x7h](https://github.com/advisories/GHSA-gx5p-jg67-6x7h) | `next` | **MODERATE** | Next.js has cross-site scripting in beforeInteractive scripts with untrusted input | `>=13.0.0 <15.5.16` | `>=15.5.16` |
| [GHSA-h25m-26qc-wcjf](https://github.com/advisories/GHSA-h25m-26qc-wcjf) | `next` | **HIGH** | Next.js HTTP request deserialization can lead to DoS when using insecure React Server Components | `>=13.0.0 <15.0.8` | `>=15.0.8` |
| [GHSA-h64f-5h5j-jqjh](https://github.com/advisories/GHSA-h64f-5h5j-jqjh) | `next` | **MODERATE** | Next.js has a Denial of Service in the Image Optimization API | `>=10.0.0 <15.5.16` | `>=15.5.16` |
| [GHSA-m99w-x7hq-7vfj](https://github.com/advisories/GHSA-m99w-x7hq-7vfj) | `next` | **HIGH** | Next.js: Denial of Service in App Router using Server Actions | `>=13.0.0 <15.5.21` | `>=15.5.21` |
| [GHSA-mwv6-3258-q52c](https://github.com/advisories/GHSA-mwv6-3258-q52c) | `next` | **HIGH** | Next Vulnerable to Denial of Service with Server Components | `>=13.3.0 <14.2.34` | `>=14.2.34` |
| [GHSA-p293-qw3h-jr36](https://github.com/advisories/GHSA-p293-qw3h-jr36) | `next` | **CRITICAL** | Next.js: Unauthenticated Remote Code Execution on windows-hosted servers | `>=13.4.0 <15.5.24` | `>=15.5.24` |
| [GHSA-p9j2-gv94-2wf4](https://github.com/advisories/GHSA-p9j2-gv94-2wf4) | `next` | **HIGH** | Next.js: Server-Side Request Forgery in rewrites via attacker-controlled destination hostname | `>=12.0.0 <15.5.21` | `>=15.5.21` |
| [GHSA-q4gf-8mx6-v5v3](https://github.com/advisories/GHSA-q4gf-8mx6-v5v3) | `next` | **HIGH** | Next.js has a Denial of Service with Server Components | `>=13.0.0 <15.5.15` | `>=15.5.15` |
| [GHSA-wfc6-r584-vfw7](https://github.com/advisories/GHSA-wfc6-r584-vfw7) | `next` | **MODERATE** | Next.js vulnerable to cache poisoning in React Server Component responses | `>=14.2.0 <15.5.16` | `>=15.5.16` |
| [GHSA-xv57-4mr9-wg8v](https://github.com/advisories/GHSA-xv57-4mr9-wg8v) | `next` | **MODERATE** | Next.js Content Injection Vulnerability for Image Optimization | `>=0.9.9 <14.2.31` | `>=14.2.31` |
| [GHSA-7rqj-j65f-68wh](https://github.com/advisories/GHSA-7rqj-j65f-68wh) | `next-auth` | **CRITICAL** | Auth.js: Email normalizer validates the address before Unicode normalization, allowing a homoglyph @ bypass | `>=4.10.3 <4.24.15` | `>=4.24.15` |
| [GHSA-x445-f3h2-j279](https://github.com/advisories/GHSA-x445-f3h2-j279) | `next-auth` | **MODERATE** | Auth.js: OAuth state, nonce, and PKCE check cookies are not bound to the provider that created them | `<=4.24.14` | `>=4.24.15` |
| [GHSA-xmf8-cvqr-rfgj](https://github.com/advisories/GHSA-xmf8-cvqr-rfgj) | `next-auth` | **HIGH** | Auth.js: getToken() throws an uncaught exception on malformed Bearer authorization headers | `>=4.0.6 <=4.24.14` | `>=4.24.15` |
| [GHSA-3v7f-55p6-f55p](https://github.com/advisories/GHSA-3v7f-55p6-f55p) | `picomatch` | **MODERATE** | Picomatch: Method Injection in POSIX Character Classes causes incorrect Glob Matching | `>=4.0.0 <4.0.4` | `>=4.0.4` |
| [GHSA-c2c7-rcm5-vvqj](https://github.com/advisories/GHSA-c2c7-rcm5-vvqj) | `picomatch` | **HIGH** | Picomatch has a ReDoS vulnerability via extglob quantifiers | `>=4.0.0 <4.0.4` | `>=4.0.4` |
| [GHSA-6g55-p6wh-862q](https://github.com/advisories/GHSA-6g55-p6wh-862q) | `postcss` | **HIGH** | PostCSS: Arbitrary file read and information disclosure via attacker-controlled sourceMappingURL in CSS comments | `<=8.5.11` | `>=8.5.12` |
| [GHSA-fxqj-rqcc-2cmp](https://github.com/advisories/GHSA-fxqj-rqcc-2cmp) | `postcss` | **MODERATE** | PostCSS: incomplete fix of GHSA-6g55-p6wh-862q — attacker-controlled sourceMappingURL reads arbitrary .map files when `from` is unset | `<=8.5.22` | `>=8.5.23` |
| [GHSA-qx2v-qp2m-jg93](https://github.com/advisories/GHSA-qx2v-qp2m-jg93) | `postcss` | **MODERATE** | PostCSS has XSS via Unescaped </style> in its CSS Stringify Output | `<8.5.10` | `>=8.5.10` |
| [GHSA-r28c-9q8g-f849](https://github.com/advisories/GHSA-r28c-9q8g-f849) | `postcss` | **HIGH** | PostCSS: Path Traversal in Previous Source Map Auto-Loading (sourceMappingURL) leads to Arbitrary .map File Disclosure | `<=8.5.17` | `>=8.5.18` |
| [GHSA-4mjr-xmp4-gh2g](https://github.com/advisories/GHSA-4mjr-xmp4-gh2g) | `qs` | **MODERATE** | qs: Denial of Service via Attacker Controlled isBuffer | `>=2.2.5 <6.16.0` | `>=6.16.0` |
| [GHSA-q8mj-m7cp-5q26](https://github.com/advisories/GHSA-q8mj-m7cp-5q26) | `qs` | **MODERATE** | qs has a remotely triggerable DoS: qs.stringify crashes with TypeError on null/undefined entries in comma-format arrays when encodeValuesOnly is set | `>=6.11.1 <=6.15.1` | `>=6.15.2` |
| [GHSA-x5fp-wj9c-mxmx](https://github.com/advisories/GHSA-x5fp-wj9c-mxmx) | `qs` | **MODERATE** | qs array-limit bypass via bracket-key comma parsing | `>=6.14.2 <=6.15.3` | `>=6.15.4` |
| [GHSA-23hp-3jrh-7fpw](https://github.com/advisories/GHSA-23hp-3jrh-7fpw) | `tar` | **CRITICAL** | node-tar: Decompression/parse DoS via unlimited input | `<=7.5.18` | `>=7.5.19` |
| [GHSA-34x7-hfp2-rc4v](https://github.com/advisories/GHSA-34x7-hfp2-rc4v) | `tar` | **HIGH** | node-tar Vulnerable to Arbitrary File Creation/Overwrite via Hardlink Path Traversal | `<7.5.7` | `>=7.5.7` |
| [GHSA-83g3-92jg-28cx](https://github.com/advisories/GHSA-83g3-92jg-28cx) | `tar` | **HIGH** | Arbitrary File Read/Write via Hardlink Target Escape Through Symlink Chain in node-tar Extraction | `<7.5.8` | `>=7.5.8` |
| [GHSA-8qq5-rm4j-mr97](https://github.com/advisories/GHSA-8qq5-rm4j-mr97) | `tar` | **HIGH** | node-tar is Vulnerable to Arbitrary File Overwrite and Symlink Poisoning via Insufficient Path Sanitization | `<=7.5.2` | `>=7.5.3` |
| [GHSA-8x88-c5mf-7j5w](https://github.com/advisories/GHSA-8x88-c5mf-7j5w) | `tar` | **HIGH** | node-tar: Negative tar entry size causes infinite loop in archive replace | `<=7.5.17` | `>=7.5.18` |
| [GHSA-9ppj-qmqm-q256](https://github.com/advisories/GHSA-9ppj-qmqm-q256) | `tar` | **HIGH** | node-tar Symlink Path Traversal via Drive-Relative Linkpath | `<=7.5.10` | `>=7.5.11` |
| [GHSA-gvwx-54wh-qm9j](https://github.com/advisories/GHSA-gvwx-54wh-qm9j) | `tar` | **MODERATE** | node-tar: Uncaught Exception DoS via NUL byte in PAX path/linkpath records | `<=7.5.16` | `>=7.5.17` |
| [GHSA-qffp-2rhf-9h96](https://github.com/advisories/GHSA-qffp-2rhf-9h96) | `tar` | **HIGH** | tar has Hardlink Path Traversal via Drive-Relative Linkpath | `<=7.5.9` | `>=7.5.10` |
| [GHSA-r292-9mhp-454m](https://github.com/advisories/GHSA-r292-9mhp-454m) | `tar` | **HIGH** | node-tar: Uncontrolled recursion in mapHas/filesFilter allows uncatchable stack-overflow DoS via crafted long-path tar with member selection | `<=7.5.20` | `>=7.5.21` |
| [GHSA-r6q2-hw4h-h46w](https://github.com/advisories/GHSA-r6q2-hw4h-h46w) | `tar` | **HIGH** | Race Condition in node-tar Path Reservations via Unicode Ligature Collisions on macOS APFS | `<=7.5.3` | `>=7.5.4` |
| [GHSA-vmf3-w455-68vh](https://github.com/advisories/GHSA-vmf3-w455-68vh) | `tar` | **MODERATE** | node-tar applies PAX size override to intermediary GNU long-name/long-link headers, causing tar parser interpretation differential (file smuggling) | `<=7.5.15` | `>=7.5.16` |
| [GHSA-w8wr-v893-vjvp](https://github.com/advisories/GHSA-w8wr-v893-vjvp) | `tar` | **MODERATE** | node-tar: Process crash via PAX numeric path type confusion | `<=7.5.17` | `>=7.5.18` |
| [GHSA-ph9p-34f9-6g65](https://github.com/advisories/GHSA-ph9p-34f9-6g65) | `tmp` | **HIGH** | tmp has Path Traversal via unsanitized prefix/postfix that enables directory escape | `<0.2.6` | `>=0.2.6` |
| [GHSA-w5hq-g745-h8pq](https://github.com/advisories/GHSA-w5hq-g745-h8pq) | `uuid` | **MODERATE** | uuid: Missing buffer bounds check in v3/v5/v6 when buf is provided | `<11.1.1` | `>=11.1.1` |

### Locally patched braces advisory

| Advisory | Package | Severity | Remediation | Affected published versions | Published patch |
|---|---|---|---|---|---|
| [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) | `braces` | **HIGH** | Verified local nesting-depth patch; see control below | `<=3.0.3` | None as of 2026-10-03 |

User-directed CI remediation on 2026-10-03 backports the source guards from [upstream PR #72](https://github.com/micromatch/braces/pull/72), commit `d0d575e`, into the pinned `braces@3.0.3` pnpm patch. Parser nesting and recursive compile/expand/stringify traversal are bounded at 100 levels, including caller-supplied ASTs. Deep input is rejected with a controlled syntax error; normal patterns retain their results.

Reviewed patch SHA-256 and pnpm 10.34.5 lock patch hash: `795ff4ec62054830af82791060bccad7e6b551a7399488cbbd5dcb6017931861`. Patch path: `patches/braces@3.0.3.patch`. CI jobs use the same pnpm version so frozen installation and security scanning agree on the lock format.

The audit registry still reports the published package version as affected. This single advisory is acknowledged through the existing exception mechanism only when the scanner verifies the reviewed patch digest and pnpm registration. Frozen installation and behavioral regressions run before the strict CI scan. Missing, altered, or unregistered patches fail closed; other findings retain their existing treatment. The exception expires with the current policy on **2026-10-12T00:00:00.000Z**. Replace the local patch with an upstream fixed release and remove this exception when one is published and compatibility checks pass.

## 5. Review Cadence & Sunsetting Policy

1. **Quarterly Review**: This exception register is re-evaluated every quarter or during scheduled major framework upgrade cycles.
2. **Emergency Revocation**: If a remote code execution (RCE) advisory with a viable public exploit chain affects a public runtime endpoint, an emergency patch or selective dependency override must be deployed within 24 hours.
3. **Next.js 15 Milestone**: Upon initiation of the Next.js 15 framework upgrade, all 31 Next.js advisories and their associated transitive dependencies will be retired from this register.
