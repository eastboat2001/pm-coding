import { getCurrentLanguage, type MessageRenderer, registerMessageRenderer } from "@mariozechner/pi-web-ui";
import { html } from "lit";
import { type AgentV2ActivityMessage, agentV2ActivityView } from "./agent-v2-activity-message.js";

let registered = false;

export function registerAgentV2ActivityMessageRenderer(): void {
	if (registered) return;
	registered = true;
	registerMessageRenderer("agent-v2-activity", new AgentV2ActivityMessageRenderer());
}

class AgentV2ActivityMessageRenderer implements MessageRenderer<AgentV2ActivityMessage> {
	render(message: AgentV2ActivityMessage) {
		const view = agentV2ActivityView(message.activity, getCurrentLanguage());
		return html`
			<div class="agent-v2-activity-card" data-activity-id=${message.id}>
				<details ?open=${view.open}>
					<summary>
						<span class="agent-v2-activity-card__dot agent-v2-activity-card__dot--${view.tone}"></span>
						<span class="agent-v2-activity-card__title">${view.title}</span>
						<span class="agent-v2-activity-card__summary">${view.summary}</span>
					</summary>
					<div class="agent-v2-activity-card__details">
						${view.rows.map((row) => html`<div><span>${row.label}</span><code>${row.value}</code></div>`)}
					</div>
				</details>
			</div>
		`;
	}
}
