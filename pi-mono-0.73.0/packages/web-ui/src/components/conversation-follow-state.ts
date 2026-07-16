export const CONVERSATION_FOLLOW_DISABLE_DISTANCE = 96;
export const CONVERSATION_FOLLOW_ENABLE_DISTANCE = 24;

export interface ConversationFollowDecisionInput {
	following: boolean;
	previousScrollTop: number;
	scrollTop: number;
	distanceFromBottom: number;
}

export function decideConversationFollow(input: ConversationFollowDecisionInput): boolean {
	if (input.distanceFromBottom <= CONVERSATION_FOLLOW_ENABLE_DISTANCE) return true;
	if (
		input.following &&
		input.scrollTop < input.previousScrollTop &&
		input.distanceFromBottom > CONVERSATION_FOLLOW_DISABLE_DISTANCE
	) {
		return false;
	}
	return input.following;
}
