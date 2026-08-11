/**
 * Advisory review gate for pull requests.
 *
 * Passes when the current PR head has an independent approval, via either:
 * 1. a native APPROVED review from a non-author whose review commit equals the
 *    current head SHA (works once reviewers have separate GitHub identities), or
 * 2. a review-attestation comment pinned to the current head SHA:
 *        Review-attestation: <reviewer> APPROVE <head-sha>
 *    with at least 12 hex characters of the head SHA. This exists because both
 *    agents currently operate through one GitHub account, and GitHub rejects
 *    formal self-approval. New commits change the head SHA, so stale
 *    attestations and stale native approvals both stop counting.
 *
 * The result is also published as a commit status on the head SHA so runs
 * triggered by comments (which attach to the default branch) stay visible on
 * the PR.
 */

import { pathToFileURL } from "node:url";

// An attestation is a command, not a substring: the entire trimmed comment body
// must be exactly one attestation line. Examples, quoted text, fenced code and
// prose containing the phrase must not count.
const ATTESTATION_LINE = /^Review-attestation:\s*(\S+)\s+APPROVE\s+([0-9a-f]{12,40})$/i;

// Under the shared account the reviewer label is trust-based, but arbitrary
// commenters must not be able to claim it. author_association is
// viewer-dependent — private org membership reads as NONE to the Actions
// token — so the workflow additionally passes an explicit login allowlist
// (TRUSTED_ATTESTORS), which only people with push access can change.
const TRUSTED_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

function isTrustedCommenter(comment, trustedLogins) {
	if (TRUSTED_ASSOCIATIONS.has(comment.author_association)) return true;
	const login = comment.user?.login;
	return typeof login === "string" && trustedLogins.includes(login);
}

export function evaluateReviewGate({ headSha, authorLogin, reviews, comments, trustedLogins = [] }) {
	const head = headSha.toLowerCase();

	const nativeApproval = reviews.find(
		(review) =>
			review.state === "APPROVED" &&
			(review.commit_id ?? "").toLowerCase() === head &&
			review.user?.login &&
			review.user.login !== authorLogin,
	);
	if (nativeApproval) {
		return { approved: true, reason: `approved by ${nativeApproval.user.login} at head` };
	}

	for (const comment of comments) {
		if (!isTrustedCommenter(comment, trustedLogins)) {
			continue;
		}
		const match = (comment.body ?? "").trim().match(ATTESTATION_LINE);
		if (!match) {
			continue;
		}
		const [, reviewer, sha] = match;
		if (head.startsWith(sha.toLowerCase())) {
			return { approved: true, reason: `attested by ${reviewer} at head` };
		}
	}

	return {
		approved: false,
		reason: "no independent approval or review-attestation for the current head commit",
	};
}

async function githubApi(path, { method = "GET", body } = {}) {
	const response = await fetch(`https://api.github.com${path}`, {
		method,
		headers: {
			Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
			Accept: "application/vnd.github+json",
			"User-Agent": "hifi-pi-review-gate",
			...(body ? { "Content-Type": "application/json" } : {}),
		},
		...(body ? { body: JSON.stringify(body) } : {}),
	});
	if (!response.ok) {
		throw new Error(`GitHub API ${method} ${path} failed: ${response.status}`);
	}
	return response.json();
}

async function paginate(path) {
	const results = [];
	for (let page = 1; page <= 10; page++) {
		const items = await githubApi(`${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
		results.push(...items);
		if (items.length < 100) break;
	}
	return results;
}

async function main() {
	const repo = process.env.REPO;
	const prNumber = process.env.PR_NUMBER;
	if (!repo || !prNumber || !process.env.GITHUB_TOKEN) {
		throw new Error("REPO, PR_NUMBER and GITHUB_TOKEN are required");
	}

	const pull = await githubApi(`/repos/${repo}/pulls/${prNumber}`);
	const verdict = evaluateReviewGate({
		headSha: pull.head.sha,
		authorLogin: pull.user.login,
		reviews: await paginate(`/repos/${repo}/pulls/${prNumber}/reviews`),
		comments: await paginate(`/repos/${repo}/issues/${prNumber}/comments`),
		trustedLogins: (process.env.TRUSTED_ATTESTORS ?? "")
			.split(",")
			.map((login) => login.trim())
			.filter((login) => login.length > 0),
	});

	await githubApi(`/repos/${repo}/statuses/${pull.head.sha}`, {
		method: "POST",
		body: {
			state: verdict.approved ? "success" : "failure",
			context: "review-gate/independent-approval",
			description: verdict.reason.slice(0, 140),
		},
	});

	console.log(`Review gate for #${prNumber} @ ${pull.head.sha}: ${verdict.reason}`);
	if (!verdict.approved) {
		console.log(
			"To attest after reviewing, comment: Review-attestation: <reviewer> APPROVE " +
				`${pull.head.sha.slice(0, 12)} (do not merge while this check is red — see issue #53)`,
		);
		process.exit(1);
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch((error) => {
		console.error(error.message);
		process.exit(1);
	});
}
