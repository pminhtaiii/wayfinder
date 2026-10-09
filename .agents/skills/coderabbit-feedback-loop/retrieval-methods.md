# Retrieval Methods — CodeRabbit Review Harvesting

Disclosed reference for [`coderabbit-feedback-loop`](SKILL.md) step 3 (Harvest). Two retrieval paths, in preference order.

## Path A: GitHub REST API (preferred)

Works for **public repositories** without authentication. For private repos, set a `GITHUB_TOKEN` header.

### 1. Find the PR number

```powershell
Invoke-RestMethod -Uri "https://api.github.com/repos/<owner>/<repo>/pulls?state=open" -Method Get
```

### 2. Fetch PR review comments (inline)

```powershell
Invoke-RestMethod -Uri "https://api.github.com/repos/<owner>/<repo>/pulls/<pr>/comments" -Method Get
```

Each comment object contains:
- `path` — file path
- `line` / `original_line` — line number
- `body` — comment text (markdown)
- `user.login` — filter for `coderabbitai[bot]`

### 3. Fetch PR issue comments (summary)

```powershell
Invoke-RestMethod -Uri "https://api.github.com/repos/<owner>/<repo>/issues/<pr>/comments" -Method Get
```

CodeRabbit posts its walkthrough summary as an issue comment. Filter by `user.login == "coderabbitai[bot]"`.

### 4. Check review completion

Poll until CodeRabbit's review appears:

```powershell
Invoke-RestMethod -Uri "https://api.github.com/repos/<owner>/<repo>/pulls/<pr>/reviews" -Method Get
```

Look for a review with `user.login == "coderabbitai[bot]"` and `state != "PENDING"`.

## Path B: Browser DevTools (fallback)

Use when API access fails (private repo, rate limiting, or CodeRabbit hasn't posted to GitHub yet).

### 1. Navigate to CodeRabbit Change Stack

Open the CodeRabbit Change Stack URL in the headless browser:

```
https://app.coderabbit.ai/change-stack/<owner>/<repo>/pull/<pr>
```

### 2. Bypass login

Click the **"Continue without login"** button if prompted.

### 3. Read layer list

The Change Stack breaks files into numbered **layers**. Each layer shows a comment count. Use `evaluate_script` to extract the full text:

```javascript
() => document.body.innerText
```

### 4. Click into layers with comments

Click each layer button that shows a non-zero comment count. After clicking, extract the comment text using `evaluate_script` to scrape `innerText` from the review surface elements.

### 5. Expand comment headers

CodeRabbit comments appear as collapsed headers (e.g. "Data Integrity & Integration"). Click each header `span` to expand the full comment body, then re-scrape the page text.

## Scoring

CodeRabbit does not always report a numeric score per file in the API. If scores are absent from the API response, check the Change Stack UI — scores appear as badges on each layer. If no scores are visible, treat "zero unresolved comments" as the convergence signal.
