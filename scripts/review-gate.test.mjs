import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluateReviewGate } from "./review-gate.mjs";

const HEAD = "abcdef0123456789abcdef0123456789abcdef01";

function gate(overrides) {
	return evaluateReviewGate({
		headSha: HEAD,
		authorLogin: "author",
		reviews: [],
		comments: [],
		...overrides,
	});
}

function attestation(body, association = "MEMBER") {
	return { body, author_association: association };
}

test("no reviews or comments stays red", () => {
	assert.equal(gate({}).approved, false);
});

test("native approval at the current head from a non-author passes", () => {
	const result = gate({
		reviews: [{ state: "APPROVED", commit_id: HEAD, user: { login: "reviewer" } }],
	});
	assert.equal(result.approved, true);
});

test("approval before a new commit stops counting", () => {
	const result = gate({
		reviews: [{ state: "APPROVED", commit_id: "0123456789abcdef0123456789abcdef01234567", user: { login: "reviewer" } }],
	});
	assert.equal(result.approved, false);
});

test("self-approval does not pass even at head", () => {
	const result = gate({
		reviews: [{ state: "APPROVED", commit_id: HEAD, user: { login: "author" } }],
	});
	assert.equal(result.approved, false);
});

test("exact standalone attestation from a trusted association passes", () => {
	const result = gate({
		comments: [attestation(`Review-attestation: codex APPROVE ${HEAD.slice(0, 12)}`)],
	});
	assert.equal(result.approved, true);
});

test("attestation surrounded by whitespace still counts as exact", () => {
	const result = gate({
		comments: [attestation(`\n  Review-attestation: codex APPROVE ${HEAD.slice(0, 12)}\n`)],
	});
	assert.equal(result.approved, true);
});

test("attestation quoted inside prose does not pass (review-request false positive)", () => {
	const body = [
		"Both blockers addressed — re-review requested.",
		"",
		`This PR's current head is \`${HEAD}\`. If the revised design is acceptable, attest with:`,
		"",
		`\`Review-attestation: codex APPROVE ${HEAD.slice(0, 12)}\``,
	].join("\n");
	const result = gate({ comments: [attestation(body)] });
	assert.equal(result.approved, false);
});

test("attestation inside a fenced code block does not pass", () => {
	const body = `\`\`\`\nReview-attestation: codex APPROVE ${HEAD.slice(0, 12)}\n\`\`\``;
	const result = gate({ comments: [attestation(body)] });
	assert.equal(result.approved, false);
});

test("allowlisted login passes even when association reads as NONE (viewer-dependent)", () => {
	// Private org membership is invisible to the Actions token, so a genuine
	// member can surface as NONE; the explicit login allowlist must still work.
	const result = gate({
		comments: [
			{
				body: `Review-attestation: codex APPROVE ${HEAD.slice(0, 12)}`,
				author_association: "NONE",
				user: { login: "Eastsidegunn" },
			},
		],
		trustedLogins: ["Eastsidegunn"],
	});
	assert.equal(result.approved, true);
});

test("non-allowlisted NONE commenter stays red even with a perfect attestation", () => {
	const result = gate({
		comments: [
			{
				body: `Review-attestation: codex APPROVE ${HEAD.slice(0, 12)}`,
				author_association: "NONE",
				user: { login: "drive-by" },
			},
		],
		trustedLogins: ["Eastsidegunn"],
	});
	assert.equal(result.approved, false);
});

test("attestation from an untrusted commenter does not pass", () => {
	for (const association of ["NONE", "CONTRIBUTOR", "FIRST_TIME_CONTRIBUTOR", undefined]) {
		const result = gate({
			comments: [{ body: `Review-attestation: codex APPROVE ${HEAD.slice(0, 12)}`, author_association: association }],
		});
		assert.equal(result.approved, false, `association ${association} must not pass`);
	}
});

test("removing the attestation returns the gate to red", () => {
	const comment = attestation(`Review-attestation: codex APPROVE ${HEAD.slice(0, 12)}`);
	assert.equal(gate({ comments: [comment] }).approved, true);
	assert.equal(gate({ comments: [] }).approved, false);
});

test("attestation for a superseded commit stops counting", () => {
	const result = gate({
		comments: [attestation("Review-attestation: codex APPROVE ffffffffffff")],
	});
	assert.equal(result.approved, false);
});

test("attestation shorter than 12 hex characters is ignored", () => {
	const result = gate({
		comments: [attestation(`Review-attestation: codex APPROVE ${HEAD.slice(0, 8)}`)],
	});
	assert.equal(result.approved, false);
});

test("attestation matching is case-insensitive", () => {
	const result = gate({
		comments: [attestation(`review-attestation: codex approve ${HEAD.toUpperCase()}`)],
	});
	assert.equal(result.approved, true);
});
