import { describe, expect, it } from "vitest";
import { decideConversationFollow } from "../src/components/conversation-follow-state.js";

describe("conversation follow state", () => {
	it("disables follow only after an upward read beyond 96px from the latest content", () => {
		expect(
			decideConversationFollow({
				following: true,
				previousScrollTop: 500,
				scrollTop: 480,
				distanceFromBottom: 96,
			}),
		).toBe(true);
		expect(
			decideConversationFollow({
				following: true,
				previousScrollTop: 500,
				scrollTop: 480,
				distanceFromBottom: 97,
			}),
		).toBe(false);
		expect(
			decideConversationFollow({
				following: true,
				previousScrollTop: 500,
				scrollTop: 500,
				distanceFromBottom: 200,
			}),
		).toBe(true);
	});

	it("restores follow within 24px and otherwise preserves the current decision", () => {
		expect(
			decideConversationFollow({
				following: false,
				previousScrollTop: 480,
				scrollTop: 600,
				distanceFromBottom: 24,
			}),
		).toBe(true);
		expect(
			decideConversationFollow({
				following: false,
				previousScrollTop: 480,
				scrollTop: 600,
				distanceFromBottom: 25,
			}),
		).toBe(false);
	});
});
