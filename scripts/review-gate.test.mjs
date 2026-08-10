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

test("attestation comment pinned to the current head passes", () => {
	const result = gate({
		comments: [{ body: `Looks correct.\n\nReview-attestation: codex APPROVE ${HEAD.slice(0, 12)}` }],
	});
	assert.equal(result.approved, true);
});

test("attestation for a superseded commit stops counting", () => {
	const result = gate({
		comments: [{ body: "Review-attestation: codex APPROVE ffffffffffff" }],
	});
	assert.equal(result.approved, false);
});

test("attestation shorter than 12 hex characters is ignored", () => {
	const result = gate({
		comments: [{ body: `Review-attestation: codex APPROVE ${HEAD.slice(0, 8)}` }],
	});
	assert.equal(result.approved, false);
});

test("attestation matching is case-insensitive", () => {
	const result = gate({
		comments: [{ body: `review-attestation: codex approve ${HEAD.toUpperCase()}` }],
	});
	assert.equal(result.approved, true);
});
